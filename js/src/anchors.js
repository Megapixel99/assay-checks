/**
 * Every mutation anchor must match its target EXACTLY ONCE.
 *
 * WHY THE RULE EXISTS. A mutation harness typically applies `src.replace(old, new)`,
 * so the anchor string it carries has to identify one place in one file. An anchor
 * matching:
 *
 *   * ZERO places — the code moved out from under it. Loud if the harness checks
 *     (TARGET MISSING) and silently inert if it does not, which means a guard nobody
 *     is testing any more, reported as a passing suite.
 *
 *   * MORE THAN ONE — `replace` without a count takes every occurrence and
 *     `replace(old, new)` on a plain string takes the FIRST, which may not be the one
 *     you meant. The harness then mutates something nothing asserts and reports NOT
 *     DETECTED. That reads as *your guard is untested* when the truth is *your
 *     mutation tested something else*, and those two send you to opposite ends of the
 *     codebase.
 *
 * BY IMPORT, NOT BY PARSE, and that is the whole design of this file. The Python half
 * lifts the table out with `ast` and executes nothing. JavaScript has no parser in its
 * standard library and this package has no dependencies, so for a long time the honest
 * answer here was a gap: a regex cannot tell a label from an anchor, and a check
 * reporting confident nonsense about which strings are anchors is worse than no check.
 *
 * But the JavaScript half already loads modules. A table that is EXPORTED —
 * `export const MUTATIONS = [...]` — is readable as DATA: a property access, with no
 * parser, no dependency and no approximation anywhere in the path. What it costs is
 * that the harness gets imported; what it buys is that a computed anchor, which the
 * Python half can only report as unreadable, is here simply a string.
 *
 * A HARNESS THAT EXPORTS NO TABLE IS A `look`, never a finding. It has not opted into
 * being read this way, and inventing a reading of it is the thing this file exists not
 * to do.
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRunners, RUNNER_PREFIX } from './checks.js';
import { ANSWER_FD } from './sameness.js';
import { Report } from './verdicts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Long enough for a module to evaluate, short enough that a wedged import is not a hang. */
export const TABLE_TIMEOUT_MS = 15000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor',
  '__pycache__', 'venv', '.venv',
]);

/** The corpus an anchor may point into: source, in either language. */
const SOURCE = /\.(py|js|mjs|cjs)$/;

/**
 * The anchor of each entry, and the labels of entries this cannot read.
 *
 * THE ANCHOR IS THE SECOND-TO-LAST STRING, which is a consequence of `replace(old,
 * new)` rather than a guess about column order: whatever else an entry carries — a
 * label, a target file — `old` and `new` are adjacent and in that order, because that
 * is the call they feed. Both documented shapes fall out of it, `[label, old, new]`
 * and `[label, target, old, new]`, without knowing which one is in front of it.
 *
 * AN ENTRY WITH MORE STRINGS THAN EITHER SHAPE IS OFFERED, NOT GUESSED. The Python
 * half learned this the expensive way: an earlier version took every string long
 * enough to look like code and let the occurrence count decide which was the anchor,
 * so roughly half of what it counted were labels that match nothing by construction —
 * and one genuinely dead anchor sat invisible among them. Counting the wrong things
 * precisely is worse than counting fewer things.
 */
export function anchorsOf(table) {
  const found = [];
  const unreadable = [];
  for (const parts of table) {
    if (parts.length >= 2 && parts.length <= 4) found.push(parts[parts.length - 2]);
    else if (parts.length > 4) unreadable.push(parts[0]);
  }
  return { found, unreadable };
}

/**
 * The exported mutation table of one harness, read in a child process.
 *
 * `{ table }` when it was read, `{ absent: true }` when the harness exports none, and
 * `{ error }` when the module would not import. The three are kept apart because they
 * are three different things to do next, and collapsing any two would report a harness
 * this audit could not read as a harness with nothing in it.
 */
export function readTable(file, timeout = TABLE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const worker = path.join(HERE, 'anchor-probe.js');
    // FOUR pipes, and the fourth is the point: importing a module runs whatever it does
    // at import time, and ordinary code announces itself on stdout. An answer sharing a
    // channel with a banner is an answer the banner destroys.
    const child = spawn(process.execPath, [worker],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let answer = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdio[ANSWER_FD].on('data', (d) => { answer += d; });
    child.stdout.on('data', () => { /* the harness's own output, deliberately dropped */ });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const line = answer.split('\n').find((l) => l.trim());
      if (!line) {
        const said = (err.trim().split('\n').pop() || 'silent').slice(0, 70);
        resolve({ error: `the table could not be read (${said})` });
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch {
        // A child killed mid-write leaves half an object. Repairing it would be
        // inventing an answer, which is the one thing worse than not having one.
        resolve({ error: 'the table came back truncated' });
      }
    });
    child.stdin.end(JSON.stringify({ file }));
  });
}

