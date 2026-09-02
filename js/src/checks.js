/**
 * Audit the CHECKS, not the code — could those tests have failed?
 *
 * Ordinary CI answers *did the tests pass*. Almost nothing answers the question that
 * sits one level up, and it is the question that hides the most defects:
 *
 *     could those tests have failed?
 *
 * A suite that crashed before its first assertion reports no failures. A harness that
 * counts "the suite did not run" as "the suite caught it" reports a perfect score. A
 * guard added without anything exercising it is a green build over untested code. Each
 * of these looks exactly like success.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not review code. It cannot tell you an
 * abstraction is wrong, a name is misleading, or an edge case is unhandled.
 *
 * WHERE THIS IS WEAKER THAN THE PYTHON HALF, stated rather than left for you to
 * discover. The `dead-vs-real` detector there reads an abstract syntax tree and asks
 * whether the failures are genuinely PARTITIONED before being counted; here it is a
 * pattern over source text, because a JavaScript parser is a dependency and this
 * package has none. The consequence is one-directional and worth knowing: the textual
 * version can be satisfied by code that merely mentions the right names. It will not
 * produce a false FINDING, it will miss a real one. If your harnesses are Python, run
 * the Python half over them and get the stronger detector.
 *
 * `no-tree-writes` USED TO BE IN THAT PARAGRAPH TOO and no longer is, which is worth
 * saying because the fix generalises. It needed to tell code from text — a runner's
 * anchors are string literals holding fragments of the code under test, and matching
 * the file as text reads the quotation as the deed — and that distinction does not
 * need a parse, only a scan that knows where a string begins and ends. `codeOnly` is
 * that scan. What still needs a parser is everything ABOUT the code once you have it,
 * which is why `dead-vs-real` stays where it is.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { Report } from './verdicts.js';

export const RUNNER_PREFIX = 'mutations';
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor',
]);

/**
 * Every mutation harness under root, as paths RELATIVE to root, sorted.
 *
 * Discovery is a walk rather than a list, on purpose. A list of harnesses to audit is
 * one more table that can go stale, and the harness nobody added to the list is
 * exactly the one that has been asleep the longest.
 */
export function findRunners(root, prefix = RUNNER_PREFIX) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.startsWith(prefix) && /\.(mjs|cjs|js)$/.test(name)) {
        out.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
}

const has = (src, ...needles) => needles.some((n) => src.includes(n));

/**
 * The OTHER way to satisfy both partition properties.
 *
 * A harness can require the failure to appear in a NAMED section and report WRONG when
 * it appears anywhere else. That makes a crashed suite impossible to score as a
 * detection without any partition and without parsing the mutant — the property is met
 * by a different mechanism rather than missing. Encoding the alternative is what keeps
 * a structural detector from punishing a stronger design than the one it knows.
 */
const requiresNamedSection = (src) => src.includes('WRONG') && has(src, 'wanted', 'section');

/** Does the source assign every one of these names anywhere? */
function assignsAll(src, ...names) {
  return names.every((name) => new RegExp(
    `(?:const|let|var)\\s+${name}\\b|\\b${name}\\s*=[^=]`,
  ).test(src));
}

// THE TELLS ARE NAMED CONSTANTS because both halves must accept the same harness. A
// `.js` harness is audited by this half and a `.py` one by the other, so a tell present
// in one list and absent from the other means a correct harness passes in one language
// and is a finding in the other — one config, two verdicts, which is the drift
// `test_parity.py` exists to stop. Both spellings of the failure name are here for the
// same reason: `restoreFailed` is what a JavaScript harness writes and `restore_failed`
// is what a Python one writes, and neither is wrong.
export const DIGEST_TELLS = ['hexdigest', '.digest(', 'sha256', 'sha1', 'sha512',
  'md5', 'createHash'];
export const RESTORE_FAILURE_TELLS = ['RESTORE FAILED', 'NOT RESTORED',
  'restore_failed', 'restoreFailed', 'did not come back'];

// The suffixes that make a path beside the code STATE rather than more source. Both
// halves carry this list and `test_parity.py` pins them equal: a suffix present in one
// and missing from the other means the same harness is a finding in one language and
// clean in the other, off one `assay.json`.
export const STATE_SUFFIXES = ['.json', '.tsv', '.db', '.jsonl', '.txt'];

