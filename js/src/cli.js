#!/usr/bin/env node
/**
 * assay — one command for two questions ordinary CI does not answer.
 *
 *     could those checks have failed?      assay runners | anchors | diff | all
 *     does the tree already answer this?   assay scan | pair | search
 *     why was my function not probed?      assay why FILE::NAME
 *     ...and does the OTHER half answer it?  assay probe FILE::NAME | assay cross A B
 *     I have read this one and accept it   assay accept --reason "..." [LINE]
 *
 * EXIT CODES, identical for every subcommand, because scripts depend on them more than
 * on anything printed:
 *
 *     0   the tool ran and there is nothing to read
 *     1   at least one FINDING
 *     2   the tool could not run
 *
 * `look` items never affect the exit code. That is the whole reason they exist as a
 * separate verdict: a check that reports things a person then has to dismiss stops
 * being read, and an unread check occupies the place where a working one would go.
 *
 * `anchors` READS THE TABLE AS DATA rather than parsing source, which is the one thing
 * this half can do that the Python half cannot. Python lifts the table out with `ast`
 * and executes nothing; there is no parser in the JavaScript standard library and this
 * package has no dependencies, so the alternative here was a regex — and a regex cannot
 * tell a label from an anchor, so it would report confident nonsense. A harness opts in
 * by EXPORTING its table (`export const MUTATIONS = [...]`), which makes reading it a
 * property access with no approximation anywhere in the path. One that exports none is
 * a `look`, never a finding: it has not opted in, and inventing a reading of it is the
 * thing this deliberately does not do.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { auditAnchors } from './anchors.js';
import { auditDiff, auditRunners, checkExemptions } from './checks.js';
import {
  applyBaseline, CONFIG_NAMES, ConfigError, load, writeBaseline,
} from './config.js';
import {
  collect, compare, compareCross, crossKey, crossLadder, discriminating,
  discriminationDetail, displayPath, fileRefusal, group, jsFiles, ladder, ladderKey,
  probeFile, PROBE_SCHEMA, reportScan, Scan, SNIPPET_PATH, stripNonCode,
} from './sameness.js';
import { relativeSpecifiers } from './probe.js';
import { FINDING, Report, render } from './verdicts.js';

const USAGE = `usage: assay [--root DIR] [--config FILE] [-q] <command>

  runners                     audit mutation runners against seven properties
  anchors                     every mutation anchor matches exactly once
  diff [--base REF]           does this change carry the checks it needs?
  all  [--base REF]           runners + anchors + diff
       [--scan PATH...]       ...and the sameness half over these paths
  accept [LINE] --reason R    write a finding into the baseline, with a reason
  scan PATH...                discover functions that answer the same question
  pair FILE::NAME FILE::NAME  compare two named functions
  search FILE::NAME --in DIR  does the tree already answer this?
         --stdin [--name N]   ...about a function that is not a file yet
  why FILE::NAME              which gate refused this function, or that it was probed
  probe FILE::NAME            one function's cross-language vector, as JSON on stdout
  cross A B [--with CMD]      compare a JavaScript function to a Python one

exit: 0 nothing to read, 1 findings, 2 could not run
`;

/**
 * Flags are accepted on BOTH sides of the subcommand, because that is how people type
 * them. A parser that only accepts `assay -q scan src` and rejects `assay scan src -q`
 * is one people work around rather than learn.
 */
