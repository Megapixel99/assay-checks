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
import { tmpdir } from 'node:os';
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
/**
 * The shape of an `assay probe` record, versioned apart from the tool. One half writes
 * it and the other reads it, which makes it a published interface with the same claim
 * on stability as the exit codes.
 */
export const PROBE_SCHEMA = 1;

/**
 * The shape of an `assay bundle` document, versioned APART from the record it carries,
 * because the two can move independently: adding a key to the envelope that holds many
 * records does not change what any one record means by `vector`, and a consumer that
 * only reads records should not be told its records expired.
 */
export const BUNDLE_SCHEMA = 1;
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
  // DYNAMIC IMPORT IS AN IMPORT. `await import('node:fs')` reads as ordinary code and
  // was refused by neither pattern above, so a file could reach the filesystem through
  // a spelling the gate did not know — no barrel required. The Python half has always
  // banned `__import__` by name, which is the same door; this is the two halves
  // agreeing again rather than a new rule.
  [new RegExp('\\bimport\\s*\\(\\s*[\'"](?:node:)?(?:' + CORE_MODULES + ')'),
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
function allGates(patterns, source) {
  // Lexed only when a pattern actually matches the raw text, and at most once per
  // scope. A clean file trips nothing and is never scanned at all; this runs per file
  // AND per function, so doing it eagerly would lex a large module dozens of times.
  const cache = new Map();
  const found = [];
  const cleaned = (scope) => {
    if (!cache.has(scope)) cache.set(scope, stripNonCode(source, scope === CODE));
    return cache.get(scope);
  };
  for (const [pattern, why, scope = CODE] of patterns) {
    if (!pattern.test(source)) continue;
    const text = cleaned(scope);
    if (text !== null && !pattern.test(text)) continue;
    // ONE ENTRY PER REASON, not per occurrence: two patterns can carry the same `why`,
    // and counting it twice would report the table's shape where a reader expects the
    // gate's.
    if (!found.includes(why)) found.push(why);
  }
  return found;
}

/** The FIRST gate `source` trips, or null. Reads the front of `allGates`. */
function firstGate(patterns, source) {
  const [first] = allGates(patterns, source);
  return first === undefined ? null : first;
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

/**
 * EVERY reason this FUNCTION may not be probed, in gate order. `[]` if none.
 *
 * `functionRefusal` answers with the FIRST one, because one refusal is enough to
 * REFUSE. This answers with all of them, because one is not enough to ACT ON — and the
 * difference is a wrong inference the census actively invites.
 *
 * THE CENSUS TALLIES ONE REASON PER FUNCTION, SO ITS BUCKETS ARE NOT INDEPENDENT. A
 * reader looking at `arity 4  14` reasonably concludes that raising the arity cap would
 * get fourteen more functions probed. Measured on a real tree, it gets none: those
 * fourteen moved into `needs docx`, `touches os` and `needs matplotlib`, the tally
 * changed, and the probed count did not move at all. Every one was already refused by a
 * second gate that the first one hid.
 */
export function functionRefusals(source, arity) {
  const found = [];
  if (arity === 0) found.push('no arguments (a ladder cannot discriminate)');
  if (arity > MAX_ARITY) found.push(`arity ${arity} (no ladder above ${MAX_ARITY})`);
  return [...found, ...allGates(IMPURE_FUNCTION, source)];
}

/**
 * Why this FUNCTION may not be probed, or null. `source` is fn.toString().
 *
 * ONE ENUMERATION, and this reads its front. A second list of gates kept in step with
 * `functionRefusals` by hand is the duplication this package exists to report, and the
 * way the two would drift is silent: the census would count a reason `why` never names.
 */
export function functionRefusal(source, arity) {
  const [first] = functionRefusals(source, arity);
  return first === undefined ? null : first;
}

/* -------------------------------------------------------------------------- *
 * REACHABILITY — what a function can REACH, not what its file happens to say.
 *
 * `fileRefusal` reads the whole file, so one `new Date()` in one body refuses every
 * function beside it. On a barrel of pure helpers that is the difference between a
 * useful run and a zero.
 *
 * The fix is NOT "gate the file on module scope and leave the function gate alone",
 * and the reason is written a few hundred lines below: `functionRefusal` reads a
 * function's own source and CANNOT SEE THE MODULE SCOPE ITS FREE NAMES RESOLVE IN. A
 * clean-looking `slugA(s) { return stamp(s); }` whose `stamp` calls `writeFileSync`
 * passes both gates once the file gate stops reading the whole file — and probing
 * CALLS it.
 *
 * So the gate is split by the question each half answers:
 *
 *   loadRefusal   may this module be IMPORTED?  — patterns over module-scope code
 *   reachRefusal  may this function be CALLED?  — patterns over its transitive closure
 *
 * The premise error worth naming, because it is easy to make twice: the gate guards
 * TWO events, not one. Import-time reachability is the right test for loading and the
 * wrong test for calling.
 * -------------------------------------------------------------------------- */

/**
 * Bracket depth at every index of already-lexed source.
 *
 * An opening bracket reports the depth it opens FROM and a closing one the depth it
 * returns TO, so a construct's own delimiters read as belonging to the level that
 * CONTAINS it. Every question here is "is this at module scope?", and that is the
 * reading which answers it.
 */
function depthMap(text) {
  const out = new Int32Array(text.length);
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '(' || ch === '[') { out[i] = depth; depth += 1; } else if (ch === '}' || ch === ')' || ch === ']') { depth -= 1; out[i] = depth; } else out[i] = depth;
  }
  return out;
}

const OPENERS = '{([';
const CLOSERS = '})]';

/** The index of the bracket closing the one at `open`, or -1 if it never closes. */
function matchBracket(text, open) {
  const want = CLOSERS[OPENERS.indexOf(text[open])];
  if (!want) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (OPENERS.includes(text[i])) depth += 1;
    else if (CLOSERS.includes(text[i])) {
      depth -= 1;
      if (depth === 0) return text[i] === want ? i : -1;
    }
  }
  return -1;
}

/** Index of the next `ch` at or after `from`, skipping whitespace only. */
function nextNonSpace(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

const DECL_KEYWORDS = ['function', 'class', 'const', 'let', 'var'];

/**
 * The word immediately before `at`, or '' — used to tell a DECLARATION from a mention.
 *
 * `export function f` and `export default function f` are declarations; `return
 * function () {}` and `= function () {}` are expressions that happen to contain the
 * same keyword, and treating them as top-level bindings would name something that has
 * no name to bind.
 */
function wordBefore(text, at) {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0) return '';
  if (!/[\w$]/.test(text[i])) return text[i];
  let k = i;
  while (k >= 0 && /[\w$]/.test(text[k])) k -= 1;
  return text.slice(k + 1, i + 1);
}

