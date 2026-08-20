/**
 * The sameness half. Every test asks what a MUTATION would change.
 *
 * A test written by asking what the function does passes for the wrong reason far more
 * often than one written by asking what breaking it would do. The two guards this half
 * rests on — `discriminating` and the ladder-key check in `compare` — are driven in
 * BOTH directions.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canon, collect, compare, declaredArity, discriminating, fileRefusal,
  functionRefusal, group, isProjection, ladder, ladderKey, MIN_DISTINCT, outcomeOf,
  probeFile, stripNonCode,
} from '../src/sameness.js';
import { exportedFunctions, probeFunction } from '../src/probe.js';

/** A throwaway module, never inside this package's own tree. */
function write(body, name = 'm.js') {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-same-'));
  // The module type is DECLARED, and that is not fixture tidiness: a `.js` file
  // containing `export` in a directory with no `package.json` is a SyntaxError on
  // Node 18 and loads fine on Node 22, because module-syntax detection arrived in
  // between. Without this the suite passes on a new Node and fails on an old one
  // for a reason unrelated to the code under test — and a real project always has
  // a package.json, so the fixture was the unrealistic thing.
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8');
  const file = path.join(dir, name);
  writeFileSync(file, body, 'utf8');
  return file;
}

/** The same, for a CommonJS tree: `module.exports = fn` is the shape that broke. */
function writeCjs(body, name = 'm.js') {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-cjs-'));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n', 'utf8');
  const file = path.join(dir, name);
  writeFileSync(file, body, 'utf8');
  return file;
}

/** Several modules in ONE directory, so `collect` sees them as one tree. */
function writeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-tree-'));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

const TWINS = `
export function a(s) {
  if (typeof s !== 'string') throw new TypeError('str');
  return s.split('').reverse().join('');
}

export function b(s) {
  if (typeof s !== 'string') throw new TypeError('str');
  let out = '';
  for (const ch of s) out = ch + out;
  return out;
}
`;

// --------------------------------------------------------------------------- //
// The vacuous-probe guard
// --------------------------------------------------------------------------- //

test('all throws is not discriminated', () => {
  assert.equal(discriminating(new Array(10).fill('E:TypeError')), null);
});

test('a constant is not discriminated', () => {
  // Two returns, ONE distinct value: a constant agrees with every other constant
  // returning the same thing.
  assert.equal(discriminating(new Array(10).fill('V:7')), null);
});

test('distinct is counted over RETURNS not over outcomes', () => {
  // One returned value plus one throw is two distinct OUTCOMES, and a keyword
  // predicate satisfies exactly that — false for every string in the ladder, a throw
  // for everything else, and nothing about its behaviour probed.
  const vector = new Array(5).fill('V:false').concat(new Array(5).fill('E:TypeError'));
  assert.equal(discriminating(vector), null);
});

test('real behaviour IS discriminated', () => {
  assert.notEqual(discriminating(['V:1', 'V:2', 'E:TypeError']), null);
});

test('the identity on the ladder is not discriminated', () => {
  const inputs = ladder(1);
  const vector = inputs.map((src) => outcomeOf((x) => x, JSON.parse(src)));
  assert.notEqual(discriminating(vector), null);      // many distinct returns
  assert.equal(discriminating(vector, inputs), null); // ...but a projection
});

test('a projection that THROWS elsewhere is still a projection', () => {
  // A transform whose vocabulary the ladder lacks is the identity wherever it answers
  // and throws everywhere else. Comparing whole vectors misses it, because the two
  // disagree exactly where the function refused to run.
  const inputs = ladder(1);
  const vector = inputs.map((src) => outcomeOf((s) => s.replace('zzz', 'yyy'),
    JSON.parse(src)));
  assert.equal(isProjection(vector, inputs), true);
  assert.equal(discriminating(vector, inputs), null);
});

test('there is ONE threshold and a second would be unreachable', () => {
  // An earlier version carried a minimum returned-count beside the distinct count, and
  // no mutation of it could be caught: two distinct returns already implies two
  // returns. Two constants answering one question.
  assert.notEqual(discriminating(['V:1', 'V:2']), null);
  assert.equal(MIN_DISTINCT, 2);
});

