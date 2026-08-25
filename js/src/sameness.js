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

/** The child answers on fd 3, never on stdout. See `probeFile`. */
export const ANSWER_FD = 3;

export const MAX_PAIRS_PER_INPUT = 40;
export const MAX_ARITY = 3;
export const MIN_DISTINCT = 2;
export const REPR_INLINE = 200;
export const PROBE_TIMEOUT_MS = 20000;
/**
 * The bound on ONE awaited rung, and it is deliberately not the Python half's number.
 *
 * Python spends a whole child on one FUNCTION, so a per-input second is affordable
 * there. This half spends one child on a whole FILE, so a per-input bound has to be
 * small enough that a single function cannot eat the file's entire budget.
 *
 * It is safe to make it this small because it bounds only a PENDING PROMISE. A
 * synchronous loop never yields, so this can never fire on one — that case is still
 * the wall clock's. And a pure function that legitimately needs a quarter of a second
 * of WAITING is a function that is waiting on something outside its arguments, which
 * the clock and network gates already refuse.
 */
export const PER_INPUT_MS = 250;
export const LADDER_VERSION = 'v3';
// What a snippet read from stdin is called. It collides with nothing a tree can
// contain, so `search` excluding the query by REFERENCE needs no special case for
// it. The Python half carries the same string.
export const SNIPPET_PATH = '<stdin>';

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

/**
 * `SPECIFIER` marks a gate whose subject IS a string literal — a module name. Those
 * must be matched with string bodies INTACT; blanking them turns `from 'node:fs'` into
 * `from '      '` and the file loads unrefused. Everything else is `CODE`, matched with
 * strings and comments blanked so prose cannot trip it.
 */
const CODE = 'code';
const SPECIFIER = 'specifier';

const IMPURE_SOURCE = [
  [new RegExp('\\brequire\\s*\\(\\s*[\'"](?:node:)?(?:' + CORE_MODULES + ')'),
    'reaches a node core module', SPECIFIER],
  [new RegExp('\\bfrom\\s+[\'"](?:node:)?(?:' + CORE_MODULES + ')'),
    'reaches a node core module', SPECIFIER],
  [/(?<![.?\w$])process\s*\./, 'touches process'],
  [/\bMath\s*\.\s*random\b/, 'uses randomness'],
  [/\bDate\s*\.\s*now\b|\bnew\s+Date\b/, 'reads the clock'],
  [/\bglobalThis\b|(?<![.?\w$])global\s*\./, 'touches global state'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'evaluates source at runtime'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket/, 'reaches the network'],
];

const IMPURE_FUNCTION = [
  ...IMPURE_SOURCE,
  [/^\s*(?:async\s+)?function\s*\*/, 'generator'],
  [/\bthis\b/, 'uses `this`, so it is a method'],
  [/\.\.\.\w+\s*[,)]/, 'rest parameters'],
];

/** A `/` here opens a regex rather than dividing. */
const REGEX_MAY_FOLLOW = new Set([
  '', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%',
  '~', '^', '<', '>',
]);

/** ...and so does a `/` right after one of these words. */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/** The last real token of the code emitted so far: its final character and its word. */
function precedingToken(text) {
  let j = text.length - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  if (j < 0) return { ch: '', word: '' };
  const ch = text[j];
  if (!/[A-Za-z0-9_$]/.test(ch)) return { ch, word: '' };
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k -= 1;
  return { ch, word: text.slice(k + 1, j + 1) };
}

function startsRegex(emitted) {
  const { ch, word } = precedingToken(emitted);
  if (word) return REGEX_KEYWORDS.has(word);
  return REGEX_MAY_FOLLOW.has(ch);
}

/** Index just past a regex literal's closing `/`, or -1 if it does not close. */
function scanRegex(source, start) {
  let j = start + 1;
  let inClass = false;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return -1;
    if (inClass) { if (c === ']') inClass = false; } else if (c === '[') inClass = true;
    else if (c === '/') return j + 1;
    j += 1;
  }
  return -1;
}