export function parseArgs(argv) {
  const opts = {
    root: '.', config: null, quiet: false, base: 'origin/main',
    cmd: null, positional: [], into: [], scan: [], stdin: false, name: null,
    reason: null, withCmd: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-q' || arg === '--quiet') opts.quiet = true;
    else if (arg === '--stdin') opts.stdin = true;
    else if (arg === '--root') { i += 1; opts.root = argv[i]; }
    else if (arg === '--config') { i += 1; opts.config = argv[i]; }
    else if (arg === '--base') { i += 1; opts.base = argv[i]; }
    else if (arg === '--reason') { i += 1; opts.reason = argv[i]; }
    else if (arg === '--with') { i += 1; opts.withCmd = argv[i]; }
    else if (arg === '--name') { i += 1; opts.name = argv[i]; }
    else if (arg === '--in' || arg === '--scan') {
      const target = arg === '--in' ? opts.into : opts.scan;
      i += 1;
      while (i < argv.length && !argv[i].startsWith('-')) { target.push(argv[i]); i += 1; }
      i -= 1;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--version') opts.version = true;
    else rest.push(arg);
  }
  [opts.cmd, ...opts.positional] = rest;
  return opts;
}

/**
 * Apply the baseline, render, and return the exit code.
 *
 * STALE DETECTION NEEDS A COMPLETE RUN, and getting this wrong made the tool cry wolf
 * at itself. A baseline line records a finding you have read and accepted; it goes
 * stale when it stops firing. But `runners` cannot produce a finding that only `diff`
 * reports, so checking staleness there flags every `diff` line as fixed — the audit
 * reporting a problem with its own config, on a clean tree, every run.
 *
 * So a line that does not fire is only called stale when the run performed EVERY audit
 * that can produce one, which is `assay all`. Every command still suppresses accepted
 * findings, because that direction is safe from any command: a line that fires is a
 * line that fires.
 *
 * `performed` is what this run actually audited, so a baseline entry that names the
 * command firing it can be answered by that command alone. Everything else is COUNTED
 * as not checked rather than silently treated as fresh.
 *
 * THIS HALF USED TO BE UNABLE TO HAVE A COMPLETE RUN AT ALL, because `anchors` was
 * Python-only, and it said so rather than printing `0 stale`. It now reads a mutation
 * table by importing it, so `assay all` here performs every audit.
 */
function baselineSummary(accepted, still, stale, unchecked) {
  const parts = [`${accepted} accepted`, `${still.length} new`, `${stale.length} stale`];
  if (unchecked.length) {
    const why = new Map();
    for (const entry of unchecked) {
      const key = entry.producedBy || 'no `from`, so it needs `assay all`';
      why.set(key, (why.get(key) || 0) + 1);
    }
    const named = [...why.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, n]) => `${k}: ${n}`).join('; ');
    parts.push(`${unchecked.length} NOT checked for staleness (${named})`);
  }
  return parts.join(', ');
}

function finish(report, config, write, verbose, performed = []) {
  if (config.baseline.length) {
    const [still, stale, unchecked] = applyBaseline(report.findings, config.baseline,
      performed);
    const accepted = report.findings.length - still.length;
    report.items = report.items.filter((i) => i.verdict !== FINDING).concat(still);
    for (const entry of stale) {
      report.finding('baseline line no longer fires (fixed? then delete it): '
        + `${entry.line}`);
    }
    if (verbose) {
      write(`\nBASELINE ${config.path} — `
        + `${baselineSummary(accepted, still, stale, unchecked)}\n`);
    }
  }
  if (verbose) write(`\n${'-'.repeat(72)}\n`);
  return render(report, write, { verbose });
}

/**
 * One function of a `file.js::name` reference.
 *
 * `{ entry, display }` when it probed, `{ unresolved }` when the reference names
 * nothing, `{ display, unprobed }` when it names a real function this tool may not
 * execute. THE THIRD CASE IS NOT THE SECOND, and collapsing them is how exit 2 starts
 * meaning "found nothing". A function that exists and is refused — async, impure, the
 * wrong arity — is a `look`: the tool ran and cannot decide. Only a reference that
 * resolves to nothing is "the tool could not run". The Python half splits these the
 * same way, and its exit codes are the contract both halves publish.
 *
 * `display` is the reference renamed the way a scan names it, so `search` can exclude
 * the query itself by IDENTITY rather than by matching a name.
 */
