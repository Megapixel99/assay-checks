/**
 * Do two functions answer the same question? Decided by EXECUTION.
 *
 * A property suite is per-artifact and behavioural. Duplication is cross-artifact and
 * structural. Two implementations that both pass are two implementations that both
 * pass, and no amount of testing either one tells you the other exists. Correctness
 * was never the question duplication asks.
 *
 * HOW. Every comparable function is probed ONCE against one deterministic ladder of
 * inputs, producing an OUTCOME VECTOR. Two functions are candidates for being the same
 * function exactly when their vectors match — so discovery is a hash bucket rather
 * than a quadratic sweep, and the decider is execution rather than text. NAMES ARE
 * NEVER READ.
 *
 * HOW THIS DIFFERS FROM THE PYTHON HALF, stated because it is a real difference and
 * not a detail. Python can lift a single function's source out of a file and execute
 * that alone, so it never imports the module. JavaScript has no equivalent: a function
 * object only exists once its module has been evaluated. So this loads the module —
 * and therefore RUNS ITS TOP-LEVEL CODE — with two compensations:
 *
 *   1. It happens in a CHILD PROCESS, so top-level side effects cannot reach the
 *      caller's state and a crash or a hang is contained.
 *   2. The file's SOURCE is gated before it is loaded at all. A file that reaches for
 *      the filesystem, the network, the clock, randomness or the process is skipped
 *      whole, never loaded.
 *
 * A per-function gate then runs over `fn.toString()`, which is real source rather than
 * a guess. The residue is genuine and worth knowing: a module with a side effect at
 * import time that mentions none of the gated names will still be evaluated. If that
 * is unacceptable for your tree, point the tool at the files you trust rather than at
 * the whole repository.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Report } from './verdicts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MAX_PAIRS_PER_INPUT = 40;
export const MAX_ARITY = 3;
export const MIN_DISTINCT = 2;
export const REPR_INLINE = 200;
export const PROBE_TIMEOUT_MS = 20000;
export const LADDER_VERSION = 'v2';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor',
]);

/**
 * Source that means the code reaches outside its arguments.
 *
 * `Math.random` and `Date` are here for the same reason the clock and the RNG are
 * gated on the Python side: both are perfectly ordinary, and both make an outcome
 * depend on something the ladder does not control, so a `differs` from either would be
 * noise and a `same` would be luck.
 */
const CORE_MODULES = 'fs|net|http|https|child_process|dgram|dns|tls|os|cluster'
  + '|worker_threads|v8|vm|repl|readline|perf_hooks|inspector';

const IMPURE_SOURCE = [
  [new RegExp('\\brequire\\s*\\(\\s*[\'"](?:node:)?(?:' + CORE_MODULES + ')'),
    'reaches a node core module'],
  [new RegExp('\\bfrom\\s+[\'"](?:node:)?(?:' + CORE_MODULES + ')'),
    'reaches a node core module'],
  [/\bprocess\s*\./, 'touches process'],
  [/\bMath\s*\.\s*random\b/, 'uses randomness'],
  [/\bDate\s*\.\s*now\b|\bnew\s+Date\b/, 'reads the clock'],
  [/\bglobalThis\b|\bglobal\s*\./, 'touches global state'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'evaluates source at runtime'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket/, 'reaches the network'],
];

const IMPURE_FUNCTION = [
  ...IMPURE_SOURCE,
  [/^\s*async\b|\bawait\b/, 'async'],
  [/^\s*(?:async\s+)?function\s*\*/, 'generator'],
  [/\bthis\b/, 'uses `this`, so it is a method'],
  [/\.\.\.\w+\s*[,)]/, 'rest parameters'],
];

/** Why this FILE may not be loaded at all, or null. */
export function fileRefusal(source) {
  for (const [pattern, why] of IMPURE_SOURCE) {
    if (pattern.test(source)) return why;
  }
  return null;
}