/**
 * Whether a keyword at `at` begins a statement.
 *
 * A NEWLINE IS A STATEMENT BOUNDARY, which is the half that a list of punctuation
 * misses. Semicolons are optional in JavaScript and a great deal of real code omits
 * them, and a file opening with a `'use strict'` directive puts a QUOTE in front of its
 * first declaration. Requiring `;` or `{` there found no top-level bindings at all in
 * two ordinary CommonJS packages — and a module with no bindings resolves no free
 * names, so every function in it was refused for reaching something the reader could
 * see three lines above it.
 *
 * Depth is checked by the caller, so a `function` inside a call's parentheses never
 * reaches here however it is laid out.
 */
function startsStatement(text, at) {
  let i = at - 1;
  let crossedLine = false;
  while (i >= 0 && /\s/.test(text[i])) {
    if (text[i] === '\n') crossedLine = true;
    i -= 1;
  }
  if (i < 0 || crossedLine) return true;
  if (text[i] === ';' || text[i] === '{' || text[i] === '}') return true;
  const word = wordBefore(text, at);
  return word === 'export' || word === 'default';
}

/**
 * Every top-level declaration in a lexed module: its name, its full span, and the span
 * of the part that only runs WHEN CALLED.
 *
 * `deferred` is the whole point and is deliberately narrow. A function DECLARATION's
 * body runs when called; so does the body of a function or arrow bound to a top-level
 * name. EVERYTHING ELSE KEEPS ITS TEXT, because everything else might run at import:
 * an IIFE, a callback handed to something invoked on the way in, a class field
 * initializer, a static block. Guessing wrong in that direction loads a file the gate
 * exists to refuse, so the narrow rule is the safe one — it costs coverage and says so.
 *
 * A class body is NOT deferred here for exactly that reason: `class A { x = readIt(); }`
 * runs `readIt` the moment the class is defined, which is import time.
 */
function topLevelDecls(text) {
  const depth = depthMap(text);
  const out = [];
  const word = /[A-Za-z_$][\w$]*/g;
  let m = word.exec(text);
  while (m !== null) {
    const kw = m[0];
    const at = m.index;
    if (DECL_KEYWORDS.includes(kw) && depth[at] === 0) {
      if (startsStatement(text, at)) {
        const decl = readDecl(text, at, kw);
        if (decl) {
          out.push(decl);
          word.lastIndex = decl.end;
          m = word.exec(text);
          continue;
        }
      }
    }
    m = word.exec(text);
  }
  return out;
}

/** One declaration starting at the keyword `at`, or null when it cannot be read. */
function readDecl(text, at, kw) {
  if (kw === 'function' || kw === 'class') {
    let i = nextNonSpace(text, at + kw.length);
    if (text[i] === '*') i = nextNonSpace(text, i + 1);          // generator
    const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (!name) return null;
    let brace = text.indexOf('{', i + name[0].length);
    if (kw === 'function') {
      const paren = text.indexOf('(', i + name[0].length);
      if (paren === -1) return null;
      const closeParen = matchBracket(text, paren);
      if (closeParen === -1) return null;
      brace = text.indexOf('{', closeParen);
    }
    if (brace === -1) return null;
    const close = matchBracket(text, brace);
    if (close === -1) return null;
    return {
      name: name[0],
      start: at,
      end: close + 1,
      // A CLASS BODY RUNS AT IMPORT — field initializers and static blocks — so only a
      // function's body is deferred.
      deferred: kw === 'function' ? [brace + 1, close] : null,
    };
  }
  // const | let | var
  const i = nextNonSpace(text, at + kw.length);
  const name = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
  // A DESTRUCTURING declaration binds names this does not attempt to read, so it is
  // refused rather than guessed at — see `moduleBindings`, which turns a null here into
  // a file it will not narrow.
  if (!name) return null;
  const end = statementEnd(text, i + name[0].length);
  const eq = text.indexOf('=', i + name[0].length);
  if (eq === -1 || eq > end) return { name: name[0], start: at, end, deferred: null };
  return {
    name: name[0], start: at, end, deferred: fnBodySpan(text, eq + 1, end),
  };
}

/**
 * Whether the function whose body closes at `close` is CALLED right there.
 *
 * `const x = function () { return Date.now(); }();` reads at import, and blanking that
 * body said the file was clean — the dangerous direction, because the answer is a file
 * the gate exists to refuse getting loaded. The wrapped spelling
 * `(function () { … })()` was already refused, but only because the parenthesised group
 * is not an arrow and the initializer scan gave up on it: correct by accident, in the
 * one place where an accident is a loaded module.
 */
function invoked(text, close) {
  return text[nextNonSpace(text, close + 1)] === '(';
}

/** The end of one object-literal property value: its `,` or the object's own `}`. */
function propertyEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === ',' && depth === 0) return i;
  }
  return text.length;
}

/**
 * Function bodies sitting in OBJECT-LITERAL property position, which only run when
 * called just as a declaration's does.
 *
 * `module.exports = { at: (v) => new Date(v), pure: (n) => n * 2 }` is how CommonJS
 * exposes a barrel, and nothing in it is a declaration keyword at depth 0 — so the
 * clock in one property refused the file and took every pure helper with it. That is
 * the same defect the load gate was written to fix, surviving in the shape most of a
 * CJS estate is written in.
 *
 * TWO KINDS ARE DELIBERATELY NOT DEFERRED.
 *
 *   * An IIFE. `{ x: (() => Date.now())() }` runs on the way in, and `fnBodySpan`
 *     refuses it: the parenthesised group is not followed by `=>`, and `invoked`
 *     catches the unwrapped spelling.
 *   * AN ACCESSOR. `{ get x() { … } }` runs when the property is READ, and
 *     `exportedFunctions` reads every export to enumerate it — so a getter body is
 *     reachable in a way an ordinary method's is not. It is excluded because the name
 *     must sit directly after `{` or `,`, and a getter's does not: `get` is in the way.
 *     That is a real guard rather than a coincidence, and there is a test that says so.
 *
 * `async` and generator properties are not deferred either, for want of the same
 * check — over-refusal, which costs coverage and says so in the census.
 */