/**
 * The same source with comments and string bodies blanked — or null when the scan
 * lost the thread.
 *
 * The gates above are regexes, and a regex reads prose exactly as eagerly as it reads
 * code. Both halves of that were measured on a real tree: the English word "this" in a
 * comment refused a plain function as a method, and `perms.global.includes(...)`
 * refused a whole file as touching the global object.
 *
 * THE DANGEROUS DIRECTION IS THE OTHER ONE, and it is why this returns null rather
 * than its best guess. A gate that stops firing does not print a wrong line — it LOADS
 * a file the gate exists to refuse, and loading runs top-level code. So a template
 * placeholder keeps its contents, string DELIMITERS survive so a following `/` is still
 * read as division, and anything unterminated gives up. The caller then reads raw
 * source and the refusal stands: uncertainty keeps the `look`, never spends it.
 */
export function stripNonCode(source, blankStrings = true) {
  const n = source.length;
  const stack = [{ kind: 'code', depth: 0 }];
  let out = '';
  let i = 0;
  const blankRun = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) out += source[k] === '\n' ? '\n' : ' ';
  };
  // A string BODY is blanked only when the caller is matching code. Comments are
  // blanked either way — a commented-out `require('fs')` does not execute.
  const emit = (from, to) => {
    if (blankStrings) blankRun(from, to);
    else out += source.slice(from, Math.min(to, n));
  };

  while (i < n) {
    const frame = stack[stack.length - 1];
    const ch = source[i];

    if (frame.kind === 'template') {
      if (ch === '\\') { emit(i, i + 2); i += 2; continue; }
      if (ch === '`') { out += ch; i += 1; stack.pop(); continue; }
      if (source.startsWith('${', i)) {
        out += '${';
        i += 2;
        stack.push({ kind: 'code', depth: 0 });
        continue;
      }
      emit(i, i + 1);
      i += 1;
      continue;
    }

    if (source.startsWith('//', i)) {
      const nl = source.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      blankRun(i, stop);
      i = stop;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      blankRun(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === ch) { closed = true; break; }
        j += 1;
      }
      if (!closed) return null;
      out += ch;
      emit(i + 1, j);
      out += ch;
      i = j + 1;
      continue;
    }
    if (ch === '`') { out += ch; i += 1; stack.push({ kind: 'template' }); continue; }
    if (ch === '{') { frame.depth += 1; out += ch; i += 1; continue; }
    if (ch === '}') {
      if (frame.depth === 0 && stack.length > 1) { out += ch; i += 1; stack.pop(); continue; }
      frame.depth = Math.max(0, frame.depth - 1);
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && startsRegex(out)) {
      const end = scanRegex(source, i);
      if (end !== -1) {
        out += '/';
        blankRun(i + 1, end - 1);
        out += '/';
        let j = end;
        while (j < n && /[a-z]/.test(source[j])) { out += source[j]; j += 1; }
        i = j;
        continue;
      }
      // It never closed on this line, so it was division after all. Ordinary code.
    }
    out += ch;
    i += 1;
  }
  if (stack.length !== 1) return null;
  return out;
}

/**
 * The first gate `source` trips, or null.
 *
 * A pattern must match the CODE, not the prose around it. When the stripper cannot
 * lex the file it returns null and the raw match stands — refusing something probeable
 * costs coverage and says so in the census; the other mistake loads it.
 */
function firstGate(patterns, source) {
  // Lexed only when a pattern actually matches the raw text, and at most once per
  // scope. A clean file trips nothing and is never scanned at all; this runs per file
  // AND per function, so doing it eagerly would lex a large module dozens of times.
  const cache = new Map();
  const cleaned = (scope) => {
    if (!cache.has(scope)) cache.set(scope, stripNonCode(source, scope === CODE));
    return cache.get(scope);
  };
  for (const [pattern, why, scope = CODE] of patterns) {
    if (!pattern.test(source)) continue;
    const text = cleaned(scope);
    if (text !== null && !pattern.test(text)) continue;
    return why;
  }
  return null;
}