// A NUL, because no source file contains one and the sentinel has to be a character a
// harness cannot introduce. `codeOnly` puts a pair around the VALUE of every string
// literal that is CODE; text merely quoted INSIDE such a literal never gets a pair, and
// that difference is the whole check.
const STATE_TARGET_RE = /(?:path\.)?join\(\s*(?:HERE|__dirname)\s*,\s*\0([^\0]*)\0/g;

// A `/` after any of these is a regular expression rather than a division, which is the
// one ambiguity a scanner this size has to settle. Getting it wrong is not cosmetic: a
// regex holding a lone quote — `/['"]/` — would otherwise open a string that never
// closes, and every literal after it in the file would be read with its polarity
// inverted, turning quoted anchors into "code".
const REGEX_LEAD_CHARS = '(,=:[!&|?{};+-*%~^<>';
const REGEX_LEAD_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else',
  'yield', 'await', 'throw', 'new', 'delete', 'void']);

/**
 * The source with comments gone and every string literal reduced to its VALUE between
 * NUL sentinels. Template and regular-expression literals become a bare `0`.
 *
 * JAVASCRIPT HAS NO PARSER IN THE STANDARD LIBRARY and this package has no
 * dependencies, so the Python half's `ast.walk` has no equivalent here. It does not
 * need one: the only distinction `no-tree-writes` turns on is whether the text it
 * matched is code or is quoted inside a string, and a scanner that knows where strings
 * begin and end answers exactly that and nothing more. What it cannot do is the rest of
 * a parse, and the property does not ask for it.
 *
 * TEMPLATES BECOME `0` RATHER THAN THEIR TEXT so the two halves agree: Python sees an
 * f-string as a `JoinedStr` and not a `Constant`, so it does not match one either. A
 * violation written with a backtick is therefore missed by both, in the same way, and
 * that is the direction to be wrong in.
 */
export function codeOnly(src) {
  let out = '';
  let prev = '';         // last non-space character of CODE emitted
  let word = '';         // the identifier run ending at `prev`, for `return /re/`
  let i = 0;
  const step = (ch) => {
    prev = ch;
    word = /[\w$]/.test(ch) ? word + ch : '';
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let value = '';
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { value += src[i + 1] || ''; i += 2; continue; }
        value += src[i];
        i += 1;
      }
      i += 1;
      out += `\0${value.split('\0').join('')}\0`;
      step('"');
      continue;
    }
    if (c === '`') {
      i += 1;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 1;
      out += '0';
      step('0');
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_LEAD_CHARS.includes(prev)
      || REGEX_LEAD_WORDS.has(word))) {
      i += 1;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i += 1; break; }
        i += 1;
      }
      out += '0';
      step('0');
      continue;
    }
    out += c;
    if (!/\s/.test(c)) step(c);
    i += 1;
  }
  return out;
}

/**
 * Every `join(__dirname, 'x.json')` that is CODE, as the names it aims at.
 *
 * Only the segment DIRECTLY under the directory constant counts, as on the Python side:
 * `join(__dirname, '..', other, 'x.json')` leaves this directory and is not state beside
 * the code under test.
 */
export function stateTargets(src) {
  const out = [];
  for (const match of codeOnly(src).matchAll(STATE_TARGET_RE)) {
    if (STATE_SUFFIXES.some((suffix) => match[1].endsWith(suffix))) out.push(match[1]);
  }
  return out;
}