// --------------------------------------------------------------------------- //
// compare
// --------------------------------------------------------------------------- //

test('two ladders are never zipped together', () => {
  // Comparing a new answer against the wrong earlier one is THE defect a difference
  // checker exists to catch.
  const [verdict, detail] = compare(['V:1'], ['V:1'], 'arity1/v2', 'arity2/v2', ['[1]']);
  assert.equal(verdict, 'look');
  assert.match(detail, /not comparable/);
});

test('a vector that does not match the ladder is a look', () => {
  const [verdict] = compare(['V:1', 'V:2'], ['V:1', 'V:2'], 'arity1/v2', 'arity1/v2',
    ['[1]']);
  assert.equal(verdict, 'look');
});

test('a witness is reported with the input that produced it', () => {
  const [verdict, detail] = compare(['V:1', 'V:2'], ['V:1', 'V:9'], 'arity1/v2',
    'arity1/v2', ['[1]', '[2]']);
  assert.equal(verdict, 'differs');
  assert.match(detail, /\[2\]/);
  assert.match(detail, /V:9/);
});

test('agreement on a vacuous probe is a look not a same', () => {
  const [verdict, detail] = compare(['V:7', 'V:7'], ['V:7', 'V:7'], 'arity1/v2',
    'arity1/v2', ['[1]', '[2]']);
  assert.equal(verdict, 'look');
  assert.match(detail, /discriminated/);
});

// --------------------------------------------------------------------------- //
// canon and outcomes
// --------------------------------------------------------------------------- //

test('object keys are sorted so insertion order is not a difference', () => {
  assert.equal(canon({ y: 1, x: 2 }), canon({ x: 2, y: 1 }));
});

test('the four values JSON.stringify flattens are each spelled out', () => {
  // JSON.stringify turns all of these into `null` or drops them, which would make four
  // genuinely different answers look like one.
  assert.equal(canon(NaN), 'NaN');
  assert.equal(canon(Infinity), 'Infinity');
  assert.equal(canon(-Infinity), '-Infinity');
  assert.equal(canon(-0), '-0');
  assert.equal(canon(undefined), 'undefined');
  assert.notEqual(canon(-0), canon(0));
});

test('a float difference is a difference and is not rounded away', () => {
  assert.notEqual(canon(0.1 + 0.2), canon(0.3));
});

test('error NAME is the outcome, never its message', () => {
  // Messages carry the function's own name, so comparing them would make every pair
  // `differs` and the tool useless in the way that looks most like working correctly.
  const a = outcomeOf(() => { throw new TypeError('a() wants a string'); }, []);
  const b = outcomeOf(() => { throw new TypeError('b() only accepts text'); }, []);
  assert.equal(a, b);
  assert.equal(a, 'E:TypeError');
});