/** Why this FILE may not be loaded at all, or null. */
export function fileRefusal(source) {
  return firstGate(IMPURE_SOURCE, source);
}

/**
 * How many parameters a function DECLARES, or null when the list cannot be read.
 *
 * NOT `fn.length`, and the difference is a wrong answer rather than a missing one.
 * `fn.length` stops counting at the first parameter with a default, so
 * `withDefault(a, b = 10)` reports 1. The ladder is then chosen for a one-argument
 * function, the second parameter never receives a value, and the function is probed
 * as something it is not — `withDefault` reported as answering the same question as a
 * genuinely one-argument `plainOne`, which is a finding a person has to read and
 * dismiss. The Python half reads the declared parameter list off the AST and probes
 * at 2, where the first rung already tells them apart, so this was also the two halves
 * disagreeing about one file.
 *
 * WHEN THE LIST CANNOT BE READ THIS REFUSES rather than falling back to `fn.length`.
 * A fallback would restore the wrong answer silently in exactly the cases the parser
 * found hardest; refusing costs coverage and says so in the census.
 */
export function declaredArity(source) {
  // Strings and comments blanked first: a default value like `x = ')'` or a comma
  // inside a comment would otherwise close the list early or add a parameter.
  const text = stripNonCode(source, true);
  if (text === null) return null;
  // `a => a + 1` declares one parameter and has no parentheses around it. Checked
  // before the scan below, which would otherwise find the first `(` in the BODY.
  if (/^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(text)) return 1;

  const open = text.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i += 1) {
    if ('(['.includes(text[i]) || text[i] === '{') depth += 1;
    else if (')]'.includes(text[i]) || text[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return null;

  // Split on commas at depth 0 only. A destructured parameter is ONE parameter, and
  // so is a default whose value is a call or an object literal full of commas.
  let count = 0;
  let current = '';
  depth = 0;
  for (const ch of text.slice(open + 1, close)) {
    if ('(['.includes(ch) || ch === '{') depth += 1;
    else if (')]'.includes(ch) || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (current.trim()) count += 1;
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) count += 1;
  return count;
}

/** Why this FUNCTION may not be probed, or null. `source` is fn.toString(). */
export function functionRefusal(source, arity) {
  if (arity === 0) return 'no arguments (a ladder cannot discriminate)';
  if (arity > MAX_ARITY) return `arity ${arity} (no ladder above ${MAX_ARITY})`;
  return firstGate(IMPURE_FUNCTION, source);
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
/** One settled value, rendered. The tail both callers below share. */
function outcomeOfValue(value) {
  const text = canon(value);
  if (text.length > REPR_INLINE) {
    return `V#${createHash('sha1').update(text).digest('hex')}`;
  }
  return `V:${text}`;
}

const threw = (err) => `E:${(err && err.name) || 'Error'}`;

/**
 * SYNCHRONOUS, and used only where the callee is known to be synchronous — the vacuous
 * functions in `projections`, which this module writes itself.
 *
 * It stays sync because `discriminating` and `compare` are sync and are called from
 * the reporting path. Making this await would turn both of them into promises and the
 * whole verdict path with them, for callees that cannot return one.
 */
export function outcomeOf(fn, args) {
  let value;
  try {
    value = fn(...args);
  } catch (err) {
    return threw(err);
  }
  if (value && typeof value.then === 'function') return 'E:AsyncResult';
  return outcomeOfValue(value);
}

/**
 * The outcome of a PROBED function, with a promise awaited to the value it settles on.
 *
 * WHY AWAIT AT ALL. `async function a(x) { return x * 2; }` and
 * `function b(x) { return Promise.resolve(x * 2); }` answer the same question. Reading
 * the promise object instead of the value it settles on made the first unprobeable and
 * gave the second `E:AsyncResult` on every rung — so a pair that IS the same function
 * either never met or was reported as differing, with a witness that says nothing about
 * either one. Awaiting is what makes the two comparable at all.
 *
 * A REJECTION IS THE SAME OUTCOME AS A THROW, by name and never by message, for the
 * reason messages are never compared anywhere else here: they carry the function's own
 * name, so comparing them would make every honest pair `differs`.
 *
 * A PROMISE THAT NEVER SETTLES IS BOUNDED PER RUNG, and an earlier version of this
 * comment was wrong about why it could not be. "There is no interrupt to deliver from
 * inside the process" is true of a synchronous loop, which never yields — and false of
 * a pending promise, where the event loop is free and a timer racing it is precisely
 * that interrupt. The rung becomes `E:TimeoutError`, an OUTCOME, the same one the
 * Python half's per-input `SIGALRM` produces. A synchronous hang is still the wall
 * clock's, and still a `look`, because there really is nothing to interrupt it with.
 */
export async function probeOutcome(fn, args, perInput = PER_INPUT_MS) {
  let value;
  let timer;
  try {
    value = fn(...args);
    if (value && typeof value.then === 'function') {
      // THE INTERRUPT THAT DOES EXIST. An earlier version of this comment claimed
      // there was none to deliver from inside the process. That is true of a
      // synchronous loop, which never yields, and false of a pending promise — the
      // event loop is free, so a timer racing it is exactly the interrupt. Without
      // this, one promise that never settles held a whole file to the wall clock.
      value = await Promise.race([value, new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const late = new Error('per-input limit');
          // Named to match what the Python half's SIGALRM raises, so one unsettled
          // rung reads the same in a vector whichever binary produced it.
          late.name = 'TimeoutError';
          reject(late);
        }, perInput);
      })]);
    }
  } catch (err) {
    return threw(err);
  } finally {
    // The loser of the race is not cancellable, but this timer is ours — leaving it
    // pending would keep the event loop alive on our own account.
    clearTimeout(timer);
  }
  return outcomeOfValue(value);
}