/** Why this FUNCTION may not be probed, or null. `source` is fn.toString(). */
export function functionRefusal(source, arity) {
  if (arity === 0) return 'no arguments (a ladder cannot discriminate)';
  if (arity > MAX_ARITY) return `arity ${arity} (no ladder above ${MAX_ARITY})`;
  for (const [pattern, why] of IMPURE_FUNCTION) {
    if (pattern.test(source)) return why;
  }
  return null;
}

/**
 * How a file is named in a report: relative when that is shorter and stays inside the
 * tree, absolute otherwise. A relative path that climbs out through a dozen `..`
 * segments is not a shorter name, it is an unreadable one.
 */
export function displayPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith('..') ? file : rel;
}

/** Every .js/.mjs under the given files/directories, sorted, deterministic. */
export function jsFiles(targets) {
  const out = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mjs|js)$/.test(name)) out.add(path.resolve(full));
    }
  };
  for (const target of targets) {
    if (statSync(target).isDirectory()) walk(target);
    else out.add(path.resolve(target));
  }
  return [...out].sort();
}

// --------------------------------------------------------------------------- //
// The ladder. Deterministic, shared by every function of the same arity, so two
// vectors are comparable by construction.
// --------------------------------------------------------------------------- //
// Hand-written rather than random: two runs must be byte-identical, and a seeded RNG
// makes the ladder a function of the seed rather than of the question. Values cover
// the shapes ordinary code takes, plus the EMPTY case of each — the empty case is
// where two implementations of one function most often stop agreeing.
export const BASE_VALUES = [
  '0', '1', '2', '-1', '7', '255',
  '3.5', '-0.5',
  'true', 'false', 'null',
  '""', '"a"', '"abc"', '"Hello, World!"', '"ATTACK AT DAWN, at dawn!"',
  '"  padded  "', '"10"', '"aeiou"',
  // Ask what characters your inputs NEVER contain, then add them. Without these,
  // a predicate written over ASCII and one written over Unicode categories agree on
  // every value in the ladder and are still not the same function. One character is
  // the difference between a `same` and a `differs` with a witness.
  '"\\u00bd"', '"\\u00e9"', '"\\t\\n"',
  '[]', '[1, 2, 3]', '[3, 1, 2]', '["a", "b"]',
  '{}', '{"a": 1}', '{"a": 1, "b": 2}',
];

export function ladder(arity) {
  if (arity === 1) return BASE_VALUES.map((v) => `[${v}]`);
  const n = BASE_VALUES.length;
  const combos = [];
  for (let i = 0; i < MAX_PAIRS_PER_INPUT; i += 1) {
    const idx = [];
    for (let k = 0; k < arity; k += 1) idx.push((i * (k + 1) + k * 5) % n);
    combos.push(`[${idx.map((j) => BASE_VALUES[j]).join(', ')}]`);
  }
  for (let i = 0; i < n; i += 1) {
    combos.push(`[${new Array(arity).fill(BASE_VALUES[i]).join(', ')}]`);
  }
  return [...new Set(combos)];
}

export function ladderKey(arity) { return `arity${arity}/${LADDER_VERSION}`; }

/**
 * A stable, order-insensitive rendering.
 *
 * Object keys are sorted so two implementations differing only in insertion order are
 * not reported as differing. Numbers keep their exact value: a floating-point
 * difference IS a difference, and rounding it away would be the tool deciding the
 * thing it exists to report. `-0`, `NaN` and the two infinities are spelled out
 * because `JSON.stringify` flattens all four into something they are not.
 */