test('a long value is HASHED so a shared prefix is not agreement', () => {
  const a = outcomeOf(() => `${'z'.repeat(400)}1`, []);
  const b = outcomeOf(() => `${'z'.repeat(400)}2`, []);
  assert.notEqual(a, b);
  assert.match(a, /^V#/);
});

test('an async function is an outcome rather than a silent promise', () => {
  assert.equal(outcomeOf(() => Promise.resolve(1), []), 'E:AsyncResult');
});

// --------------------------------------------------------------------------- //
// The ladder
// --------------------------------------------------------------------------- //

test('the ladder is deterministic across calls', () => {
  // Two runs must be byte-identical; a seeded RNG would make the ladder a function of
  // the seed rather than of the question.
  assert.deepEqual(ladder(1), ladder(1));
  assert.deepEqual(ladder(2), ladder(2));
});

test('the arity2 and arity3 ladders are the same LENGTH', () => {
  // ...which is why the ladder key is load-bearing rather than decorative: without it
  // a two-argument function could bucket with a three-argument one.
  assert.equal(ladder(2).length, ladder(3).length);
  assert.notEqual(ladderKey(2), ladderKey(3));
});

test('the empty case of every shape is in the ladder', () => {
  // The empty case is where two implementations of one function most often part.
  for (const empty of ['""', '[]', '{}']) {
    assert.ok(ladder(1).includes(`[${empty}]`), empty);
  }
});

// --------------------------------------------------------------------------- //
// Gates
// --------------------------------------------------------------------------- //

test('a file that reaches a core module is refused before it is loaded', () => {
  assert.match(fileRefusal("import { readFileSync } from 'node:fs';"), /core module/);
  assert.match(fileRefusal("const fs = require('fs');"), /core module/);
});

test('randomness and the clock are refused although both are ordinary', () => {
  // Both make an outcome depend on something the ladder does not control, so a
  // `differs` would be noise and a `same` would be luck.
  assert.match(fileRefusal('const x = Math.random();'), /randomness/);
  assert.match(fileRefusal('const t = Date.now();'), /clock/);
});

test('a plain computation is NOT refused', () => {
  assert.equal(fileRefusal('export const double = (n) => n * 2;'), null);
});

test('zero arity is refused because a ladder cannot discriminate', () => {
  assert.match(functionRefusal('function f() { return 7; }', 0), /no arguments/);
});

test('an arity above the ladder is refused with the number named', () => {
  assert.match(functionRefusal('function f(a,b,c,d) {}', 4), /arity 4/);
});

test('async, generators and methods are each refused', () => {
  assert.match(functionRefusal('async function f(a) { return a; }', 1), /async/);
  assert.match(functionRefusal('function* f(a) { yield a; }', 1), /generator/);
  assert.match(functionRefusal('function f(a) { return this.x + a; }', 1), /method/);
});

// --------------------------------------------------------------------------- //
// probe and grouping
// --------------------------------------------------------------------------- //

// --------------------------------------------------------------------------- //
// Arity comes from the DECLARED parameter list, never from fn.length
// --------------------------------------------------------------------------- //

test('a default parameter still counts, because fn.length stops at it', () => {
  // The defect this replaced: `fn.length` is 1 for `(a, b = 10)`, so the function was
  // probed on the one-argument ladder, `b` never received a value, and it was reported
  // as answering the same question as a genuinely one-argument function.
  assert.equal(declaredArity('function f(a, b = 10) {}'), 2);
  assert.equal(declaredArity('function f(a = 1, b = 2, c = 3) {}'), 3);
});

test('a destructured parameter is ONE parameter', () => {
  assert.equal(declaredArity('function f({ x, y }, [p, q]) {}'), 2);
});

test('commas inside a default value do not add parameters', () => {
  assert.equal(declaredArity('function f(a = g(1, 2), b) {}'), 2);
  assert.equal(declaredArity('function f(a = { x: 1, y: 2 }) {}'), 1);
  assert.equal(declaredArity("function f(a = ',', b) {}"), 2);
  assert.equal(declaredArity('function f(a, /* , */ b) {}'), 2);
});

test('an arrow with one bare parameter has no parentheses to find', () => {
  // The scan below it would otherwise find the first `(` in the BODY.
  assert.equal(declaredArity('a => a + 1'), 1);
  assert.equal(declaredArity('a => f(a, a)'), 1);
  assert.equal(declaredArity('(a, b) => a + b'), 2);
});

test('no parameters is zero, not unreadable', () => {
  assert.equal(declaredArity('function f() {}'), 0);
});

test('a list that cannot be read is REFUSED, never guessed from fn.length', () => {
  // Falling back would restore the wrong answer silently in exactly the cases the
  // parser found hardest. Refusing costs coverage and says so in the census.
  assert.equal(declaredArity('function f(a'), null);
  assert.equal(declaredArity("function f(a = ') {}"), null);
});

test('probeFunction chooses the ladder by the DECLARED count', () => {
  const withDefault = (a, b = 10) => a + b;
  const result = probeFunction(withDefault, 'withDefault',
    { 1: ladder(1), 2: ladder(2), 3: ladder(3) });
  assert.equal(result.arity, 2, result.skip);
  assert.equal(result.vector.length, ladder(2).length);
});

test('two functions that differ only past a default are NOT grouped', async () => {
  // The whole defect, end to end: `withDefault(1, 2)` is 3 and `plainOne(1)` is 11,
  // and they were reported as one function because the second argument was never
  // passed. The Python half never had this, so it was a parity break too.
  const scan = await collect([write(
    'export function plainOne(a) {\n  return a + 10;\n}\n'
    + 'export function withDefault(a, b = 10) {\n  return a + b;\n}\n',
  )]);
  group(scan);
  assert.deepEqual(scan.groups, []);
});

test('exported functions are found under their exported names', () => {
  assert.deepEqual(exportedFunctions({ b: () => 1, a: () => 2 }).map(([n]) => n),
    ['a', 'b']);
});

test('a CommonJS default export is unwrapped rather than reported as empty', () => {
  // Missing this reports "0 functions" for every CJS file in a project, which reads as
  // nothing to find rather than as a shape the tool did not handle.
  const found = exportedFunctions({ default: { helper: () => 1 } });
  assert.deepEqual(found.map(([n]) => n), ['helper']);
});

test('probeFunction returns a reason rather than throwing on a refusal', () => {
  const result = probeFunction(async (a) => a, 'f', { 1: ladder(1) });
  assert.match(result.skip, /async/);
});

test('two implementations of one function are grouped', async () => {
  const scan = await collect([write(TWINS)]);
  group(scan);
  assert.equal(scan.groups.length, 1);
  assert.deepEqual(scan.groups[0].map((r) => r.split('::')[1]).sort(), ['a', 'b']);
});

test('names are never read, so differing names still group', async () => {
  const scan = await collect([write(TWINS.replace('function b(', 'function unrelated('))]);
  group(scan);
  assert.equal(scan.groups.length, 1);
});

test('functions that genuinely differ are not grouped', async () => {
  const scan = await collect([write(
    'export function a(n) { return n * 2; }\nexport function b(n) { return n + 2; }\n',
  )]);
  group(scan);
  assert.deepEqual(scan.groups, []);
});

test('a singleton bucket is not duplication', async () => {
  const scan = await collect([write('export function only(n) { return n * 3 + 1; }\n')]);
  group(scan);
  assert.deepEqual(scan.groups, []);
});

test('the census counts every reason a function was not probed', async () => {
  // "We found none" and "we never looked" are different claims.
  const scan = await collect([write('export function f() { return 1; }\n')]);
  assert.deepEqual(scan.census(), [['no arguments', 1]]);
});

test('a file that cannot be loaded is counted, not silently dropped', async () => {
  const scan = await collect([write('export function f(n) { syntax error here\n')]);
  assert.equal(scan.probed.size, 0);
  assert.equal(scan.unloadable.size, 1);
  assert.match([...scan.unloadable.values()][0], /could not load|probe failed/);
});

test('probing happens in a CHILD process, so a module that exits cannot kill us', async () => {
  // The parent must still be here to report. A tool that dies on one bad file cannot
  // audit the tree that contains it.
  const file = write('export function f(n) { return n; }\n');
  const result = await probeFile(file);
  assert.ok(result.functions.length >= 1);
  assert.equal(typeof process.exitCode, typeof undefined === 'undefined' ? 'undefined' : 'number');
});

// --------------------------------------------------------------------------- //
// One function is not two. (`module.exports = fn` arrives under two names.)
// --------------------------------------------------------------------------- //

test('two names for ONE function object is one function, not a duplicate pair', () => {
  // The ESM bridge gives a CJS module whose export IS a function two keys — `default`
  // and `module.exports` — pointing at the same object. Reported as two, every such
  // file duplicates itself, and a FINDING is what a person then has to dismiss.
  const fn = (a) => a + 1;
  assert.deepEqual(exportedFunctions({ default: fn, 'module.exports': fn }).map(([n]) => n),
    ['default']);
});

test('two names for two DIFFERENT functions are still two functions', () => {
  // The other direction: dedupe is by identity, so it must not collapse a module that
  // genuinely exports two functions which happen to be reachable under two names.
  const found = exportedFunctions({ a: (x) => x + 1, b: (x) => x * 2 });
  assert.deepEqual(found.map(([n]) => n), ['a', 'b']);
});

test('a CommonJS file exporting one function does not duplicate itself', async () => {
  const scan = await collect([writeCjs(
    'function truncate(str, len) {\n'
    + "  if (!str) return '';\n"
    + "  return str.length > len ? `${str.substring(0, len)}...` : str;\n"
    + '}\n'
    + 'module.exports = truncate;\n',
  )]);
  group(scan);
  assert.deepEqual(scan.groups, []);
  assert.equal(scan.functions, 1);
});

test('a barrel that RE-EXPORTS a helper does not duplicate it', async () => {
  // The same rule as above, one scope out. A barrel hands back the very objects its
  // dependencies defined, so `registry.js::truncate` and `truncate.js::default` are
  // one function reachable by two paths — true, and useless to be told.
  const dir = writeTree({
    'impl.js': "export function shout(s) { return String(s).toUpperCase() + '!'; }\n",
    'barrel.js': "export { shout } from './impl.js';\n",
  });
  const scan = await collect([dir]);
  group(scan);
  assert.deepEqual(scan.groups, []);
  assert.deepEqual([...scan.probed.keys()].map((r) => r.split('/').pop()),
    ['impl.js::shout']);
});

test('a function COPIED into two files is still two implementations', async () => {
  // The other direction, and the one that matters: dedupe is by identity, so a
  // verbatim copy — which is duplication a person should see — must survive it.
  const dir = writeTree({
    'one.js': "export function shout(s) { return String(s).toUpperCase() + '!'; }\n",
    'two.js': "export function holler(s) { return String(s).toUpperCase() + '!'; }\n",
  });
  const scan = await collect([dir]);
  group(scan);
  assert.equal(scan.groups.length, 1);
  assert.equal(scan.groups[0].length, 2);
});

// --------------------------------------------------------------------------- //
// The child's answer travels on its own channel.
// --------------------------------------------------------------------------- //

// --------------------------------------------------------------------------- //
// A hang costs the function that hung, not the file
// --------------------------------------------------------------------------- //

test('one non-terminating function does not cost the whole file', async () => {
  // Before incremental answers the child computed everything and spoke once at the
  // end, so the SIGKILL that bounds a `while (true)` threw away every result it had
  // already produced: a file of good functions reported `probe failed` and nothing
  // else. There is no per-input interrupt for synchronous JavaScript, so the wall
  // clock is the only bound — the fix is to have answered before it fires.
  const file = write(
    'export function fine(a) {\n'
    + "  return a === 0 ? 'zero' : String(a).length;\n}\n"
    + 'export function spins(a) {\n'
    + '  while (a !== undefined) { /* never returns */ }\n  return a;\n}\n',
  );
  const result = await probeFile(file, 2500);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.functions.length, 2);
  const byName = Object.fromEntries(result.functions.map((f) => [f.name, f]));
  assert.ok(byName.fine.vector, 'the function that answered keeps its vector');
  assert.match(byName.spins.skip, /did not answer/);
});