async function probeRef(ref) {
  const split = ref.lastIndexOf('::');
  if (split < 0) return { unresolved: `not a FILE::NAME reference: ${ref}` };
  const file = path.resolve(ref.slice(0, split));
  const name = ref.slice(split + 2);
  const display = `${displayPath(file)}::${name}`;
  const result = await probeFile(file);
  if (result.error) return { unresolved: result.error };
  const entry = (result.functions || []).find((f) => f.name === name);
  if (!entry) return { unresolved: `${file} exports no function named ${name}` };
  if (entry.skip) return { display, unprobed: entry.skip };
  return { entry, display };
}

/**
 * The census, for one name: which gate refused THIS function.
 *
 * `assay scan` prints refusal reasons with counts, which is the right shape for a tree
 * and the wrong shape for a question. Somebody who expected a particular function to be
 * probed cannot read `no arguments 274` and learn whether theirs is one of the 274.
 *
 * THE FILE GATE IS CHECKED FIRST, and on this half that is usually the answer. Python
 * lifts one function's source out and never imports the module; here a function object
 * only exists once its module has been evaluated, so a file that reaches for the clock
 * or the filesystem is refused WHOLE and none of its functions were ever looked at.
 * Reporting a per-function reason for a file nobody opened would be a reason invented
 * after the fact.
 */
async function whyRef(ref, report) {
  const split = ref.lastIndexOf('::');
  if (split < 0) return { unresolved: `not a FILE::NAME reference: ${ref}` };
  const file = path.resolve(ref.slice(0, split));
  const name = ref.slice(split + 2);
  const display = `${displayPath(file)}::${name}`;
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return { unresolved: `cannot read ${file}` };
  }
  const refused = fileRefusal(source);
  if (refused) {
    report.look(`${display} — the FILE was refused: ${refused}`, display,
      'the module was never loaded, so no function in it was looked at — this is a '
      + 'file-level answer and every other function here has the same one');
    return { answered: true };
  }
  const result = await probeFile(file, undefined, source);
  if (result.error) return { unresolved: result.error };
  const entry = (result.functions || []).find((f) => f.name === name);
  if (!entry) {
    const roster = (result.functions || []).map((f) => f.name).sort();
    return {
      unresolved: `${displayPath(file)} EXPORTS no function named ${name} (it exports: `
        + `${roster.join(', ') || 'nothing'}). Only exported functions reach the probe: `
        + 'a module\'s functions arrive through its exports, and finding an unexported '
        + 'declaration would mean reading source with a regex',
    };
  }
  if (entry.skip) {
    report.look(`${display} — ${entry.skip}`, display,
      'refused before the ladder, so it is in no bucket and can pair with nothing');
    return { answered: true };
  }
  const inputs = ladder(entry.arity);
  const detail = discriminationDetail(entry.vector, inputs);
  if (detail !== null) {
    report.look(`${display} — not discriminated by the ladder`, display, detail);
    return { answered: true };
  }
  const { returned, distinct } = discriminating(entry.vector, inputs);
  report.ok(`${display} — probed on ${ladderKey(entry.arity)}: ${returned} of `
    + `${entry.vector.length} rungs answered, ${distinct} distinct value(s)`, display);
  return { answered: true };
}

/**
 * Every audit, folded into `report`. Returns `{ families, performed }`.
 *
 * ONE PLACE KNOWS WHAT A COMPLETE RUN IS, and `accept` is why it has to be one. `all`
 * needs the list to say whether it may call a line stale; `accept` needs it to write
 * `from` on the entries it adds. Two lists that had to agree about what "every audit"
 * means would be the exact duplication this package exists to find, and the way they
 * would disagree is silent: `accept` would tag a line with a command `all` no longer
 * performs, and that line could then never be called stale.
 *
 * `--scan PATH` folds the sameness half in. WITHOUT IT THE RUN DID NOT PERFORM THAT
 * HALF, and saying otherwise is how a `same answer` line gets called stale on a clean
 * tree — so `scan` joins the performed set only when a scan actually ran.
 */