/**
 * Every source file under root, as absolute paths.
 *
 * Both languages, because an anchor points at the code under test and a polyglot
 * repository's harnesses point at both halves of it.
 */
export function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Every mutation harness under root, IN EITHER LANGUAGE, as absolute real paths.
 *
 * NO HARNESS IS PART OF THE CORPUS, and this is the whole rule rather than an
 * optimisation. A harness's source contains its own anchors as string literals, so
 * counting them there makes every anchor "match twice" and the audit reports problems
 * that are all itself. Excluding only the DECLARING harness is not enough either: one
 * harness's REPLACEMENT text routinely appears in another's.
 *
 * BOTH LANGUAGES, and that is the part a single-language audit gets wrong. A polyglot
 * repository has a `mutations_x.py` beside a `mutations-y.js`; each half only knows how
 * to READ its own, but both must be kept OUT OF THE CORPUS, or one half's anchors are
 * counted inside the other half's harness and a confident finding is reported about a
 * file it has nothing to do with.
 */
export function harnessPaths(root) {
  const out = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.startsWith(RUNNER_PREFIX) && SOURCE.test(name)) {
        out.add(realpathSync(full));
      }
    }
  };
  walk(root);
  return out;
}

/** Count every anchor's occurrences PER FILE and fail on one that matches twice. */
export async function auditAnchors(root, config, report = new Report()) {
  const runners = findRunners(root);
  if (!runners.length) {
    report.note(`ANCHORS — no mutation runners found under ${root}`);
    return report;
  }
  const skip = harnessPaths(root);
  const corpus = [];
  for (const file of sourceFiles(root)) {
    let real;
    try {
      real = realpathSync(file);
    } catch {
      continue;
    }
    if (skip.has(real)) continue;
    try {
      corpus.push(readFileSync(file, 'utf8'));
    } catch {
      // Unreadable or not UTF-8. Skipped rather than counted: a file this cannot read
      // holds an unknown number of occurrences, and guessing at zero is a guess.
    }
  }

  report.note('ANCHORS — every anchor must match exactly once in some file\n');
  let total = 0;
  for (const rel of runners) {
    if (config.anchorExempt.has(rel)) {
      report.note(`  exempt   ${rel.padEnd(46)} ${config.anchorExempt.get(rel).slice(0, 60)}`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await readTable(path.join(root, rel));
    if (result.error) {
      report.look(`${rel}: ${result.error}`, rel,
        'the table was not read, so nothing here is a claim about its anchors');
      continue;
    }
    if (result.absent) {
      report.look(`${rel} exports no MUTATIONS table`, rel,
        'this half reads the table as DATA rather than parsing source, so a harness '
        + 'opts in with `export const MUTATIONS = [...]` — a regex that guessed which '
        + 'strings were anchors would report confident nonsense');
      continue;
    }
    const { found, unreadable } = anchorsOf(result.table);
    const ambiguous = [];
    const dead = [];
    for (const anchor of found) {
      total += 1;
      // PER FILE, not in total: the same anchor legitimately appearing once in two
      // different files is not ambiguous for a harness that names its target, and
      // calling it so would be the crying-wolf failure.
      let worst = 0;
      for (const src of corpus) {
        let hits = 0;
        let at = src.indexOf(anchor);
        while (at !== -1 && anchor) { hits += 1; at = src.indexOf(anchor, at + anchor.length); }
        if (hits > worst) worst = hits;
      }
      if (worst === 0) dead.push(anchor);
      else if (worst > 1) ambiguous.push([anchor, worst]);
    }
    for (const [anchor, hits] of ambiguous) {
      report.finding(`${rel}: an anchor matches ${hits} times in ONE file — `
        + `\`replace\` will take the first: ${JSON.stringify(anchor.slice(0, 60))}`, rel);
    }
    // ZERO MATCHES IS A FINDING. An anchor matching nothing means the code moved out
    // from under it: loud if the harness checks its target and SILENTLY INERT if it
    // does not, which is a guard nobody is testing any more inside a suite that still
    // reports a pass.
    for (const anchor of dead) {
      report.finding(`${rel}: an anchor matches NOTHING — the code moved out from `
        + 'under it, so its mutation tests a guard that is no longer there: '
        + `${JSON.stringify(anchor.slice(0, 60))}`, rel);
    }
    for (const label of unreadable) {
      report.look(`${rel}: cannot tell which column is the anchor in `
        + `${JSON.stringify(label.slice(0, 50))} — more strings than either documented `
        + 'table shape', rel);
    }
    if (!ambiguous.length && !dead.length) {
      report.ok(`${rel.padEnd(46)} ${found.length} anchors, each matching exactly once`,
        rel);
    }
  }
  report.note(`\n  ${total} anchors checked across ${runners.length} runners`);
  return report;
}