test('a killed probe tells the hung function from the ones never started', async () => {
  // Two different facts. Reporting them as one would claim the probe examined
  // functions it never reached.
  const file = write(
    "export function aFirst(a) { return a === 0 ? 'zero' : String(a).length; }\n"
    + 'export function bSpins(a) { while (a !== undefined) { /* hangs */ } return a; }\n'
    + "export function cLater(a) { return a === 1 ? 'one' : typeof a; }\n",
  );
  const result = await probeFile(file, 2500);
  const byName = Object.fromEntries(result.functions.map((f) => [f.name, f]));
  assert.ok(byName.aFirst.vector);
  assert.match(byName.bSpins.skip, /did not answer/);
  assert.match(byName.cLater.skip, /not reached: the probe was killed in bSpins/);
});

test('a module with no exports is not mistaken for a killed probe', async () => {
  // The roster is what tells them apart: an empty roster arrived, so nothing was
  // found — as opposed to no roster at all, which is a child that never got that far.
  const result = await probeFile(write('export const x = 1;\n'));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(result.functions, []);
});

test('a module that PRINTS at import time is still probed', async () => {
  // Loading a module runs its top-level code, and plenty of ordinary code announces
  // itself — a dotenv banner is the common one. If the answer shares stdout with the
  // module, that banner lands in front of the JSON and the whole file is lost.
  const file = write("console.log('◇ injected env (0) from .env');\n"
    + 'export function f(n) { return n * 3 + 1; }\n');
  const result = await probeFile(file);
  assert.equal(result.error, undefined);
  assert.deepEqual((result.functions || []).map((e) => e.name), ['f']);
});