export function canon(value, depth = 0) {
  if (depth > 6) return '...';
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return 'symbol';
  if (Array.isArray(value)) {
    return `[${value.map((v) => canon(v, depth + 1)).join(', ')}]`;
  }
  if (value instanceof Set) {
    return `Set{${[...value].map((v) => canon(v, depth + 1)).sort().join(', ')}}`;
  }
  if (value instanceof Map) {
    return `Map{${[...value.entries()]
      .map(([k, v]) => `${canon(k, depth + 1)}: ${canon(v, depth + 1)}`)
      .sort()
      .join(', ')}}`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${canon(value[k], depth + 1)}`).join(', ')}}`;
}

/**
 * 'V:<canon>' | 'V#<sha1>' | 'E:<Name>'. Error NAME, never its message.
 *
 * Messages legitimately differ between two correct implementations of one function —
 * they carry the function's own name — so comparing them would make every pair
 * `differs` and the tool useless, in the way that looks most like working correctly.
 */
export function outcomeOf(fn, args) {
  let value;
  try {
    value = fn(...args);
  } catch (err) {
    return `E:${(err && err.name) || 'Error'}`;
  }
  if (value && typeof value.then === 'function') return 'E:AsyncResult';
  const text = canon(value);
  if (text.length > REPR_INLINE) {
    return `V#${createHash('sha1').update(text).digest('hex')}`;
  }
  return `V:${text}`;
}

// --------------------------------------------------------------------------- //
// The decisions.
// --------------------------------------------------------------------------- //

export function projections(inputs) {
  const parsed = inputs.map((src) => JSON.parse(src));
  const arity = parsed.length ? parsed[0].length : 0;
  const out = [];
  for (let i = 0; i < arity; i += 1) {
    out.push(parsed.map((args) => outcomeOf((...a) => a[i], args)));
  }
  return out;
}

/**
 * Is this vector a projection ON EVERY INPUT IT ANSWERED?
 *
 * Comparing whole vectors is not enough: a transform whose vocabulary the ladder lacks
 * is the identity wherever it answers and throws everywhere else, so its vector
 * differs from the projection exactly where the function refused to run. The question
 * is about the positions where it DID run.
 */
export function isProjection(vector, inputs) {
  const live = [];
  vector.forEach((o, i) => { if (!o.startsWith('E:')) live.push(i); });
  if (!live.length) return true;
  for (const proj of projections(inputs)) {
    if (live.every((i) => vector[i] === proj[i])) return true;
  }
  return false;
}

/**
 * Did this ladder tell this function apart from a constant?
 *
 * THE LOAD-BEARING GUARD. Two functions that throw on every input agree perfectly, and
 * so do two that return the same constant. Without this, a scan of any codebase
 * reports every one-argument function as everyone else's twin.
 *
 * THE DISTINCT COUNT IS OVER RETURNED VALUES, NOT OVER OUTCOMES. Two distinct outcomes
 * is satisfied by one return plus one throw, which rewards a probe that found the
 * function's type errors and never reached its behaviour.
 */
export function discriminating(vector, inputs = null) {
  const returned = vector.filter((o) => !o.startsWith('E:'));
  if (new Set(returned).size < MIN_DISTINCT) return null;
  if (inputs && isProjection(vector, inputs)) return null;
  return { returned: returned.length, distinct: new Set(returned).size };
}

/** ['same'|'differs'|'look', detail]. Refuses two vectors from different ladders. */
export function compare(aVec, bVec, aKey, bKey, inputs) {
  if (aKey !== bKey) return ['look', `not comparable: ${aKey} vs ${bKey}`];
  if (aVec.length !== bVec.length || aVec.length !== inputs.length) {
    return ['look', 'vector length disagrees with the ladder'];
  }
  for (let i = 0; i < aVec.length; i += 1) {
    if (aVec[i] !== bVec[i]) {
      return ['differs', `${inputs[i]} -> ${aVec[i]} vs ${bVec[i]}`];
    }
  }
  if (discriminating(aVec, inputs) === null) {
    return ['look', 'not discriminated by the ladder'];
  }
  return ['same', `no input in ${inputs.length} told them apart`];
}

/** Probe every exported function of one file, in a child process. */
export function probeFile(file, timeout = PROBE_TIMEOUT_MS, gated = null) {
  return new Promise((resolve) => {
    const worker = path.join(HERE, 'probe.js');
    // The source travels WITH the path. The child loads by path, so relative imports
    // still resolve; the text is its fallback for a runtime that will not read a
    // `.js` file as a module — see `loadModule` in probe.js for why that is Node 18
    // and not Node 24.
    //
    // `gated` is the source a caller ALREADY read and passed `fileRefusal`. Re-reading
    // here would mean the bytes that were gated and the bytes that get loaded are two
    // separate reads of a file that can change between them — and the whole point of
    // the gate is that nothing unreviewed reaches the loader.
    let source = gated;
    if (source === null) {
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        source = '';
      }
    }
    const child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        const tail = (err.trim().split('\n').pop() || 'silent').slice(0, 70);
        resolve({ error: `probe failed (${tail})` });
      }
    });
    const ladders = {};
    for (let arity = 1; arity <= MAX_ARITY; arity += 1) ladders[arity] = ladder(arity);
    child.stdin.end(JSON.stringify({ file, source, ladders }));
  });
}