export const PROPERTIES = [
  ['evidence', 'positive proof each suite RAN',
    'no failures reported and no test executed look identical',
    (src) => has(src, 'EVIDENCE', 'DID NOT RUN', 'did not run', 'DID_NOT_RUN')],
  ['dead-vs-real', 'a DID-NOT-RUN is not a detection',
    'counting any failure scores a crash as a catch',
    (src) => assignsAll(src, 'dead', 'real') || requiresNamedSection(src)],
  ['restore-in-finally', 'the restore cannot be skipped by an exception',
    'an exception mid-run leaves the target mutated',
    (src) => /\bfinally\s*\{/.test(src)],
  // SIGKILL IS NOT IN THIS PROPERTY'S REACH, and that is worth knowing before relying
  // on it. SIGKILL cannot be caught: no handler runs, no `finally` runs, and nothing
  // this check could look for would have helped. The ordinary way to be SIGKILLed is a
  // TIMEOUT rather than an impatient person, so a harness satisfying all seven
  // properties, invoked under a timeout it then exceeds, leaves the tree mutated
  // exactly as though it carried none of them. The remedy belongs to whatever INVOKED
  // the harness: check that the tree came back, rather than trust that the harness was
  // given the chance to put it back.
  ['sigterm', 'SIGTERM becomes an exception so `finally` runs',
    'SIGTERM does not run `finally`; a kill leaves the tree broken',
    (src) => src.includes('SIGTERM')],
  ['parses-mutant', 'a file-breaking mutation is not scored',
    'a syntax error makes every suite fail, which reads as a catch',
    (src) => has(src, 'new Function(', 'checkSyntax', '--check', 'parseSync', 'acorn')
      || requiresNamedSection(src)],
  // THE TELL IS THE PATH RATHER THAN THE WRITE CALL, and this half used to require a
  // literal `writeFileSync(...)`. Two things were wrong with that. It read a bare
  // `join(__dirname, 'x.json')` as clean while the Python half read it as a finding, so
  // one `assay.json` gave two verdicts for the same harness depending on which binary
  // CI invoked — the drift `test_parity.py` exists to stop. And it is the narrower
  // question: the write is usually performed by the CHILD suite, and what the harness
  // contributes is a location beside its own source, so keying on the write is a
  // whitelist of spellings and what a whitelist omits is silence.
  ['no-tree-writes', 'no scratch state beside the code under test',
    'a clean target is not a clean tree',
    (src) => !stateTargets(src).length],
  // THE TREE CAME BACK, proved rather than assumed because the restore ran.
  // `restore-in-finally` proves the restore PATH EXECUTES; it says nothing about the
  // file on disk. A harness that restores from a buffer it read AFTER mutating, that
  // writes the text back in a different encoding, or that saved one of the two files
  // it touches, satisfies all six properties above and still leaves the tree wrong —
  // and every suite after it then scores code nobody wrote. The tell is a digest
  // taken before and compared after, plus a NAME for the failure when the two
  // disagree: a digest nothing compares is arithmetic, and a message nothing computes
  // is a string.
  ['restore-verified', 'the tree is PROVED to have come back',
    'a restore that ran is not a restore that worked',
    (src) => has(src, ...DIGEST_TELLS) && has(src, ...RESTORE_FAILURE_TELLS)],
];

export const PROPERTY_KEYS = new Set(PROPERTIES.map(([k]) => k));

/**
 * The rule the seven collapse into, worth stating on its own because it is the
 * generalisation and the seven are instances.
 */
export const THREE_QUESTIONS = 'a harness must answer separately whether the suite '
  + 'RAN, whether it FAILED, and whether the failure was the RIGHT one';

/** `"src/m.js sigterm"` -> `['src/m.js', 'sigterm']`. The property never has a space. */
function splitExemptKey(key) {
  const cut = key.lastIndexOf(' ');
  return [key.slice(0, cut), key.slice(cut + 1)];
}

export function auditRunners(root, config, report = new Report()) {
  const rels = findRunners(root);
  if (!rels.length) {
    report.note(`MUTATION RUNNERS — none found under ${root}.\n`
      + '  Nothing to audit here, which is not the same as nothing wrong.\n'
      + '  If this project has no mutation harness, `assay scan` is the half\n'
      + '  that still applies to it.');
    return report;
  }
  report.note('MUTATION RUNNERS — seven properties, each a way a harness can lie\n');
  for (const [key, desc, why] of PROPERTIES) {
    report.note(`  ${key.padEnd(20)} ${desc.padEnd(46)} ${why}`);
  }
  report.note(`\n  the rule they collapse into: ${THREE_QUESTIONS}\n`);

  for (const rel of rels) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    const missing = [];
    for (const [key, , why, detector] of PROPERTIES) {
      if (detector(src)) continue;
      if (config.exemptRunner(rel, key)) continue;
      missing.push([key, why]);
    }
    if (missing.length) {
      for (const [key, why] of missing) {
        report.finding(`${rel}: no \`${key}\` (${why})`, rel);
      }
    } else {
      report.ok(rel, rel);
    }
  }
  // The path and the property are separate columns, as they are on the Python side.
  // One `assay.json` serves both halves, so the same exemption printed two different
  // ways is a reader comparing two runs and finding a difference that is not there.
  for (const key of [...config.runnerExempt.keys()].sort()) {
    const [rel, property] = splitExemptKey(key);
    report.note(`  exempt   ${rel.padEnd(46)} ${property}: `
      + `${config.runnerExempt.get(key).slice(0, 60)}`);
  }
  return report;
}