function propertyBodies(text) {
  const out = [];
  const word = /[A-Za-z_$][\w$]*/g;
  let m = word.exec(text);
  while (m !== null) {
    const at = m.index;
    const prev = wordBefore(text, at);
    if (prev === '{' || prev === ',') {
      const after = nextNonSpace(text, at + m[0].length);
      if (text[after] === ':') {
        const span = fnBodySpan(text, after + 1, propertyEnd(text, after + 1));
        if (span) out.push(span);
      } else if (text[after] === '(') {
        // A shorthand method: `at(v) { … }`.
        const closeParen = matchBracket(text, after);
        const brace = closeParen === -1 ? -1 : nextNonSpace(text, closeParen + 1);
        if (brace !== -1 && text[brace] === '{') {
          const close = matchBracket(text, brace);
          if (close !== -1 && !invoked(text, close)) out.push([brace + 1, close]);
        }
      }
    }
    m = word.exec(text);
  }
  return out;
}

/**
 * The span of a function/arrow initializer's BODY, or null when the initializer is not
 * a function — in which case it is an expression that runs at import and keeps its text.
 */
function fnBodySpan(text, from, end) {
  let i = nextNonSpace(text, from);
  if (text.startsWith('async', i)) i = nextNonSpace(text, i + 5);
  if (text.startsWith('function', i)) {
    const paren = text.indexOf('(', i);
    if (paren === -1 || paren > end) return null;
    const closeParen = matchBracket(text, paren);
    if (closeParen === -1) return null;
    const brace = text.indexOf('{', closeParen);
    if (brace === -1 || brace > end) return null;
    const close = matchBracket(text, brace);
    if (close === -1) return null;
    return invoked(text, close) ? null : [brace + 1, close];
  }
  // An arrow. Its parameter list is either a parenthesised group or a single name, and
  // the body is everything after `=>` — braced or not. AN EXPRESSION BODY IS STILL
  // DEFERRED: `const f = (x) => impure(x)` runs `impure` when f is called, not on the
  // way in, which is the entire distinction this function exists to draw.
  let arrow = -1;
  if (text[i] === '(') {
    const closeParen = matchBracket(text, i);
    if (closeParen === -1) return null;
    const a = nextNonSpace(text, closeParen + 1);
    if (!text.startsWith('=>', a)) return null;
    arrow = a;
  } else {
    const single = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (!single) return null;
    const a = nextNonSpace(text, i + single[0].length);
    if (!text.startsWith('=>', a)) return null;
    arrow = a;
  }
  const b = nextNonSpace(text, arrow + 2);
  if (text[b] === '{') {
    const close = matchBracket(text, b);
    if (close === -1) return null;
    return invoked(text, close) ? null : [b + 1, close];
  }
  return [b, end];
}

/** The end of a statement starting mid-way at `from`: a depth-0 `;`, else a newline. */
function statementEnd(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (OPENERS.includes(ch)) depth += 1;
    else if (CLOSERS.includes(ch)) depth -= 1;
    else if (depth === 0 && ch === ';') return i;
    else if (depth === 0 && ch === '\n') {
      // A continuation line is still the same statement. Only a line that ENDS a
      // balanced expression can end one, which ASI already decided for the engine.
      const next = nextNonSpace(text, i);
      if (next >= text.length) return i;
      if (/[A-Za-z_$;}]/.test(text[next])) return i;
    }
  }
  return text.length;
}

/**
 * Globals a probed function may reach without the answer stopping being a function of
 * its arguments.
 *
 * DETERMINISM IS THE ONLY TEST. `Math` is here and `Math.random` is refused by
 * `IMPURE_SOURCE` a few lines up; `Date` is not here at all, for the same reason the
 * clock is gated. Anything absent is refused BY NAME rather than assumed pure, which is
 * the direction that costs coverage instead of spending a `look` — and the census then
 * says `free name Buffer` rather than probing something the ladder cannot control.
 *
 * The Python half already reports refusals in exactly these words (`free name Report`),
 * so this is the two halves converging on one vocabulary rather than a new one.
 */
const PURE_GLOBALS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Math', 'JSON',
  'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Function', 'Promise', 'Proxy', 'Reflect', 'ArrayBuffer', 'DataView', 'Int8Array',
  'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'Intl', 'escape', 'unescape', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  'structuredClone', 'NaN', 'Infinity', 'undefined', 'console',
  // Deterministic and side-effect-free, and each was measured refusing real code:
  // `qs` lost a helper to `free name URLSearchParams` alone.
  //
  // `Buffer` IS DELIBERATELY ABSENT despite looking like it belongs here.
  // `Buffer.from` is deterministic but `Buffer.allocUnsafe` hands back whatever was in
  // that memory, so the name does not answer the question the ladder asks — and the
  // allowlist is per NAME, not per method.
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
]);

/** Constructs whose parentheses are a CONDITION or a header, never a parameter list. */
const CONTROL_HEADS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/** Words that are syntax rather than references. */
const NOT_A_REFERENCE = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'async', 'get', 'set', 'as', 'from',
]);

/**
 * Every identifier a source REFERENCES and does not itself declare.
 *
 * Property positions are dropped — `x.writeFileSync` names a property of `x`, not a
 * binding — and so are object-literal KEYS, which are `{` or `,` then a name then `:`.
 * A ternary's `b` in `a ? b : c` is also a name followed by `:`, which is why the
 * preceding character is checked rather than the following one alone: dropping a real
 * reference is the direction that loses the gate, and this file only ever errs the
 * other way.
 */