export class Scan {
  constructor() {
    this.probed = new Map();   // ref -> vector
    this.keys = new Map();     // ref -> ladder key
    this.skipped = new Map();  // ref -> reason
    this.groups = [];
    this.files = 0;
    this.functions = 0;
  }

  census() {
    const counts = new Map();
    for (const why of this.skipped.values()) {
      const key = why.split('(')[0].split(':')[0].trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    // Descending by count, then code-point order — `sorted(key=lambda kv: (-kv[1],
    // kv[0]))` on the Python side. NOT `localeCompare`: ICU ignores punctuation and
    // case at primary strength, so the same census prints in a different order
    // depending on which half of the tool rendered it.
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}

export async function collect(targets, scan = new Scan()) {
  for (const file of jsFiles(targets)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scan.files += 1;
    const rel = displayPath(file);
    const why = fileRefusal(source);
    if (why) {
      // A refused FILE is counted once with its reason rather than silently dropped:
      // a census that omits what it never looked at reads exactly like a clean sweep.
      scan.skipped.set(`${rel}::*`, why);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await probeFile(file, PROBE_TIMEOUT_MS, source);
    if (result.error) {
      scan.skipped.set(`${rel}::*`, result.error);
      continue;
    }
    for (const entry of result.functions || []) {
      scan.functions += 1;
      const ref = `${rel}::${entry.name}`;
      if (entry.skip) {
        scan.skipped.set(ref, entry.skip);
        continue;
      }
      if (discriminating(entry.vector, ladder(entry.arity)) === null) {
        scan.skipped.set(ref, 'not discriminated by the ladder');
        continue;
      }
      scan.probed.set(ref, entry.vector);
      scan.keys.set(ref, ladderKey(entry.arity));
    }
  }
  return scan;
}

export function group(scan) {
  const buckets = new Map();
  for (const [ref, vector] of scan.probed) {
    const key = `${scan.keys.get(ref)}|${vector.join(' ')}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ref);
  }
  scan.groups = [...buckets.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return scan.groups;
}

/**
 * A Scan rendered into the shared verdict vocabulary.
 *
 * A `same` group is a FINDING: something a person must read. It is not an assertion
 * that the duplication is wrong — only one flavour of duplication is a defect, and
 * telling them apart is a judgment about what the two pieces of code are FOR, which no
 * execution can make.
 */
export function reportScan(scan, report = new Report()) {
  for (const grp of scan.groups) {
    report.finding(
      `same answer (${scan.keys.get(grp[0])}): ${grp.join(', ')}`,
      grp[0],
      'no input in the ladder told them apart — READ them; only a person decides '
      + 'whether the duplication is a defect',
    );
  }
  report.note(`\n${scan.files} files, ${scan.functions} functions, `
    + `${scan.probed.size} probed, ${scan.skipped.size} not probed`);
  for (const [why, count] of scan.census()) {
    report.note(`  ${why.padEnd(44)} ${count}`);
  }
  report.note('  (a not-probed function is a `look`, never a finding — '
    + '"we found none" and "we never looked" are different claims)');
  return report;
}