async function auditEverything(root, opts, config, report) {
  const families = new Map();
  const performed = [];
  // A SEPARATE REPORT PER AUDIT, so a finding can be attributed to the audit that
  // produced it. Reading it back off the shared report afterwards would mean guessing
  // from the message text, which is a parser of our own output.
  const perform = async (name, audit) => {
    const sub = new Report();
    await audit(sub);
    for (const item of sub.findings) {
      if (!families.has(item.message)) families.set(item.message, name);
    }
    report.extend(sub);
    performed.push(name);
  };
  await perform('runners', (rep) => {
    auditRunners(root, config, rep);
    checkExemptions(root, config, rep);
  });
  await perform('anchors', (rep) => auditAnchors(root, config, rep));
  await perform('diff', (rep) => auditDiff(root, opts.base, config, rep));
  if (opts.scan.length) {
    await perform('scan', async (rep) => {
      const scan = await collect(opts.scan);
      group(scan);
      reportScan(scan, rep);
    });
  }
  return { families, performed };
}

// The suffix decides which half a reference belongs to. Inferred rather than declared,
// because a flag naming both a file and a language can disagree with itself and the
// suffix is the fact.
const LANGUAGE_OF = {
  '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
};

/** 'python' | 'javascript' | null, from a FILE::NAME reference's suffix. */
export function languageOf(ref) {
  const split = ref.lastIndexOf('::');
  const file = split < 0 ? ref : ref.slice(0, split);
  return LANGUAGE_OF[path.extname(file)] || null;
}

const CROSS_TIMEOUT_MS = 120000;

/**
 * The same object with its keys in sorted order, all the way down.
 *
 * `JSON.stringify` emits insertion order and Python's `json.dump` is asked to sort, so
 * without this the two halves write the same record as two different documents — and a
 * record is the one artefact that crosses between them.
 */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedKeys(value[key]);
  return out;
}

/**
 * One function's CROSS record: `{ record }` or `{ unresolved }`.
 *
 * A refusal is a record with `look` instead of `vector` rather than an error: the
 * reference resolved and the tool ran, so this is not exit 2 — and a consumer gets one
 * shape either way.
 */
async function crossRecord(ref) {
  const split = ref.lastIndexOf('::');
  if (split < 0) return { unresolved: `not a FILE::NAME reference: ${ref}` };
  const file = path.resolve(ref.slice(0, split));
  const name = ref.slice(split + 2);
  const display = `${displayPath(file)}::${name}`;
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return { unresolved: `cannot read ${file}` };
  }
  const record = { assay_probe: PROBE_SCHEMA, ref: display, language: 'javascript' };
  const refused = fileRefusal(source);
  if (refused) return { record: { ...record, arity: 0, look: `the FILE was refused: ${refused}` } };
  const result = await probeFile(file, undefined, source, true);
  if (result.error) return { unresolved: result.error };
  const entry = (result.functions || []).find((f) => f.name === name);
  if (!entry) return { unresolved: `${displayPath(file)} exports no function named ${name}` };
  if (entry.skip) return { record: { ...record, arity: 0, look: entry.skip } };
  return {
    record: {
      ...record, arity: entry.arity, ladder: crossKey(entry.arity), vector: entry.vector,
    },
  };
}

/**
 * An `assay probe` record from a file: `{ record }` or `{ unresolved }`.
 *
 * THE SCHEMA IS CHECKED. A record from a version that meant something else by `vector`
 * would be compared anyway, and comparing a new answer against the wrong earlier
 * answer is precisely the defect a difference checker exists to catch.
 */
function readRecord(file) {
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { unresolved: `cannot read ${file} as an \`assay probe\` record (${err.message})` };
  }
  if (typeof record !== 'object' || record === null || !('assay_probe' in record)) {
    return { unresolved: `${file} is not an \`assay probe\` record` };
  }
  if (record.assay_probe !== PROBE_SCHEMA) {
    return {
      unresolved: `${file} was written by schema ${record.assay_probe} and this is `
        + `schema ${PROBE_SCHEMA} — the two do not mean the same thing by \`vector\``,
    };
  }
  return { record };
}