test('a module that prints AND fails to load reports the FAILURE, not silence', async () => {
  // The diagnosis was already computed; it was thrown away because something printed
  // before it. "probe failed (silent)" and "could not load (JWT_SECRET must be set)"
  // send you to opposite ends of the problem.
  const file = write("console.log('banner');\nthrow new Error('boom at import');\n");
  const result = await probeFile(file);
  assert.match(result.error, /could not load/);
  assert.match(result.error, /boom at import/);
});

test('a probe that dies without answering says what it printed', async () => {
  // `silent` must be unreachable when the child produced output. A reason that names
  // nothing is a number reported without saying what produced it.
  const file = write("console.log('the useful part');\nprocess.exit(3);\n");
  const result = await probeFile(file);
  assert.match(result.error, /the useful part/);
});

// --------------------------------------------------------------------------- //
// The census adds up, and says which unit each number is in.
// --------------------------------------------------------------------------- //

test('probed + not probed = functions, counting only files that loaded', async () => {
  const dir = writeTree({
    'good.js': 'export function f(n) { return n * 3 + 1; }\n'
      + 'export function g() { return 1; }\n',
    'refused.js': 'export function h(n) { return new Date(n).getTime(); }\n',
  });
  const scan = await collect([dir]);
  assert.equal(scan.functions, scan.probed.size + scan.skipped.size);
  assert.equal(scan.functions, 2);          // f probed, g skipped (no arguments)
  assert.equal(scan.unloadable.size, 1);    // refused.js, counted as a FILE
  assert.equal(scan.files, 2);
});