/**
 * An exemption naming something that no longer exists is a finding.
 *
 * The second direction. Without it the file only ever grows.
 */
export function checkExemptions(root, config, report = new Report()) {
  for (const key of [...config.runnerExempt.keys()].sort()) {
    const [rel, property] = splitExemptKey(key);
    if (!existsSync(path.join(root, rel))) {
      report.finding(`exemption names a runner that no longer exists: ${rel}`, rel);
    }
    if (property !== '*' && !PROPERTY_KEYS.has(property)) {
      report.finding(`exemption names an unknown property: ${property} (${rel})`, rel);
    }
  }
  for (const rel of [...config.anchorExempt.keys()].sort()) {
    if (!existsSync(path.join(root, rel))) {
      report.finding(
        `anchor exemption names a file that no longer exists: ${rel}`, rel,
      );
    }
  }
  return report;
}

// --------------------------------------------------------------------------- //
// Auditing a CHANGE
// --------------------------------------------------------------------------- //
const FILE_RE = /[\w./-]+\.(?:js|mjs|cjs|ts|py)/g;
// A line that REFUSES, RETURNS EARLY or THROWS is a guard. A guard with nothing
// exercising it is a fix you cannot prove you made.
const GUARD_RE = /^\+\s*(?:if\s*\(.*\)\s*\{?|return\s+\d|throw\b|process\.exit\()/;
// Tests named for a LIMITATION go stale the moment the limitation lifts: the day the
// capability arrives, a correct change turns a green check red and the check is what
// looks broken.
const LIMIT_RE = /(?:it|test)\s*\(\s*['"`]([^'"`]*\b(?:no|not|cannot|never|unsupported|drops|refus\w*|reject\w*|falls back)\b[^'"`]*)['"`]/g;

function git(root, args) {
  try {
    return [0, execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })];
  } catch (err) {
    return [err.status || 1, (err.stdout || '').toString()];
  }
}

/**
 * Basenames a harness names, i.e. what it plausibly targets.
 *
 * Deliberately a MENTION rather than a resolved path. The failure mode is stated
 * rather than hidden: a harness that merely mentions a file counts as covering it, so
 * this UNDER-reports missing coverage and never over-reports it. An audit that errs
 * should err toward saying less.
 */
export function targetsMentioned(src) {
  return new Set([...src.matchAll(FILE_RE)].map((m) => path.basename(m[0])));
}

/**
 * Files changed against `base`, relative to ROOT, including uncommitted work.
 *
 * TWO PATH BASES HAVE TO BE RECONCILED. `git diff --name-only` reports paths relative
 * to the GIT TOPLEVEL, while the harness walk yields paths relative to the ROOT you
 * audited. When the code lives in a subdirectory those two never match, and every
 * comparison between them is silently false — which does not look like a bug, it looks
 * like a clean audit.
 *
 * Both sides are realpath'd first, and that is not belt-and-braces: `show-toplevel`
 * resolves symlinks and the root you were handed usually does not, so on any system
 * where a parent directory is a symlink the two disagree about a path that names the
 * same file. Same silent failure, arriving through the filesystem.
 */
export function changedFiles(root, base) {
  let [rc, names] = git(root, ['diff', '--name-only', `${base}...HEAD`]);
  if (rc !== 0) [rc, names] = git(root, ['diff', '--name-only', base]);
  if (rc !== 0) return [[], `cannot diff against ${base} — is it a valid ref?`];
  const changed = names.split(/\s+/).filter((n) => /\.(js|mjs|cjs|py)$/.test(n));
  const [, status] = git(root, ['status', '--porcelain']);
  for (const line of status.split('\n')) {
    const name = line.slice(3).trim();
    if (/\.(js|mjs|cjs|py)$/.test(name) && !changed.includes(name)) changed.push(name);
  }
  const [rcTop, top] = git(root, ['rev-parse', '--show-toplevel']);
  if (rcTop === 0 && top.trim()) {
    const realTop = realpathSync(top.trim());
    const realRoot = realpathSync(root);
    return [changed.map((c) => path.relative(realRoot, path.join(realTop, c))), null];
  }
  return [changed, null];
}

/**
 * Guard-shaped added lines, PER FILE.
 *
 * Computing this once over the whole patch makes a guard added in one file look like
 * an unguarded change in every OTHER file in the same commit. Findings must be about
 * the file they name.
 *
 * TWO PATCHES, UNIONED, because one of them structurally cannot see half the work.
 * `base...HEAD` is committed history and contains nothing you have not committed yet;
 * `HEAD` alone is the working tree. Reading only the first means a guard you just
 * wrote is invisible, so the finding can never fire on a dirty tree — which is exactly
 * when someone runs this.
 */
export function guardsPerFile(root, base) {
  let patch = '';
  for (const args of [['diff', '-U0', `${base}...HEAD`], ['diff', '-U0', 'HEAD']]) {
    const [rc, text] = git(root, args);
    if (rc === 0) patch += text;
  }
  const [rcTop, top] = git(root, ['rev-parse', '--show-toplevel']);
  const realTop = rcTop === 0 && top.trim() ? realpathSync(top.trim()) : '';
  const realRoot = realpathSync(root);
  const perFile = new Map();
  let current = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = line.includes(' b/') ? line.split(' b/').pop() : null;
      if (current && realTop) {
        current = path.relative(realRoot, path.join(realTop, current));
      }
    } else if (current && line.startsWith('+') && GUARD_RE.test(line)) {
      if (!perFile.has(current)) perFile.set(current, []);
      perFile.get(current).push(line);
    }
  }
  return perFile;
}