// --------------------------------------------------------------------------- //
// The decisions.
// --------------------------------------------------------------------------- //

/**
 * For each parameter, the vectors a function that does NOTHING WITH IT would give.
 *
 * Returning the argument is the obvious one. COPYING it is the same emptiness wearing
 * a different shape, and it was measured on a real tree: two unrelated query-param
 * transforms, one renaming keys and one splitting a `sort` value, agreed on every rung
 * because the ladder holds no key either of them recognises — so both degraded to
 * "copy the object through" and were reported as the same function. A spread is not
 * behaviour the ladder reached; it is behaviour the ladder missed.
 */
export function projections(inputs) {
  const parsed = inputs.map((src) => JSON.parse(src));
  const arity = parsed.length ? parsed[0].length : 0;
  const out = [];
  // The object copy only, not an array one. Rejecting too much costs a `look` rather
  // than a wrong finding, but it is still coverage spent; the measured defect was
  // object-to-object, so that is what this rejects.
  const vacuous = [
    (i) => (...a) => a[i],
    (i) => (...a) => ({ ...a[i] }),
  ];
  for (let i = 0; i < arity; i += 1) {
    for (const make of vacuous) {
      const fn = make(i);
      out.push(parsed.map((args) => outcomeOf(fn, args)));
    }
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
    // FOUR pipes, and the fourth is the whole point. Loading a module runs its
    // top-level code, and ordinary code announces itself — a dotenv banner was the one
    // that cost 58 files in a single directory of a real project. Sharing stdout
    // between the answer and whatever the module prints means the banner lands in
    // front of the JSON, the parse throws, and a diagnosis the child had ALREADY
    // COMPUTED (`could not load (JWT_SECRET must be set...)`) is replaced by silence.
    const child = spawn(process.execPath, [worker],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let answer = '';
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdio[ANSWER_FD].on('data', (d) => { answer += d; });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const said = () => {
        // Whatever the child managed to say, in the order it is likely to be useful.
        // `silent` is reachable only when it said nothing at all: a reason that names
        // nothing is a number reported without saying what produced it.
        const text = err.trim() || out.trim() || answer.trim();
        return (text.split('\n').pop() || 'silent').slice(0, 70);
      };
      // NDJSON, and a TRAILING PARTIAL LINE IS DROPPED rather than repaired. A child
      // killed mid-write leaves half an object; parsing what survives of it would be
      // inventing an answer, which is the one thing worse than not having one.
      const lines = answer.split('\n').filter((l) => l.trim());
      const messages = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          break;
        }
      }
      const failed = messages.find((m) => m.error);
      if (failed) { resolve({ error: failed.error }); return; }
      const roster = messages.find((m) => m.roster);
      if (!roster) { resolve({ error: `probe failed (${said()})` }); return; }

      // What arrived, plus a `look` for every name that did not. The child answers in
      // roster order, so the FIRST missing name is where it stopped and the rest were
      // never started — two different facts, and reporting them as one would say the
      // probe examined functions it never reached.
      const answered = new Map(
        messages.filter((m) => m.entry).map((m) => [m.entry.name, m.entry]),
      );
      const missing = roster.roster.filter((name) => !answered.has(name));
      const functions = roster.roster.map((name) => answered.get(name) || {
        name,
        skip: name === missing[0]
          ? `did not answer (killed at the ${timeout}ms wall timeout)`
          : `not reached: the probe was killed in ${missing[0]}`,
      });
      resolve({ functions });
    });
    const ladders = {};
    for (let arity = 1; arity <= MAX_ARITY; arity += 1) ladders[arity] = ladder(arity);
    child.stdin.end(JSON.stringify({ file, source, ladders }));
  });
}