function referencedNames(text) {
  const out = new Set();
  const word = /[A-Za-z_$][\w$]*/g;
  let m = word.exec(text);
  while (m !== null) {
    const at = m.index;
    const prev = wordBefore(text, at);
    const isProperty = prev === '.' || text.slice(Math.max(0, at - 2), at) === '?.';
    // `${` OPENS AN INTERPOLATION, and `$` is a legal identifier character, so the
    // dollar reads as a name of its own. `stripNonCode` keeps a template's substitutions
    // BECAUSE THEY ARE CODE — which is what makes this the one place they have to be
    // told apart from one.
    const isTemplateHole = m[0] === '$' && text[at + 1] === '{';
    // A REGEX LITERAL'S FLAGS SURVIVE THE LEXER — `stripNonCode` blanks the body and
    // keeps what follows the closing slash — so `/\+/g` ends in a bare `g` that reads
    // as a name. It is told from a division by looking BACK for the blanked body: an
    // opening `/` with nothing but blanks between the two is a literal, and `x / g` has
    // no second slash to find. Guessing from the letters alone would drop a real
    // reference named `g`, which is the direction this file never errs in.
    let isRegexFlags = false;
    if (text[at - 1] === '/' && /^[dgimsuvy]+$/.test(m[0])) {
      let j = at - 2;
      while (j >= 0 && text[j] === ' ') j -= 1;
      isRegexFlags = j >= 0 && text[j] === '/';
    }
    let isKey = false;
    if (!isProperty) {
      const after = nextNonSpace(text, at + m[0].length);
      if (text[after] === ':' && (prev === '{' || prev === ',')) isKey = true;
    }
    if (!isProperty && !isKey && !isTemplateHole && !isRegexFlags
        && !NOT_A_REFERENCE.has(m[0])) out.add(m[0]);
    m = word.exec(text);
  }
  return out;
}

/**
 * Every name a source DECLARES: parameters, locals, inner functions, catch bindings.
 *
 * EVERY PARAMETER LIST, not just the outer one. Reading only the first `(` was measured
 * against real code and lost three functions to names that were plainly bound:
 * `parameters.forEach((value, key) => ...)` reported `free name key`, and
 * `new Promise((resolve) => ...)` reported `free name resolve`. A callback's parameter
 * is as declared as the outer function's, and treating it as free refuses the ordinary
 * shape of every iteration helper in a codebase.
 */