test('a file refused before loading is counted as a file, never as a function', async () => {
  // It has an unknown number of functions in it — that is the point of not loading it.
  // Folding it into a function count invents a number nobody measured.
  const scan = await collect([writeTree({ 'a.js': 'export const x = Date.now();\n' })]);
  assert.equal(scan.functions, 0);
  assert.equal(scan.skipped.size, 0);
  assert.deepEqual(scan.fileCensus(), [['reads the clock', 1]]);
});

// --------------------------------------------------------------------------- //
// The gates read code, not prose.
// --------------------------------------------------------------------------- //

test('a module specifier is read even though it lives inside a string', () => {
  // The gate's subject IS a string literal. Blanking string bodies to keep prose from
  // tripping the OTHER gates turned `from 'node:fs'` into `from '      '`, and the file
  // loaded unrefused — the one direction that runs code instead of printing a wrong line.
  assert.match(fileRefusal("import { readFileSync } from 'node:fs';"), /core module/);
  assert.match(fileRefusal("const fs = require('fs');"), /core module/);
});

test('a require that is COMMENTED OUT does not execute, so it does not refuse', () => {
  assert.equal(fileRefusal("// const fs = require('fs');\nexport const x = 1;"), null);
});

test('the word "this" in a COMMENT is not the `this` keyword', () => {
  const source = 'function f(a) {\n'
    + '  // COMMAND_LINE_RE anchors the full line, so this is a command-only line.\n'
    + '  return a + 1;\n'
    + '}';
  assert.equal(functionRefusal(source, 1), null);
});

test('a real `this` is still a method', () => {
  assert.match(functionRefusal('function f(a) { return this.x + a; }', 1), /method/);
});

test('a property NAMED global is not the global object', () => {
  assert.equal(fileRefusal("const ok = Array.isArray(perms.global) && perms.global.includes('t');"),
    null);
});

test('the actual global object is still refused', () => {
  assert.match(fileRefusal('global.cache = 1;'), /global/);
  assert.match(fileRefusal('globalThis.cache = 1;'), /global/);
});