/**
 * Reasons, counted, most common first.
 *
 * Descending by count, then code-point order — `sorted(key=lambda kv: (-kv[1],
 * kv[0]))` on the Python side. NOT `localeCompare`: ICU ignores punctuation and case
 * at primary strength, so the same census prints in a different order depending on
 * which half of the tool rendered it.
 */
function tally(reasons) {
  const counts = new Map();
  for (const why of reasons) {
    const key = why.split('(')[0].split(':')[0].trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export class Scan {
  constructor() {
    this.probed = new Map();      // ref -> vector
    this.keys = new Map();        // ref -> ladder key
    this.skipped = new Map();     // ref -> reason   (FUNCTIONS)
    this.unloadable = new Map();  // path -> reason  (FILES)
    this.groups = [];
    this.files = 0;
    this.functions = 0;
  }

  /** Reasons a FUNCTION was not probed. */
  census() { return tally(this.skipped.values()); }

  /**
   * Reasons a FILE was never loaded — a different population, kept apart on purpose.
   *
   * A refused file holds an unknown number of functions, and not loading it is exactly
   * why the number is unknown. Counting it among the functions made `probed + not
   * probed` stop equalling `functions`, with nothing on screen to say why: one run
   * read `146 files, 37 functions, 8 probed, 149 not probed`. Worse than the arithmetic
   * is what it hid — how much of the tree was never opened at all.
   */
  fileCensus() { return tally(this.unloadable.values()); }
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
      scan.unloadable.set(rel, why);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await probeFile(file, PROBE_TIMEOUT_MS, source);
    if (result.error) {
      scan.unloadable.set(rel, result.error);
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
  report.note(`\n${scan.files} files, ${scan.unloadable.size} not loaded`);
  for (const [why, count] of scan.fileCensus()) {
    report.note(`  ${why.padEnd(44)} ${count}`);
  }
  report.note(`${scan.functions} functions, ${scan.probed.size} probed, `
    + `${scan.skipped.size} not probed`);
  for (const [why, count] of scan.census()) {
    report.note(`  ${why.padEnd(44)} ${count}`);
  }
  report.note('  (a not-probed function is a `look`, never a finding — '
    + '"we found none" and "we never looked" are different claims)');
  return report;
}