function declaredNames(text) {
  const out = new Set();
  const addList = (open, close) => {
    // Destructuring included: every identifier in the list is bound by it, and a
    // default value's own references are picked up as free names anyway.
    for (const n of text.slice(open + 1, close).match(/[A-Za-z_$][\w$]*/g) || []) out.add(n);
  };
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '(') continue;
    const close = matchBracket(text, i);
    if (close === -1) continue;
    const after = nextNonSpace(text, close + 1);
    // A PARENTHESISED GROUP IS A PARAMETER LIST when an arrow or a body follows it.
    // `function f(a)`, a method `f(a)`, and `(a) =>` all read that way — and the word
    // before is the function's own NAME as often as it is `function`, which is why the
    // test is what FOLLOWS. `if (x) {` follows the same shape and binds nothing, so the
    // control keywords are named: they are the only constructs that borrow it.
    const arrow = text.startsWith('=>', after);
    const named = wordBefore(text, i);
    const body = text[after] === '{' && !CONTROL_HEADS.has(named);
    if (arrow || body) addList(i, close);
    // THE NAME IN FRONT OF A PARAMETER LIST IS A DEFINITION, not a reference to one.
    // A class body is the case that matters: `constructor(message) { ... }` is neither
    // a property access nor an object key, so it read as a free name and refused every
    // error class in a real package — five constructors, all of them ordinary.
    if (body && /^[A-Za-z_$][\w$]*$/.test(named)) out.add(named);
  }
  // `x => ...` binds `x` with no parentheses at all. Found from the arrow backwards,
  // because scanning forward from every index re-reads the whole tail each time.
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) {
    if (!/[\w$.)]/.test(text[m.index - 1] || '')) out.add(m[1]);
  }
  const binder = /\b(?:const|let|var|function|class|catch)\b\s*\*?\s*([({[]?)\s*([A-Za-z_$][\w$]*)/g;
  let m = binder.exec(text);
  while (m !== null) {
    out.add(m[2]);
    // `const { a, b } = ...` and `const [x, y] = ...` bind every name in the pattern.
    if (m[1]) {
      const at = text.indexOf(m[1], m.index);
      const close = matchBracket(text, at);
      if (close !== -1) {
        for (const n of text.slice(at + 1, close).match(/[A-Za-z_$][\w$]*/g) || []) out.add(n);
      }
    }
    m = binder.exec(text);
  }
  return out;
}

/**
 * A module's top-level shape: what each name is bound to, and which names came from
 * somewhere else. `null` when the source cannot be read, which every caller turns back
 * into today's whole-file answer.
 */
export function moduleBindings(source, id = '') {
  const text = stripNonCode(source, true);
  if (text === null) return null;
  const decls = topLevelDecls(text);
  const local = new Map();
  for (const d of decls) {
    // A NAME DECLARED TWICE IS NOT READ TWICE. Whichever span the call graph walks, it
    // may not be the one that runs, so the binding is poisoned rather than guessed.
    if (local.has(d.name)) local.set(d.name, null);
    else local.set(d.name, source.slice(d.start, d.end));
  }
  // NAME -> THE SPECIFIER IT CAME FROM, not merely "this came from elsewhere". A
  // caller that can reach the filesystem resolves the specifier and carries the walk
  // into that module; one that cannot refuses the name. Both are correct answers to
  // different questions, and only the first needs to know where to look.
  const imported = new Map();
  // THE SPECIFIER LIVES INSIDE A STRING, so this scan reads the lex that KEEPS string
  // contents — the same distinction `firstGate` draws between its CODE and SPECIFIER
  // scopes. Reading `text` here returned a specifier of blanks, every import resolved
  // to nothing, and the gate quietly fell back to refusing every imported name.
  const spec = stripNonCode(source, false) || text;
  for (const m of spec.matchAll(/\bimport\b([^;]*?)from\s*['"]([^'"]*)['"]/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) imported.set(n, m[2]);
  }
  for (const m of spec.matchAll(/\b(?:const|let|var)\s*([^=;]*)=\s*(?:await\s+)?(?:require|import)\s*\(\s*['"]([^'"]*)['"]/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) imported.set(n, m[2]);
  }
  return { id, local, imported, decls, bodies: propertyBodies(text), text };
}

/**
 * Module-scope source: the file with every DEFERRED body blanked, same length.
 *
 * Blanking in place rather than splicing keeps every index meaning what it meant, and
 * the gates that read string CONTENTS — a `require` specifier is inside quotes — get
 * the original bytes everywhere they were not blanked.
 */
function moduleScopeSource(source, mod) {
  const chars = [...source];
  const spans = mod.decls.filter((d) => d.deferred).map((d) => d.deferred);
  for (const span of spans.concat(mod.bodies)) {
    for (let i = span[0]; i < span[1] && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/**
 * Why this module may not be IMPORTED, or null.
 *
 * The question is what runs on the way in, so a body that only runs when CALLED is not
 * evidence about it. When the module cannot be read this is `fileRefusal` — the whole
 * file, exactly as before — because a file the parser lost the thread on is the last
 * one to narrow a gate around.
 */
export function loadRefusal(source) {
  const mod = moduleBindings(source);
  if (mod === null) return fileRefusal(source);
  return firstGate(IMPURE_SOURCE, moduleScopeSource(source, mod));
}

/**
 * Why CALLING this function may reach outside its arguments, or null.
 *
 * `functionRefusal` has already read the function's own body. This answers the question
 * that one cannot: what its free names resolve to. Taint only grows, so the walk
 * terminates on recursion and on cycles without a special case for either.
 */
/**
 * One link of a refusal chain, in a sentence a person can follow back to the code.
 *
 * EVERY HOP IS KEPT. The local branch used to return a nested reason unchanged when it
 * already began with `reaches`, which dropped the middle of the chain: `a` calling `b`
 * calling an impure `c` reported "reaches c", and a reader who opened `a` looking for
 * `c` did not find it there. The cross-module branch always prepended, so the same
 * walk was described two different ways depending on which side of a file it crossed.
 *
 * The grammar cases are the two reasons that are not verb phrases. "reaches giteaFor,
 * which free name Buffer" is what concatenation produces, and a census line nobody can
 * read is a reason reported without saying what produced it.
 */
function chain(name, why) {
  if (why.startsWith('free name ')) return `reaches ${name}, which has a ${why}`;
  if (why === 'source could not be read') return `reaches ${name}, whose source could not be read`;
  return `reaches ${name}, which ${why}`;
}

export function reachRefusal(fnSource, mod, resolve = null, seen = new Set()) {
  const text = stripNonCode(fnSource, true);
  if (text === null) return 'source could not be read';
  const declared = declaredNames(text);
  for (const name of [...referencedNames(text)].sort()) {
    const key = `${mod.id || ''}::${name}`;
    if (declared.has(name) || PURE_GLOBALS.has(name) || seen.has(key)) continue;
    if (mod.imported.has(name)) {
      // AN IMPORT IS FOLLOWED WHEN IT CAN BE, and refused when it cannot. Refusing
      // every imported name was measured on real code and is not a conservative choice
      // so much as an empty one: 73 of 90 refusals in one package were names like
      // `CLIENT_INFO_SEPARATOR` — constants, imported, and perfectly deterministic.
      // A `resolve` that comes back null is a specifier this caller could not or would
      // not open — a bare package, a core module, an unreadable path — and that is
      // still a refusal.
      const from = resolve && resolve(mod.imported.get(name), mod.id);
      if (!from) return `free name ${name} comes from another module`;
      if (from.refusal) return `reaches ${name}, in a module that ${from.refusal}`;
      const bound = from.mod.local.get(name);
      if (bound === undefined) return `free name ${name} comes from another module`;
      if (bound === null) return `free name ${name} is declared more than once`;
      seen.add(key);
      const across = firstGate(IMPURE_SOURCE, bound)
        || reachRefusal(bound, from.mod, resolve, seen);
      if (across) return chain(name, across);
      continue;
    }
    if (!mod.local.has(name)) return `free name ${name}`;
    const bound = mod.local.get(name);
    if (bound === null) return `free name ${name} is declared more than once`;
    seen.add(key);
    // IMPURE_SOURCE, NOT IMPURE_FUNCTION, and the difference is a wrong answer rather
    // than a stricter one. `IMPURE_FUNCTION` adds three rules — generator, `this`, rest
    // parameters — that answer "may THIS function be probed", which is not a question
    // about anything it merely REACHES. A class whose constructor assigns `this.code`
    // is an ordinary class, and gating a reached binding with the probe's own
    // eligibility rules refused five error constructors here for being unprobeable
    // rather than for reaching outside their arguments.
    const direct = firstGate(IMPURE_SOURCE, bound)
      || reachRefusal(bound, mod, resolve, seen);
    if (direct) return chain(name, direct);
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

// --------------------------------------------------------------------------- //
// THE CROSS LADDER, and the outcome INTERLINGUA.
//
// `assay cross` compares a JavaScript function to a Python one, and two things have to
// be true before that means anything.
//
// 1. THE TWO LADDERS MUST HOLD IDENTICAL VALUES, not merely identically-versioned
//    ones. `BASE_VALUES` cannot: Python has a tuple and JavaScript does not, `None` and
//    `null` are written differently, and the two lists are hand-kept in step by a test
//    that compares SHAPES because comparing lengths would fail for a correct reason. A
//    shape check is enough for two runs of one language and nothing like enough here.
//
//    So the cross ladder is ONE JSON DOCUMENT, carried verbatim by both halves and
//    parsed by each. `test_parity.py` compares the two texts, so the VALUES are
//    identical by construction rather than by inspection — and the rungs' digest goes
//    into the ladder key, so a comparison across a changed ladder is refused by the
//    same branch that already refuses a mismatched arity.
//
// 2. THE OUTCOMES MUST BE COMPARABLE. The README's own example prints `V:False` on one
//    side and `V:false` on the other, which is not a disagreement about behaviour: it
//    is two spellings of one answer. `crossRender` renders a value as canonical JSON,
//    so both spellings become `true`/`false` and both absences become `null`.
// --------------------------------------------------------------------------- //

// ONE DOCUMENT, BYTE FOR BYTE. Both halves carry this text and `test_parity.py`
// compares them; nothing here is a value one language wrote down and the other tried
// to match.
export const CROSS_VALUES_JSON = '[0, 1, 2, -1, 7, 255, 3.5, -0.5, true, false, null, "", "a", "abc", '
  + '"Hello, World!", "ATTACK AT DAWN, at dawn!", "  padded  ", "10", "aeiou", '
  + '"\\u00bd", "\\u00e9", "\\t\\n", [], [1, 2, 3], [3, 1, 2], ["a", "b"], {}, '
  + '{"a": 1}, {"a": 1, "b": 2}]';

export const CROSS_VALUES = JSON.parse(CROSS_VALUES_JSON);

/**
 * The argument lists for `arity`, as VALUES. The same stride walk `ladder` uses.
 *
 * It returns parsed values rather than source strings because the two languages have
 * no shared source syntax — which is the whole reason this ladder exists.
 */
export function crossLadder(arity) {
  if (arity === 1) return CROSS_VALUES.map((v) => [v]);
  const n = CROSS_VALUES.length;
  const combos = [];
  for (let i = 0; i < MAX_PAIRS_PER_INPUT; i += 1) {
    const idx = [];
    for (let k = 0; k < arity; k += 1) idx.push((i * (k + 1) + k * 5) % n);
    combos.push(idx.map((j) => CROSS_VALUES[j]));
  }
  for (let i = 0; i < n; i += 1) {
    combos.push(new Array(arity).fill(CROSS_VALUES[i]));
  }
  const seen = new Set();
  const out = [];
  for (const combo of combos) {
    const key = JSON.stringify(combo);
    if (!seen.has(key)) { seen.add(key); out.push(combo); }
  }
  return out;
}

/**
 * What makes two CROSS vectors comparable, and it carries a digest of the rungs.
 *
 * `arity1/v3` says two vectors came from ladders with the same NAME. Across two
 * languages that is not enough — the whole hazard is two lists that were meant to hold
 * the same values and quietly stopped. The digest is over the rungs themselves, so a
 * ladder that changed by one character produces a different key and `compareCross`
 * refuses the pair through the branch that already refuses a mismatched arity.
 */
export function crossKey(arity) {
  const rungs = JSON.stringify(crossLadder(arity));
  const digest = createHash('sha1').update(rungs).digest('hex').slice(0, 12);
  return `cross${arity}/${LADDER_VERSION}/${digest}`;
}

/**
 * A value in the interlingua, or null if it cannot be said in both languages.
 *
 * JSON IS THE VOCABULARY, and the boundary is drawn where JSON's is because that is
 * the only notation both languages already agree on. Everything inside it renders
 * canonically — object keys sorted, no incidental whitespace — so two implementations
 * differing only in insertion order are not reported as differing.
 *
 * THE LOSSY MAPPINGS ARE THE INTERESTING PART, and each one is a deliberate choice
 * about which mistake to make:
 *
 *   * A Python `int` and a Python `float` of the same value render alike, because
 *     JavaScript has ONE number type. Refusing to merge them would make every
 *     arithmetic function differ across the boundary for a reason internal to one
 *     language.
 *   * `undefined` and `null` both become `null`. Python has one absence and JavaScript
 *     has two, so the interlingua carries the one both can state. It merges, and
 *     merging can only ever produce a `same` — which is the verdict that FAILS here —
 *     so it is the direction that needs saying out loud: a JavaScript function
 *     returning `undefined` where a Python one returns `None` is treated as agreement,
 *     and that is a judgment rather than a measurement.
 *   * A Python `tuple` renders as an array. JavaScript has no tuple, and a function
 *     that returns one is answering the question an array answers here.
 *
 * NaN and the infinities are spelled out because JSON cannot hold them and
 * `JSON.stringify` turns all three into `null` — three different answers reported as
 * one absence.
 *
 * Anything else — a Map, a Set, a class instance, a function, a symbol, a BigInt —
 * returns null, and the caller turns that into an outcome that makes the whole
 * comparison a `look`. Rendering it approximately would be inventing a fact about a
 * value this cannot read.
 */
export function crossRender(value, depth = 0) {
  if (depth > 6) return '...';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    // `-0` is `0` here: Python's `-0.0` and `0.0` compare equal and print differently,
    // and a sign on a zero is not an answer either language gives on purpose.
    if (Object.is(value, -0)) return '0';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map((v) => crossRender(v, depth + 1));
    return parts.some((p) => p === null) ? null : `[${parts.join(',')}]`;
  }
  // A PLAIN OBJECT ONLY. A Map, a Set, a Date or a class instance is not something
  // Python has the same way, and `JSON.stringify` would flatten several of them into
  // `{}` — one answer standing in for four.
  const proto = Object.getPrototypeOf(value);
  if (typeof value !== 'object' || (proto !== Object.prototype && proto !== null)) {
    return null;
  }
  const pairs = [];
  for (const key of Object.keys(value).sort()) {
    const rendered = crossRender(value[key], depth + 1);
    if (rendered === null) return null;
    pairs.push(`${JSON.stringify(key)}:${rendered}`);
  }
  return `{${pairs.join(',')}}`;
}

/** The kind of a value the interlingua cannot state, for the `X:` outcome. */
function kindOf(value) {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return (value.constructor && value.constructor.name) || 'object';
}

/**
 * 'V:<interlingua>' | 'X:<kind>' | 'E:*'. One rung of a CROSS vector.
 *
 * A THROW CARRIES NO NAME, and that is the load-bearing decision. The two languages'
 * error taxonomies genuinely diverge — `d['x']` is a `KeyError` in Python and
 * `undefined` here — so naming them would make every honest pair `differs`. Declaring
 * them equal is worse: `same` is the verdict that FAILS here, so a wrong equality
 * manufactures findings.
 *
 * `compareCross` therefore MASKS a rung where both sides threw: it tells you nothing.
 * A rung where one threw and the other answered stays a witness, and it is the most
 * interesting kind there is.
 *
 * `X:` is an outcome the interlingua cannot say. It is not compared; it makes the pair
 * a `look`, because a value this cannot read is one it must not pronounce on.
 */
export async function crossOutcome(fn, args, perInput = PER_INPUT_MS) {
  let value;
  let timer;
  try {
    value = fn(...args);
    if (value && typeof value.then === 'function') {
      value = await Promise.race([value, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('per-input limit')), perInput);
      })]);
    }
  } catch {
    return 'E:*';
  } finally {
    clearTimeout(timer);
  }
  const text = crossRender(value);
  if (text === null) return `X:${kindOf(value)}`;
  if (text.length > REPR_INLINE) {
    return `V#${createHash('sha1').update(text).digest('hex')}`;
  }
  return `V:${text}`;
}

/**
 * The vectors a function that does NOTHING with its arguments would give.
 *
 * DEFINED ON THE DATA, not by either language's semantics, and that is what makes it
 * the same guard on both sides. `dict(x)` raises for an int in Python while `{...x}`
 * answers `{}` here, so mirroring "what the language does" would give the two halves
 * different vacuity guards for one ladder. The rule here is the interlingua's own:
 * hand the argument back, or copy it through when it is an object and refuse
 * otherwise.
 */
export function crossProjections(rungs) {
  if (!rungs.length) return [];
  const arity = rungs[0].length;
  const out = [];
  for (let i = 0; i < arity; i += 1) {
    const identity = [];
    const copied = [];
    for (const args of rungs) {
      const value = args[i];
      identity.push(`V:${crossRender(value)}`);
      const isObject = value !== null && typeof value === 'object'
        && !Array.isArray(value);
      copied.push(isObject ? `V:${crossRender({ ...value })}` : 'E:*');
    }
    out.push(identity);
    out.push(copied);
  }
  return out;
}

/**
 * Did this ladder tell this function apart from a constant? (counts, or null.)
 *
 * The same two guards `discriminating` applies, over the interlingua. `E:*` rungs are
 * not returned values, for the reason they are not there either: one return plus one
 * throw is two distinct OUTCOMES and rewards a probe that found the function's type
 * errors and never reached its behaviour.
 */
export function crossDiscriminating(vector, rungs) {
  const returned = vector.filter((o) => !o.startsWith('E:'));
  if (new Set(returned).size < MIN_DISTINCT) return null;
  const live = [];
  vector.forEach((o, i) => { if (!o.startsWith('E:')) live.push(i); });
  for (const proj of crossProjections(rungs)) {
    if (live.length && live.every((i) => vector[i] === proj[i])) return null;
  }
  return { returned: returned.length, distinct: new Set(returned).size };
}

/**
 * ['same'|'differs'|'look', detail] across the language boundary.
 *
 * A RUNG WHERE BOTH SIDES THREW IS MASKED, AND THERE IS NO BRANCH FOR IT. A throw
 * carries no name here, so both sides render one as the same `E:*` and two of them can
 * never be a witness; `crossDiscriminating` counts only RETURNED values, so two of them
 * can never be evidence either. The masking is real and it lives in the rendering
 * rather than here — a branch would be a second statement of it, and one that says
 * nothing.
 *
 * That is worth writing down because the earlier version DID have the branch, with a
 * comment explaining what it did, and a mutation that removed it changed nothing: the
 * guard and its absence produced the same observable, which is precisely the failure
 * this package exists to report.
 *
 * A RUNG WHERE ONE THREW AND THE OTHER ANSWERED IS A WITNESS, and it is the most
 * interesting one there is: one implementation has a case the other does not.
 */
export function compareCross(aVec, bVec, aKey, bKey, rungs) {
  if (aKey !== bKey) return ['look', `not comparable: ${aKey} vs ${bKey}`];
  if (aVec.length !== bVec.length || aVec.length !== rungs.length) {
    return ['look', 'vector length disagrees with the ladder'];
  }
  for (let i = 0; i < aVec.length; i += 1) {
    const [x, y] = [aVec[i], bVec[i]];
    if (x.startsWith('X:') || y.startsWith('X:')) {
      return ['look', 'an outcome the interlingua cannot state: '
        + `${JSON.stringify(rungs[i])} -> ${x} vs ${y}`];
    }
    if (x !== y) {
      return ['differs', `${JSON.stringify(rungs[i])} -> ${x} vs ${y}`];
    }
  }
  if (crossDiscriminating(aVec, rungs) === null) {
    return ['look', 'not discriminated by the ladder'];
  }
  return ['same', `no input in ${rungs.length} told them apart`];
}

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

/**
 * Why this ladder did not tell this function apart, or null if it did.
 *
 * `discriminating()` answers yes or no, because yes or no is all a scan needs: the
 * census counts one reason and moves on. Somebody who expected a PARTICULAR function
 * to be probed needs the other thing — which of the two guards refused it, since a
 * constant and a projection are different problems with different answers.
 *
 * IT DOES NOT NAME WHICH ARGUMENT a projection handed back. Doing so would need a
 * second copy of the vacuous table beside `projections()`, kept in step by hand, and
 * two tables that must agree is the exact duplication this package exists to report.
 * The shape is named; the index is left to the reader, who has the function open.
 */
export function discriminationDetail(vector, inputs, mode = 'native') {
  // `mode === 'cross'` asks the same question of the SHARED ladder, and it is the same
  // three answers because the two vocabularies agree on the two things this reads: a
  // throw is `E:` on both sides, and a returned value is anything else. What changes is
  // the DECIDER — `crossDiscriminating` and the interlingua's own projections — and it
  // changes in one place, because the whole point of the last branch below is that it
  // deduces rather than re-decides. A second copy for the cross ladder would be a
  // second decider, and two deciders that can disagree is the shape of defect this
  // package exists to report.
  const decide = mode === 'cross' ? crossDiscriminating : discriminating;
  if (decide(vector, inputs) !== null) return null;
  const answered = vector.filter((o) => o.slice(0, 2) !== 'E:');
  if (!answered.length) {
    return `it threw on all ${vector.length} rungs — the ladder reached its type `
      + 'errors and never its behaviour';
  }
  const seen = new Set(answered).size;
  if (seen < MIN_DISTINCT) {
    return `${seen} distinct returned value across the ${answered.length} rungs `
      + `that answered, and ${MIN_DISTINCT} is the minimum — as far as this ladder `
      + 'can see it is a constant';
  }
  // THE LAST BRANCH IS DEDUCED, not re-decided. `discriminating` already said no and
  // the two counting branches above did not explain it, so the projection guard is
  // what refused this vector. Asking `isProjection` again would be a SECOND decider
  // for one question, and two deciders that can disagree is the shape of defect this
  // package exists to report.
  return 'a projection: everywhere it answered it did nothing with its arguments '
    + '— handed one back, or copied one through';
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

/**
 * Probe every exported function of one file, in a child process.
 *
 * `cross` swaps the native ladder for the shared one and the native rendering for the
 * interlingua — see `crossOutcome`. It is the same child doing the same gating; only
 * what goes in and what comes out change.
 */
export function probeFile(file, timeout = PROBE_TIMEOUT_MS, gated = null, cross = false,
  perInput = PER_INPUT_MS) {
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
    // CWD IS NOT THE REPOSITORY, and this is containment rather than tidiness. Every
    // gate here is best-effort — `functionRefusal` reads a function's own source and
    // cannot see the module scope its free names resolve in — so the question is not
    // only what gets refused but where the damage lands when something is not. A
    // probed function calling `writeFileSync('a', ...)` writes to the child's cwd, and
    // inheriting ours put the ladder's string rungs in the repository root as real
    // files. The child resolves every path it uses absolutely, so it needs no
    // particular cwd; giving it a scratch one costs nothing and bounds the blast.
    const child = spawn(process.execPath, [worker],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], cwd: tmpdir() });
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
    for (let arity = 1; arity <= MAX_ARITY; arity += 1) {
      ladders[arity] = cross ? crossLadder(arity) : ladder(arity);
    }
    // `perInput` TRAVELS WITH THE REQUEST rather than being read from this module by
    // the child, which is what the Python half already does with `per_input`. The child
    // is a separate process and imports its own copy of these constants, so a caller
    // that shortens the budget here would otherwise be shortening it only for itself.
    child.stdin.end(JSON.stringify({
      file, source, ladders, cross, perInput,
    }));
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
    this.arity = new Map();       // ref -> declared parameter count
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

  /**
   * The census as data, so a consumer never has to parse the printed equation.
   *
   * `probed + not_probed` equals `functions`, and FILES ARE A SEPARATE POPULATION: a
   * file nobody opened holds an unknown number of functions, so adding the two totals
   * together prints a number nobody measured. Both halves are here with their own
   * totals, which is what makes that checkable rather than merely stated.
   *
   * THE TALLIES ANSWER "HOW MANY" AND CANNOT ANSWER "WHICH", so the maps travel beside
   * them. `could not load 12` names nothing a person can open, and the only recourse
   * the tool offers is `assay why FILE::NAME` — which has to be told a file and a
   * function name in it, the two things the tally just withheld. A census that reports
   * how much it never looked at, and then refuses to say where, stops one step short
   * of the claim it exists to make.
   *
   * THE MAPS CARRY THE WHOLE REASON, and for the load errors that is the entire point.
   * `tally` keys on `why.split('(')[0].split(':')[0]` so that one bucket counts every
   * spelling of a failure — and a load error's message begins at exactly that `(`.
   * `could not load (JWT_SECRET must be set)` is a diagnosis the child ALREADY
   * COMPUTED and the tally then truncates away; the largest bucket in a real run is
   * the one whose contents were most worth reading.
   *
   * Neither map is sorted here. `renderJson` sorts the payload all the way down and
   * Python's `json.dump` is asked to sort, so ordering them again would be a second
   * place for the two halves to disagree about one document.
   */
  toDict() {
    return {
      files: this.files,
      unloadable: Object.fromEntries(this.fileCensus()),
      unloadable_paths: Object.fromEntries(this.unloadable),
      functions: this.functions,
      probed: this.probed.size,
      not_probed: this.skipped.size,
      skipped: Object.fromEntries(this.census()),
      skipped_refs: Object.fromEntries(this.skipped),
    };
  }
}

export const UNSTATEABLE = 'an outcome the interlingua cannot state';

/**
 * `{ key }` if this vector may be bucketed, else `{ why }` it may not.
 *
 * ONE PLACE DECIDES WHAT IS COMPARABLE, and for the cross ladder that is not a
 * convenience. `compareCross` refuses a pair three ways — an `X:` rung, a key
 * mismatch, an undiscriminated vector — and a bucketing scan that filtered on fewer of
 * them would call two functions `same` that the pairwise command, asked about the same
 * two, calls `look`. Two answers to one question, and the weaker one is the one that
 * prints a finding.
 */
export function admit(vector, arity, cross) {
  if (cross) {
    if (vector.some((o) => o.startsWith('X:'))) return { why: UNSTATEABLE };
    if (crossDiscriminating(vector, crossLadder(arity)) === null) {
      return { why: 'not discriminated by the ladder' };
    }
    return { key: crossKey(arity) };
  }
  if (discriminating(vector, ladder(arity)) === null) {
    return { why: 'not discriminated by the ladder' };
  }
  return { key: ladderKey(arity) };
}

/**
 * Probe every function under `targets`. Returns a Scan.
 *
 * `cross` walks the SHARED ladder and renders the interlingua, which is what makes one
 * tree's Scan comparable with the other half's. Same gate, same child, same census —
 * only the rungs and the rendering change, so a function this half refuses is refused
 * for the same reason either way.
 */
export async function collect(targets, scan = new Scan(), cross = false) {
  for (const file of jsFiles(targets)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scan.files += 1;
    const rel = displayPath(file);
    // THE LOAD GATE, WHICH IS NOT THE CALL GATE. What runs on the way in decides
    // whether this module may be imported; whether any given function may be CALLED is
    // `reachRefusal`, applied per function in the child that holds it.
    const why = loadRefusal(source);
    if (why) {
      // A refused FILE is counted once with its reason rather than silently dropped:
      // a census that omits what it never looked at reads exactly like a clean sweep.
      scan.unloadable.set(rel, why);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await probeFile(file, PROBE_TIMEOUT_MS, source, cross);
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
      const admitted = admit(entry.vector, entry.arity, cross);
      if (admitted.key === undefined) {
        scan.skipped.set(ref, admitted.why);
        continue;
      }
      scan.probed.set(ref, entry.vector);
      scan.keys.set(ref, admitted.key);
      scan.arity.set(ref, entry.arity);
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
  return reportCensus(scan.toDict(), report);
}

/**
 * The two populations, rendered from the census DATA rather than from a Scan.
 *
 * `assay sweep` reads the OTHER half's census out of a bundle and has no Scan to
 * render it from. A second renderer for that would be a second place describing one
 * population, and the two would drift exactly the way two hand-kept lists drift — so
 * the renderer is defined over the data both paths already carry.
 *
 * THE TALLIES ARE RE-SORTED HERE and that is not redundant. A live Scan tallies
 * largest-bucket-first, which is the order worth reading; a bundle's census has been
 * through JSON with its keys sorted, so the same data arrives alphabetical. Trusting
 * the incoming order would print one population by size and the other by spelling, for
 * no reason a reader could see.
 */
export function reportCensus(census, report = new Report(), label = '') {
  const head = label ? `${label} ` : '';
  const ranked = (counts) => Object.entries(counts)
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  report.note(`\n${head}${census.files} files, `
    + `${Object.keys(census.unloadable_paths).length} not loaded`);
  for (const [why, count] of ranked(census.unloadable)) {
    report.note(`  ${why.padEnd(44)} ${count}`);
  }
  report.note(`${head}${census.functions} functions, ${census.probed} probed, `
    + `${census.not_probed} not probed`);
  for (const [why, count] of ranked(census.skipped)) {
    report.note(`  ${why.padEnd(44)} ${count}`);
  }
  report.note('  (a not-probed function is a `look`, never a finding — '
    + '"we found none" and "we never looked" are different claims)');
  return report;
}