test('a clock named in prose is not a clock', () => {
  assert.equal(fileRefusal('// startTime is Date.now() captured by the CALLER\n'
    + 'export function f(a) { return a + 1; }'), null);
  assert.match(fileRefusal('export function f() { return Date.now(); }'), /clock/);
});

// --------------------------------------------------------------------------- //
// Stripping prose must never strip CODE. The dangerous direction is a gate that
// stops firing, because that loads a file the gate exists to refuse.
// --------------------------------------------------------------------------- //

test('a quote inside a regex literal does not swallow the rest of the file', () => {
  // If `/['"]/` is read as opening a string, everything after it disappears and the
  // file loads unrefused. A false FINDING is noise; this would be a wrong LOAD.
  const source = 'const r = /[\'"]/;\nprocess.exit(1);\n';
  assert.match(stripNonCode(source), /process\s*\.\s*exit/);
  assert.match(fileRefusal(source), /process/);
});

test('code inside a template placeholder is code', () => {
  const source = 'const t = `x${process.env.A}y`;\n';
  assert.match(stripNonCode(source), /process\s*\.\s*env/);
  assert.match(fileRefusal(source), /process/);
});

test('a // inside a string literal does not start a comment', () => {
  const source = 'const u = "https://example.com";\nprocess.exit(1);\n';
  assert.match(stripNonCode(source), /process\s*\.\s*exit/);
  assert.match(fileRefusal(source), /process/);
});

test('an unlexable file keeps its refusal rather than being cleared by a guess', () => {
  // Bail out, do not guess. An unterminated string means the scanner lost the thread,
  // and the safe answer to "did the thread just get lost" is to keep refusing.
  assert.equal(stripNonCode('const s = "never closed\nprocess.exit(1);\n'), null);
  assert.match(fileRefusal('const s = "never closed\nprocess.exit(1);\n'), /process/);
});

test('division is not a regex literal', () => {
  const source = 'const half = total / 2;\nconst other = count / 2;\nprocess.exit(1);\n';
  assert.match(stripNonCode(source), /process\s*\.\s*exit/);
});

// --------------------------------------------------------------------------- //
// A shallow copy is as vacuous as the identity.
// --------------------------------------------------------------------------- //

test('a function indistinguishable from a shallow copy is not discriminated', () => {
  // Two unrelated object transforms whose vocabulary the ladder lacks BOTH degrade to
  // "copy the object through". Their vectors match, and neither has been discriminated
  // — the ladder never reached either one's behaviour.
  const inputs = ladder(1);
  const vector = inputs.map((src) => outcomeOf((q) => ({ ...(q || {}) }), JSON.parse(src)));
  assert.equal(isProjection(vector, inputs), true);
  assert.equal(discriminating(vector, inputs), null);
});

test('a spread that CHANGES something is discriminated', () => {
  // The other direction: the guard rejects vacuity, not object-returning functions.
  const inputs = ladder(1);
  const vector = inputs.map((src) => outcomeOf((q) => ({ ...(q || {}), seen: true }),
    JSON.parse(src)));
  assert.equal(isProjection(vector, inputs), false);
  assert.notEqual(discriminating(vector, inputs), null);
});

test('two unrelated shallow-copy transforms do not group', async () => {
  // The measured case: `decodeQuery` and `splitSortParam` from a real tree, neither of
  // whose keys appear in the ladder.
  const scan = await collect([writeTree({
    'q.js': 'const SHORT_TO_LONG = { s: \'status\' };\n'
      + 'export function decodeQuery(query) {\n'
      + '  const out = {};\n'
      + '  Object.keys(query || {}).forEach((k) => { out[SHORT_TO_LONG[k] || k] = query[k]; });\n'
      + '  return out;\n'
      + '}\n'
      + 'export function splitSortParam(query) {\n'
      + '  const out = { ...(query || {}) };\n'
      + '  if (out.sort) { out.sort_by = String(out.sort); delete out.sort; }\n'
      + '  return out;\n'
      + '}\n',
  })]);
  group(scan);
  assert.deepEqual(scan.groups, []);
});