/**
 * One side of a cross comparison.
 *
 * THREE WAYS IN, and the third exists because the first two are not always enough. A
 * `.json` path is a record somebody already produced. A JavaScript reference is probed
 * here. A reference in the OTHER language needs the other binary, and `--with CMD` is
 * how you say where it is — without it this refuses and says exactly what to run,
 * rather than guessing at a command name that is `assay` for both packages.
 */
async function crossSide(ref, withCmd) {
  if (ref.endsWith('.json') && existsSync(ref)) return readRecord(ref);
  const language = languageOf(ref);
  if (language === 'javascript') return crossRecord(ref);
  if (language === null) {
    return {
      unresolved: `${ref} names no language this understands — a reference is `
        + 'FILE::NAME and the suffix says which half',
    };
  }
  if (!withCmd) {
    return {
      unresolved: `${ref} is a Python reference and this is the JavaScript half.\n`
        + `       Run \`assay probe ${ref} > side.json\` with the Python binary and `
        + 'pass\n       side.json here, or give --with CMD so this can run it for you.',
    };
  }
  const parts = withCmd.split(/\s+/).filter(Boolean);
  let stdout;
  try {
    stdout = execFileSync(parts[0], [...parts.slice(1), 'probe', ref],
      { encoding: 'utf8', timeout: CROSS_TIMEOUT_MS });
  } catch (err) {
    return { unresolved: `--with '${withCmd}' could not run (${err.message})` };
  }
  let record;
  try {
    record = JSON.parse(stdout);
  } catch {
    return { unresolved: `--with '${withCmd}' did not print an \`assay probe\` record` };
  }
  if (record.assay_probe !== PROBE_SCHEMA) {
    return {
      unresolved: `--with '${withCmd}' wrote schema ${record.assay_probe} and this is `
        + `schema ${PROBE_SCHEMA}`,
    };
  }
  return { record };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * One function of a snippet that is not a file yet, read from stdin.
 *
 * SEARCH BEFORE YOU GENERATE cannot mean "first write the file", which is what a
 * FILE::NAME-only command asks for. The same three shapes come back as `probeRef`
 * returns — probed, unresolved, or a real function this tool may not execute — and
 * they stay three for the same reason: a refused function is a `look`, and only a
 * query this tool cannot make sense of at all is exit 2.
 *
 * A SNIPPET MAY NOT IMPORT FROM THE TREE, and that is a limit rather than an
 * oversight. A module has to be on disk to be imported, so the snippet is written to a
 * temp file; outside the root its relative imports resolve to nothing, and inside the
 * root it would be scratch state beside the code under test, which is the thing
 * `no-tree-writes` audits harnesses for. A snippet that already imports half the tree
 * is a file, so point this at the file.
 */
async function probeStdin(text, wanted) {
  // Named only when the caller named it: the module has not been loaded at this point,
  // so a snippet refused by the file gate has no roster and therefore no name. A
  // placeholder name would be a name this tool made up.
  const unnamed = wanted ? `${SNIPPET_PATH}::${wanted}` : SNIPPET_PATH;
  const why = fileRefusal(text);
  if (why) return { display: unnamed, unprobed: why };
  if (relativeSpecifiers(text).length) {
    return {
      display: unnamed,
      unprobed: 'the snippet imports from the tree — point search at the file instead',
    };
  }
  // A snippet with no `export` puts its functions nowhere the module system can reach,
  // and finding them anyway would mean reading declarations out of source with a
  // regex. `--name` is asked for instead: the user knows the name, and guessing at it
  // is how a tool starts reporting confident nonsense about code it never parsed.
  const stripped = stripNonCode(text, true);
  let source = text;
  if (stripped === null || !/(^|\n)\s*export[\s{]/.test(stripped)) {
    if (!wanted) {
      return {
        unresolved: 'the snippet exports nothing, so name the function with --name '
          + '(or add `export` to it)',
      };
    }
    if (!IDENTIFIER.test(wanted)) {
      return { unresolved: `not a function name: ${wanted}` };
    }
    source = `${text}\nexport { ${wanted} };\n`;
  }
  const file = path.join(tmpdir(), `assay-stdin-${process.pid}-${Date.now()}.mjs`);
  let result;
  try {
    writeFileSync(file, source);
    result = await probeFile(file, undefined, source);
  } finally {
    try { unlinkSync(file); } catch { /* the probe may have been killed mid-write */ }
  }
  if (result.error) return { unresolved: result.error };
  const roster = result.functions || [];
  if (!roster.length) return { unresolved: 'the snippet defines no top-level function' };
  let entry;
  if (wanted) {
    entry = roster.find((f) => f.name === wanted);
    if (!entry) {
      return {
        unresolved: `the snippet defines no function named ${wanted} (it defines `
          + `${roster.map((f) => f.name).sort().join(', ')})`,
      };
    }
  } else if (roster.length > 1) {
    // NEVER GUESSED. Picking one would make the tool answer about code nobody asked
    // about, which reads exactly like an answer about the code they did ask about.
    return {
      unresolved: `the snippet defines ${roster.length} functions `
        + `(${roster.map((f) => f.name).sort().join(', ')}) — name one with --name`,
    };
  } else {
    [entry] = roster;
  }
  const display = `${SNIPPET_PATH}::${entry.name}`;
  if (entry.skip) return { display, unprobed: entry.skip };
  return { entry, display };
}

/**
 * `readStdin` is injected for the same reason `write` is: a CLI whose only interface
 * is the process it runs in cannot be tested except by spawning one, and a test that
 * spawns is a test that cannot see the Report the run built.
 */
export async function run(argv, write = (s) => process.stdout.write(s),
  readStdin = () => readFileSync(0, 'utf8')) {
  const opts = parseArgs(argv);
  if (opts.version) { write('assay 0.2.2\n'); return 0; }
  if (opts.help || !opts.cmd) { write(USAGE); return 2; }

  let config;
  try {
    config = load(opts.config, opts.root);
  } catch (err) {
    if (err instanceof ConfigError) { write(`assay: ${err.message}\n`); return 2; }
    throw err;
  }
  const root = path.resolve(opts.root);
  const report = new Report();
  const verbose = !opts.quiet;

  switch (opts.cmd) {
    case 'anchors':
      await auditAnchors(root, config, report);
      return finish(report, config, write, verbose, ['anchors']);

    case 'why': {
      if (opts.positional.length !== 1) {
        write('assay why needs one FILE::NAME\n');
        return 2;
      }
      const found = await whyRef(opts.positional[0], report);
      if (found.unresolved) { write(`assay: ${found.unresolved}\n`); return 2; }
      return finish(report, config, write, verbose);
    }

    case 'probe': {
      // THE TWO HALVES DO NOT INVOKE EACH OTHER, and that is deliberate rather than
      // lazy. `npm install assay-checks` gives you this half and `pip install` gives
      // you the other; neither can assume the other is on the machine, and a command
      // that shells out to a binary that may not exist fails in a way that reads like
      // the code being wrong. So one half writes a record and the other reads it.
      //
      // IT WRITES JSON ON STDOUT, so redirecting it is the point.
      if (opts.positional.length !== 1) {
        write('assay probe needs one FILE::NAME\n');
        return 2;
      }
      const found = await crossRecord(opts.positional[0]);
      if (found.unresolved) { write(`assay: ${found.unresolved}\n`); return 2; }
      write(`${JSON.stringify(sortedKeys(found.record), null, 2)}\n`);
      return 0;
    }

    case 'cross': {
      if (opts.positional.length !== 2) {
        write('assay cross needs two references\n');
        return 2;
      }
      const sides = [];
      for (const ref of opts.positional) {
        // eslint-disable-next-line no-await-in-loop
        const found = await crossSide(ref, opts.withCmd);
        if (found.unresolved) { write(`assay: ${found.unresolved}\n`); return 2; }
        sides.push(found.record);
      }
      const [first, second] = sides;
      const pair = `${first.ref} [${first.language}]  vs  ${second.ref} [${second.language}]`;
      const refused = sides.find((s) => s.look !== undefined);
      if (refused) {
        report.look(`${pair} — ${refused.ref} could not be probed: ${refused.look}`,
          first.ref);
        return finish(report, config, write, verbose);
      }
      if (first.language === second.language) {
        report.look(`${pair} — both sides are ${first.language}; \`pair\` compares two `
          + 'functions of one language on its own ladder, which is stronger', first.ref);
        return finish(report, config, write, verbose);
      }
      const rungs = crossLadder(first.arity);
      const [verdict, detail] = compareCross(first.vector, second.vector, first.ladder,
        second.ladder, rungs);
      if (verdict === 'same') {
        report.finding(`same answer across languages (${first.ladder}): ${pair}`,
          first.ref,
          'no input in the shared ladder told them apart — READ them; only a person '
          + 'decides whether the duplication is a defect');
      } else if (verdict === 'differs') {
        report.ok(`differs: ${pair} — ${detail}`, first.ref);
      } else {
        report.look(`${pair} — ${detail}`, first.ref);
      }
      return finish(report, config, write, verbose);
    }

    case 'runners':
      auditRunners(root, config, report);
      checkExemptions(root, config, report);
      return finish(report, config, write, verbose, ['runners']);

    case 'diff':
      auditDiff(root, opts.base, config, report);
      return finish(report, config, write, verbose, ['diff']);

    case 'all': {
      const { performed } = await auditEverything(root, opts, config, report);
      return finish(report, config, write, verbose, performed);
    }

    case 'accept': {
      if (!opts.reason) {
        write('assay: accept needs --reason. An acceptance without one cannot be told '
          + 'from an oversight,\n       and the baseline is the table that accumulates '
          + 'most and rots first.\n');
        return 2;
      }
      const { families } = await auditEverything(root, opts, config, report);
      const known = new Set(config.baselineLines);
      const fired = new Set(report.findings.map((i) => i.message));
      const line = opts.positional[0];
      let chosen;
      if (line !== undefined) {
        if (known.has(line)) { write(`assay: already in the baseline: ${line}\n`); return 2; }
        if (report.looks.some((i) => i.message === line)) {
          write('assay: that line is a `look`. '
            + 'A `look` never fails the run, so there is nothing\n'
            + '       to accept: baselining one writes a record that can never match '
            + 'and\n       never expire.\n');
          return 2;
        }
        if (!fired.has(line)) {
          write('assay: nothing in this run printed that line. Accepting it would '
            + 'write an entry\n'
            + '       that is stale the moment it lands — paste a `finding` exactly '
            + 'as it was\n       printed.\n');
          return 2;
        }
        chosen = [line];
      } else {
        chosen = report.findings.map((i) => i.message).filter((m) => !known.has(m));
      }
      if (!chosen.length) { write('assay: nothing new to accept.\n'); return 0; }
      const file = config.path || path.join(root, CONFIG_NAMES[0]);
      writeBaseline(file, chosen.map((l) => ({
        line: l, reason: opts.reason, producedBy: families.get(l) || null,
      })));
      write(`assay: wrote ${chosen.length} `
        + `${chosen.length === 1 ? 'entry' : 'entries'} to ${file}\n`);
      for (const l of chosen) write(`  + [${families.get(l) || 'no from'}] ${l}\n`);
      return 0;
    }

    case 'scan': {
      if (!opts.positional.length) { write('assay scan needs a path\n'); return 2; }
      const scan = await collect(opts.positional);
      group(scan);
      reportScan(scan, report);
      if (!scan.groups.length) {
        report.note('\nsame   none — no two probed functions share an outcome vector');
      }
      return finish(report, config, write, verbose, ['scan']);
    }

    case 'pair': {
      if (opts.positional.length !== 2) { write('assay pair needs two refs\n'); return 2; }
      const probes = [];
      for (const ref of opts.positional) {
        // eslint-disable-next-line no-await-in-loop
        const found = await probeRef(ref);
        if (found.unresolved) { write(`assay: ${found.unresolved}\n`); return 2; }
        if (found.unprobed) {
          // A function this tool may not execute is a `look`, not a failed run.
          report.look(`${found.display} — ${found.unprobed}`, found.display);
          return finish(report, config, write, verbose);
        }
        probes.push([found.display, found.entry]);
      }
      const [[refA, a], [refB, b]] = probes;
      const [verdict, detail] = compare(
        a.vector, b.vector, ladderKey(a.arity), ladderKey(b.arity), ladder(a.arity),
      );
      const pair = `${refA}  vs  ${refB}`;
      if (verdict === 'same') report.finding(`same answer: ${pair}`, refA, detail);
      else if (verdict === 'differs') report.ok(`differs: ${pair} — ${detail}`, refA);
      else report.look(`${pair} — ${detail}`, refA);
      return finish(report, config, write, verbose);
    }

    case 'search': {
      if (!opts.into.length) { write('assay search needs --in DIR\n'); return 2; }
      // A FLAG THAT DOES NOT APPLY IS AN ERROR RATHER THAN A NO-OP. `--name` picks one
      // definition out of a snippet, so with a FILE::NAME it has nothing to pick, and
      // accepting it quietly leaves a flag that is documented, parsed and inert.
      if (opts.name !== null && !opts.stdin) {
        write('assay: --name selects a function inside a --stdin snippet; a '
          + 'FILE::NAME already names one\n');
        return 2;
      }
      if (opts.stdin && opts.positional.length) {
        write('assay: --stdin and a FILE::NAME are two different queries; give one\n');
        return 2;
      }
      if (!opts.stdin && !opts.positional.length) {
        write('assay: search needs a FILE::NAME or --stdin\n');
        return 2;
      }
      const found = opts.stdin
        ? await probeStdin(readStdin(), opts.name)
        : await probeRef(opts.positional[0]);
      if (found.unresolved) { write(`assay: ${found.unresolved}\n`); return 2; }
      if (found.unprobed) {
        report.look(`${found.display} — ${found.unprobed}`, found.display);
        report.note('       the tree was not searched, because this function could '
          + 'not be probed');
        return finish(report, config, write, verbose);
      }
      const { entry, display: ref } = found;
      const scan = await collect(opts.into);
      const key = ladderKey(entry.arity);
      const target = entry.vector.join(' ');
      // Excluded by REFERENCE, not by name. Filtering every ref ending in the query's
      // name hides the answer the command exists to find: a second implementation
      // that happens to be called the same thing is still a second implementation.
      const hits = [...scan.probed.entries()]
        .filter(([r, v]) => scan.keys.get(r) === key && v.join(' ') === target
          && r !== ref)
        .map(([r]) => r).sort();
      if (hits.length) {
        report.finding(`the tree already answers ${ref}: ${hits.join(', ')}`, ref,
          'read them before writing a second one');
      } else {
        report.note(`\nsame   none — nothing in the tree matched ${ref}'s outcome vector`);
        report.note('       which is not proof that nothing answers it; see Limits');
      }
      reportScan(scan, report);
      return finish(report, config, write, verbose);
    }

    default:
      write(`assay: unknown command ${opts.cmd}\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Was this file run as a program, or imported by something else?
 *
 * BOTH SIDES ARE REALPATH'D, and that is the entire point of the function. `npm`
 * installs a `bin` as a SYMLINK: `node_modules/.bin/assay` points at
 * `node_modules/assay-checks/js/src/cli.js`, so `process.argv[1]` is the LINK while
 * `import.meta.url` is its TARGET. Comparing them without resolving made every
 * invocation of the installed command do nothing, print nothing, and exit 0 — the code
 * that means "the tool ran and there is nothing to read". The published CLI reported a
 * clean tree by never having run, which is the exact failure this package exists to
 * report, shipped inside the package that reports it.
 *
 * `path.resolve` was never enough: it makes a path absolute and leaves symlinks alone.
 * Comparing resolved PATHS also drops the hand-built `file://` URL, which mangled any
 * directory containing a space or a `#`.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1])
      === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this file being run as a program.
    return false;
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

export { jsFiles, Scan };