/** Does this change carry the checks it needs? */
export function auditDiff(root, base, config, report = new Report()) {
  const [changed, error] = changedFiles(root, base);
  if (error) { report.finding(error); return report; }
  if (!changed.length) {
    report.note(`\nCHANGE — no source files changed against ${base}`);
    return report;
  }
  const covers = new Map();
  for (const rel of findRunners(root)) {
    covers.set(rel, targetsMentioned(readFileSync(path.join(root, rel), 'utf8')));
  }
  const perFile = guardsPerFile(root, base);

  report.note(`\nCHANGE — ${changed.length} source file(s) against ${base}`);
  for (const name of changed) {
    const baseName = path.basename(name);
    if (baseName.startsWith(RUNNER_PREFIX) || baseName.startsWith('test_')) continue;
    const owning = [...covers.entries()]
      .filter(([, t]) => t.has(baseName)).map(([r]) => r).sort();
    if (!owning.length) {
      report.look(`${name} has NO mutation runner naming it — a missing check is a `
        + 'stronger signal than a failing one', name);
      continue;
    }
    const grew = owning.some((r) => changed.includes(r));
    if (perFile.has(name) && !grew) {
      report.finding(`${name} adds a guard and no runner that names it grew a `
        + `mutation (${owning.join(', ')}) — a fix with nothing exercising it is a `
        + 'fix you cannot prove you made', name);
    } else {
      report.ok(`${name.padEnd(44)} covered by ${owning.join(', ')}`, name);
    }
  }

  for (const name of changed) {
    const full = path.join(root, name);
    if (!existsSync(full) || !/\.(js|mjs|cjs)$/.test(name)) continue;
    const stale = [...readFileSync(full, 'utf8').matchAll(LIMIT_RE)].map((m) => m[1]);
    if (stale.length && [...covers.values()].some((t) => t.has(path.basename(name)))) {
      report.look(`${name} carries ${stale.length} limitation-shaped test(s) `
        + `(${stale[0].slice(0, 44)}...) — the day that limitation lifts, a correct `
        + 'change turns those green checks red', name);
    }
  }
  return report;
}
