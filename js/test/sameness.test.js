/**
 * The sameness half. Every test asks what a MUTATION would change.
 *
 * A test written by asking what the function does passes for the wrong reason far more
 * often than one written by asking what breaking it would do. The two guards this half
 * rests on — `discriminating` and the ladder-key check in `compare` — are driven in
 * BOTH directions.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canon, collect, compare, declaredArity, discriminating, fileRefusal,
  functionRefusal, group, isProjection, ladder, ladderKey, loadRefusal, MIN_DISTINCT,
  moduleBindings, outcomeOf, probeFile, probeOutcome, PROBE_TIMEOUT_MS, reachRefusal,
  stripNonCode,
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

test('generators and methods are refused, and async no longer is', () => {
  // `async` used to be a refusal, which put a modern service layer permanently out of
  // reach: 73 refusals on the first real tree, 34 of them in `services/`. What made it
  // one was reading the promise instead of the value it settles on, and the probe
  // awaits now.
  assert.equal(functionRefusal('async function f(a) { return a * 2; }', 1), null);
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

test('probeFunction chooses the ladder by the DECLARED count', async () => {
  const withDefault = (a, b = 10) => a + b;
  const result = await probeFunction(withDefault, 'withDefault',
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

test('probeFunction returns a reason rather than throwing on a refusal', async () => {
  const result = await probeFunction(function* (a) { yield a; }, 'f', { 1: ladder(1) });
  assert.match(result.skip, /generator/);
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

// A writer whose target resolves against its OWN module url, never a bare relative
// path. `writeFileSync('a', ...)` lands in `process.cwd()`, and during a mutation run
// that is the repository itself — so a fixture written the obvious way commits the
// exact offence these two tests exist to detect. `new URL` keeps it inside the fixture
// directory, which is where the assertion below is looking.
const WRITER = "import { writeFileSync } from 'node:fs';\n"
  + 'export function save(name) {\n'
  + '  writeFileSync(new URL(encodeURIComponent(String(name)), import.meta.url), "x");\n'
  + '  return name;\n}\n';

test('a DYNAMIC import of a core module is refused like a static one', () => {
  // THE GATE HAS TO KNOW EVERY SPELLING OF AN IMPORT. `require('node:fs')` and
  // `from 'node:fs'` were refused and `await import('node:fs')` was not, so a file
  // could reach the filesystem through the one door nobody had written down — and
  // unlike the barrel above, this needs no second file at all. The Python half has
  // always banned `__import__` by name; this is the two halves agreeing again.
  const dynamic = "export async function f(a) {\n"
    + "  const fs = await import('node:fs');\n"
    + '  return fs.existsSync(String(a));\n}\n';
  assert.match(fileRefusal(dynamic) || '', /reaches a node core module/);
  // ...and the two spellings that always were, so this cannot pass by refusing
  // everything — a gate that refuses every file agrees with any code at all.
  assert.match(fileRefusal("import { x } from 'node:fs';\n") || '', /core module/);
  assert.equal(fileRefusal('export function f(a) { return a + 1; }\n'), null);
});

test('a probe writing a RELATIVE path cannot reach the directory we were run from', async () => {
  // CONTAINMENT, because every gate here is best-effort — so the question is not only
  // what gets refused but WHERE the damage lands when something is not. `probeFile`
  // sits BELOW the file gate on purpose: `collect` is what refuses a file, and this is
  // the net that has to hold when something gets past it.
  //
  // THE WRITE IS AT MODULE SCOPE, and it has to be. This fixture used to write from a
  // probed FUNCTION, on the reasoning that `writeFileSync` is a free name the
  // per-function gate could not see. `reachRefusal` sees it now, so that function was
  // refused before it could be called and this test passed whether the cwd was
  // contained or not — a guard nothing can arrive at is a guard nothing checks, and the
  // mutation that removes `cwd: tmpdir()` survived a full run to say so.
  //
  // Import-time code is what is left, and it is the residue the README already names:
  // loading a module runs its top-level code, and no gate stands between `probeFile`
  // and that. So this is the real remaining route rather than a contrivance kept alive
  // to keep a test red.
  //
  // The cwd is moved to a scratch directory for the duration, so this test cannot
  // itself commit the offence it is checking for, in either outcome.
  const dir = writeTree({
    'm.js': "import { writeFileSync } from 'node:fs';\n"
      + 'writeFileSync("stray-relative-write", "x");\n'
      + 'export function pure(a) { return a + 1; }\n',
  });
  const scratch = mkdtempSync(path.join(tmpdir(), 'assay-cwd-'));
  const saved = process.cwd();
  process.chdir(scratch);
  try {
    await probeFile(path.join(dir, 'm.js'));
  } finally {
    process.chdir(saved);
  }
  assert.deepEqual(readdirSync(scratch), [],
    'the probe inherited our cwd and wrote the ladder into it');
});

test('a barrel may NOT launder the gate the defining file failed', async () => {
  // THE PROBE RUNS WHAT IT LOADS, so a gate that is applied per-file is only as good
  // as the attribution of functions to files. `writer.js` touches `node:fs` and is
  // refused, so its functions are never probed there. `barrel.js` re-exports one and
  // imports no core module of its own, so it PASSES the same gate — and loading it
  // hands the child the very function the gate just refused.
  //
  // `functionRefusal` cannot catch this: it looks for import statements, and a
  // function body never contains one. What stood in the way was the de-duplication
  // skip, which exists to name each function once and had no idea it was also the last
  // thing between the probe and a real `writeFileSync` on a real path.
  const dir = writeTree({
    'writer.js': WRITER,
    'barrel.js': "export { save } from './writer.js';\n",
  });
  const scan = await collect([dir]);
  // Named, not silently dropped: "we declined to run this" and "there was nothing
  // here" are the two claims this tool exists to keep apart.
  const skips = [...scan.skipped.entries()].filter(([ref]) => ref.endsWith('::save'));
  assert.equal(skips.length, 1, JSON.stringify([...scan.skipped]));
  assert.match(skips[0][1], /reaches a node core module/);
  assert.equal(scan.probed.size, 0, 'nothing in this tree may be probed');
});

test('the probe does not WRITE when it declines a re-exported writer', async () => {
  // The assertion the census cannot make. `save` writes a file named after its
  // argument, so if the gate is laundered the ladder's string rungs land on disk as
  // real files — which is exactly what happened, ten of them, in the repository root.
  const dir = writeTree({
    'writer.js': WRITER,
    'barrel.js': "export { save } from './writer.js';\n",
  });
  const before = readdirSync(dir).sort();
  await collect([dir]);
  assert.deepEqual(readdirSync(dir).sort(), before,
    'the probe wrote into the tree, so the gate was laundered');
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
// A promise is compared on the value it settles on
// --------------------------------------------------------------------------- //

test('an async function and its synchronous twin are the same function', async () => {
  // They answer the same question, and reading the promise object instead of the value
  // it settles on meant the first was never probed and the second scored `E:AsyncResult`
  // on every rung — so the pair either never met or was reported as differing with a
  // witness that said nothing about either one.
  const scan = await collect([write(
    'export async function doubled(a) {\n  return a * 2;\n}\n'
    + 'export function alsoDoubled(a) {\n  return a * 2;\n}\n'
    + 'export function viaPromise(a) {\n  return Promise.resolve(a * 2);\n}\n',
  )]);
  group(scan);
  assert.equal(scan.groups.length, 1, JSON.stringify([...scan.skipped]));
  assert.deepEqual(scan.groups[0].map((r) => r.split('::')[1]).sort(),
    ['alsoDoubled', 'doubled', 'viaPromise']);
});

test('a rejection is the SAME outcome as a synchronous throw', async () => {
  // By type and never by message, for the reason every other outcome here is: a message
  // carries the function's own name, so comparing them makes honest pairs differ.
  const bad = (a) => { if (typeof a !== 'string') throw new TypeError('str'); return a; };
  const rejecting = async (a) => {
    if (typeof a !== 'string') throw new TypeError('str');
    return a;
  };
  assert.equal(await probeOutcome(rejecting, [1]), await probeOutcome(bad, [1]));
  assert.equal(await probeOutcome(rejecting, [1]), 'E:TypeError');
});

test('a rejection that is not an Error still names an outcome', async () => {
  assert.equal(await probeOutcome(async () => { throw 'a string'; }, [1]), 'E:Error');
});

test('an awaited value is rendered exactly as a returned one', async () => {
  assert.equal(await probeOutcome(async (a) => a * 2, [21]),
    await probeOutcome((a) => a * 2, [21]));
});

test('the vector is deterministic across runs of an async function', async () => {
  // Awaited rungs must land in ladder order. Running them concurrently would let one
  // rung's pending work overlap another's and the vector would stop being a function
  // of the ladder.
  const fn = async (a) => (a === 0 ? 'zero' : typeof a);
  const inputs = ladder(1);
  const once = [];
  const twice = [];
  for (const src of inputs) once.push(await probeOutcome(fn, JSON.parse(src)));
  for (const src of inputs) twice.push(await probeOutcome(fn, JSON.parse(src)));
  assert.deepEqual(once, twice);
});

test('an awaited rung that never settles is an OUTCOME, not a lost function', async () => {
  // The interrupt that does exist. A pending promise leaves the event loop free, so a
  // timer racing it bounds the rung — the claim that nothing can be delivered from
  // inside the process is true only of a synchronous loop, which never yields.
  assert.equal(await probeOutcome(async () => new Promise(() => {}), [1]),
    'E:TimeoutError');
});

test('a function that never settles is PROBED, and then not discriminated', async () => {
  // Every rung times out, so the vector holds no returned value at all and the ladder
  // cannot tell it from a constant. That is a `look` reached by probing, which is a
  // different claim from the function having been lost.
  const file = write(
    'export async function fine(a) {\n  return a === 0 ? 0 : String(a).length;\n}\n'
    + 'export async function pending(a) {\n'
    + '  await new Promise(() => {});\n  return a;\n}\n',
  );
  // A SHORTER BUDGET, not a different question. Every rung of `pending` runs to the
  // per-input timer, so at the default 250ms this one test costs thirty-one of them —
  // the slowest in either half, in a suite the mutation runner runs once per mutation.
  // What is under test is that a rung which never settles becomes an OUTCOME, and the
  // budget travels to the child in the request, so shortening it asks the same thing.
  const result = await probeFile(file, PROBE_TIMEOUT_MS, null, false, 25);
  assert.equal(result.error, undefined, JSON.stringify(result));
  const byName = Object.fromEntries(result.functions.map((f) => [f.name, f]));
  assert.ok(byName.fine.vector, 'the function that settled keeps its vector');
  assert.ok(byName.pending.vector, byName.pending.skip);
  assert.equal(discriminating(byName.pending.vector, ladder(1)), null);
});

test('a module holding a handle open does not cost the wall timeout', async () => {
  // The larger half of what probing used to cost, and it was never an async problem:
  // Node keeps a process alive while any handle is open, and an interval or a pool
  // opened AT IMPORT TIME is the probed code's handle, not ours. Every such file paid
  // the full wall clock for work that had finished in a fraction of a second —
  // seventeen minutes over one real directory of controllers.
  const file = write(
    'const keepAlive = setInterval(() => {}, 1000);\n'
    + 'export function quick(a) {\n  return a === 0 ? 0 : String(a).length;\n}\n',
  );
  const started = Date.now();
  const result = await probeFile(file);
  const elapsed = Date.now() - started;
  assert.ok(result.functions[0].vector, JSON.stringify(result));
  // Generous against a loaded machine, and still far under the 20s wall it used to pay.
  assert.ok(elapsed < 5000, `took ${elapsed}ms, so it waited for the loop to drain`);
});

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
  // 2500ms was ten times what the child needs to boot, load and answer for the
  // function that settles (~200ms here); 1000 is still five times it, and the wait is
  // paid twice in this file. What is asserted is which function the kill lands on.
  const result = await probeFile(file, 1000);
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
  const result = await probeFile(file, 1000);
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
// The gate is TWO questions: may this module be imported, may this be called?
// --------------------------------------------------------------------------- //

/** `reachRefusal` for one named binding of a module, by source. */
function reachOf(source, name) {
  const mod = moduleBindings(source);
  return reachRefusal(mod.local.get(name), mod);
}

test('a body-only impurity no longer refuses the whole file', () => {
  const src = 'export function pure(n) { return n * 2; }\n'
    + 'export function dated(v) { return new Date(v); }\n';
  assert.equal(fileRefusal(src), 'reads the clock');   // the old, whole-file answer
  assert.equal(loadRefusal(src), null);                // nothing reads it on the way IN
});

test('an impurity at MODULE SCOPE still refuses the file', () => {
  assert.equal(loadRefusal('const fs = require("fs");\nexport function f(n) { return n; }\n'),
    'reaches a node core module');
  assert.equal(loadRefusal('export const started = Date.now();\n'), 'reads the clock');
});

test('an IIFE keeps its body, because an IIFE runs at import', () => {
  // The narrow rule that makes the split safe: only a DECLARATION's body is deferred.
  // Anything that might be invoked on the way in keeps its text.
  assert.equal(loadRefusal('const home = (function () { return process.env.HOME; })();\n'),
    'touches process');
});

test('a class field initializer runs at import, so it is not deferred', () => {
  assert.equal(loadRefusal('class C { home = process.env.HOME; }\nexport { C };\n'),
    'touches process');
});

test('an arrow with an EXPRESSION body is still deferred', () => {
  // `const f = (x) => impure(x)` runs `impure` when f is called, not on the way in.
  // Requiring braces to defer would refuse every one-line helper in a barrel.
  assert.equal(loadRefusal('export const at = (v) => new Date(v);\n'), null);
});

test('a CJS barrel exporting arrows INLINE defers them like declarations', () => {
  // The shape most of a CommonJS estate is written in, and the one the load gate
  // missed: nothing here is a declaration keyword at depth 0, so a clock in one
  // property refused the file and took every pure helper with it — the very defect the
  // gate was written to fix, surviving in a different spelling.
  const src = 'module.exports = {\n'
    + '  at: (v) => new Date(v),\n'
    + '  twice: (n) => n * 2,\n'
    + '};\n';
  assert.equal(fileRefusal(src), 'reads the clock');   // the whole-file answer
  assert.equal(loadRefusal(src), null);                // nothing reads it on the way IN
});

test('a SHORTHAND METHOD in an object literal is deferred too', () => {
  assert.equal(loadRefusal('module.exports = { at(v) { return new Date(v); } };\n'), null);
});

test('an IIFE in property position runs at import, in BOTH spellings', () => {
  // `fnBodySpan` refuses the wrapped one because a parenthesised group is not followed
  // by `=>`. The bare one needs `invoked`, and nothing was checking it.
  assert.equal(loadRefusal('module.exports = { x: (() => Date.now())() };\n'),
    'reads the clock');
  assert.equal(loadRefusal('module.exports = { x: function () { return Date.now(); }() };\n'),
    'reads the clock');
});

test('a GETTER is not deferred, because reading a property RUNS it', () => {
  // `exportedFunctions` reads every export to enumerate it, so an accessor body is
  // reachable in a way an ordinary method's is not. The guard is that the name must sit
  // directly after `{` or `,`, and a getter's does not — `get` is in the way.
  assert.equal(loadRefusal('module.exports = { get x() { return Date.now(); } };\n'),
    'reads the clock');
});

test('an IIFE bound to a NAME still runs at import', () => {
  // The dangerous direction, and it shipped: blanking this body called the file clean,
  // which is a file the gate exists to refuse getting loaded. The wrapped spelling was
  // already refused, but only because the initializer scan gave up on a parenthesised
  // group — correct by accident, in the one place an accident is a loaded module.
  assert.equal(loadRefusal('const x = function () { return Date.now(); }();\n'),
    'reads the clock');
  assert.equal(loadRefusal('const x = (function () { return Date.now(); })();\n'),
    'reads the clock');
  // ...and an ordinary function expression is still deferred, so this cannot pass by
  // refusing everything.
  assert.equal(loadRefusal('const f = function () { return Date.now(); };\n'), null);
});

test('a function is refused for what its FREE NAMES reach', () => {
  // The hole that makes "narrow the file gate and stop" unsafe. `slugA`'s own source
  // mentions nothing gated; `stamp` is not exported, so nothing else looks at it.
  const src = 'export function slugA(s) { return stamp(s); }\n'
    + 'function stamp(s) { return require("fs").readFileSync(s); }\n';
  assert.equal(loadRefusal(src), null);
  assert.equal(functionRefusal('function slugA(s) { return stamp(s); }', 1), null);
  assert.match(reachOf(src, 'slugA'), /reaches stamp, which reaches a node core module/);
});

test('reachability follows more than one hop, and NAMES every one', () => {
  // The chain is a path back to the code, so a hop it skips is a hop the reader cannot
  // follow. Asserting only the final reason let a version through that reported
  // `reaches c` for a function whose body mentions only `b`.
  const src = 'export function a(s) { return b(s); }\n'
    + 'function b(s) { return c(s); }\n'
    + 'function c(s) { return process.env[s]; }\n';
  assert.equal(reachOf(src, 'a'), 'reaches b, which reaches c, which touches process');
});

test('a refusal chain reads as a sentence, whatever it ends in', () => {
  // Concatenation produced "reaches giteaFor, which free name Buffer" on real code. A
  // census line nobody can read is a reason reported without saying what produced it.
  const free = 'export function f(n) { return wrap(n); }\n'
    + 'function wrap(n) { return Buffer.from(n); }\n';
  assert.equal(reachOf(free, 'f'), 'reaches wrap, which has a free name Buffer');
});

test('deterministic standard globals are allowed', () => {
  // Each of these was measured refusing real code — `qs` lost a helper to
  // `free name URLSearchParams` on its own.
  for (const g of ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder']) {
    const src = `export function f(s) { return new ${g}(s); }\n`;
    assert.equal(reachOf(src, 'f'), null, g);
  }
});

test('Buffer is NOT allowed, and allocUnsafe is why', () => {
  // The allowlist is per NAME, not per method: `Buffer.from` is deterministic and
  // `Buffer.allocUnsafe` hands back whatever was in that memory.
  const src = 'export function f(n) { return Buffer.allocUnsafe(n); }\n';
  assert.equal(reachOf(src, 'f'), 'free name Buffer');
});

test('a name from ANOTHER MODULE is refused rather than followed', () => {
  // Cross-file reachability is out of scope, so an imported name is refused by name.
  // Before the call gate existed this was a real `writeFileSync` on a real path: the
  // importing file mentions no core module, so it loaded and the function was probed.
  const src = 'import { writeIt } from "./io.js";\n'
    + 'export function save(x) { return writeIt(x); }\n';
  assert.equal(loadRefusal(src), null);
  assert.match(reachOf(src, 'save'), /free name writeIt comes from another module/);
});

test('a require-bound name is treated as imported too', () => {
  const src = 'const { writeIt } = require("./io.js");\n'
    + 'module.exports.save = function save(x) { return writeIt(x); };\n';
  assert.match(reachRefusal('function save(x) { return writeIt(x); }',
    moduleBindings(src)), /comes from another module/);
});

test('an unknown global is refused BY NAME, never assumed pure', () => {
  const mod = moduleBindings('export function f(n) { return Buffer.from(n); }\n');
  assert.equal(reachRefusal('function f(n) { return Buffer.from(n); }', mod),
    'free name Buffer');
});

test('a deterministic global is allowed', () => {
  const src = 'export function f(n) { return Math.max(Number(n), JSON.parse("1")); }\n';
  assert.equal(reachOf(src, 'f'), null);
});

test('a property named like a gated global is not that global', () => {
  const src = 'export function f(o) { return o.process.env; }\n';
  assert.equal(reachOf(src, 'f'), null);
});

test('recursion terminates rather than walking forever', () => {
  const src = 'export function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }\n';
  assert.equal(reachOf(src, 'fact'), null);
});

test('mutual recursion through an impure hop is still caught', () => {
  const src = 'export function a(n) { return n < 0 ? 0 : b(n - 1); }\n'
    + 'function b(n) { return a(n) + process.pid; }\n';
  assert.match(reachOf(src, 'a'), /touches process/);
});

test('a name declared TWICE poisons its binding rather than picking one', () => {
  const src = 'function h(n) { return n; }\nfunction h(n) { return process.pid; }\n'
    + 'export function f(n) { return h(n); }\n';
  assert.match(reachOf(src, 'f'), /declared more than once/);
});

test('a file the lexer cannot read keeps the WHOLE-FILE refusal', () => {
  // Uncertainty keeps the `look` and never spends it: the last file to narrow a gate
  // around is one the parser lost the thread on.
  const src = 'const a = "unterminated\nexport function f(n) { return new Date(n); }\n';
  assert.equal(moduleBindings(src), null);
  assert.equal(loadRefusal(src), fileRefusal(src));
});

test('a CALLBACK parameter is declared, not free', () => {
  // Reading only the outer parameter list reported `free name key` for
  // `parameters.forEach((value, key) => ...)` and refused the ordinary shape of every
  // iteration helper there is. Found by measuring against real code, not by reading.
  const src = 'export function q(ps) { const o = []; ps.forEach((v, key) => o.push(key + v)); return o; }\n';
  assert.equal(reachOf(src, 'q'), null);
});

test('a single-identifier arrow parameter is declared too', () => {
  const src = 'export function pick(xs) { return xs.find((tp) => tp.id); }\n';
  assert.equal(reachOf(src, 'pick'), null);
});

test("an `if` header is not a parameter list", () => {
  // The test for a parameter list is what FOLLOWS the parens, and `if (x) {` has the
  // same shape while binding nothing.
  const src = 'export function f(n) { if (n) { return elsewhere; } return 1; }\n';
  assert.equal(reachOf(src, 'f'), 'free name elsewhere');
});

test('a class METHOD NAME is a definition, not a free name', () => {
  // `constructor(message) { ... }` is neither a property access nor an object key, so
  // it read as a reference and refused five ordinary error classes in a real package.
  const src = 'class E { constructor(m) { this.m = m; } }\nexport function make(m) { return new E(m); }\n';
  assert.equal(reachOf(src, 'make'), null);
});

test("a regex literal's FLAGS are not an identifier", () => {
  // `stripNonCode` blanks a regex body and keeps what follows the slash, so `/\\+/g`
  // ends in a bare `g`. A division `x / g` has no second slash, which is how the two
  // are told apart without guessing from the letters.
  const src = 'export function clean(s) { return String(s).replace(/\\+/g, " "); }\n';
  assert.equal(reachOf(src, 'clean'), null);
});

test('a class reached by a function is judged for IMPURITY, not for probeability', () => {
  // `IMPURE_FUNCTION` adds generator/`this`/rest — rules about whether THIS function
  // can be probed, which say nothing about something it merely reaches. A constructor
  // assigning `this.code` is an ordinary class.
  const src = 'class E { constructor(c) { this.code = c; } }\n'
    + 'export function make(c) { return new E(c); }\n';
  assert.equal(reachOf(src, 'make'), null);
});

test('THE PROBE DOES NOT WRITE: a reachable side effect never runs', async () => {
  // The gate's reason for existing, asserted as behaviour rather than as a verdict.
  // Probing CALLS the function, so a wrong answer here is a real file on a real path.
  const witness = path.join(mkdtempSync(path.join(tmpdir(), 'assay-witness-')), 'w.txt');
  const dir = writeTree({
    'a.js': 'export function one(s) { return stamp(s); }\n'
      + 'export function two(s) { return stamp(s); }\n'
      + `function stamp(s) { require("fs").writeFileSync(${JSON.stringify(witness)}, String(s)); return String(s); }\n`,
  });
  const scan = await collect([dir]);
  assert.equal(scan.probed.size, 0);
  assert.equal(scan.skipped.size, 2);
  assert.throws(() => readdirSync(witness), /ENOENT/);
});

// --------------------------------------------------------------------------- //
// The census adds up, and says which unit each number is in.
// --------------------------------------------------------------------------- //

test('probed + not probed = functions, counting only files that loaded', async () => {
  const dir = writeTree({
    'good.js': 'export function f(n) { return n * 3 + 1; }\n'
      + 'export function g() { return 1; }\n',
    // REFUSED AT LOAD, which now means the clock is read ON THE WAY IN. A `new Date`
    // confined to a body no longer refuses the file — it refuses the function — so a
    // fixture that means "this file never opens" has to say so at module scope.
    'refused.js': 'export const started = Date.now();\n',
  });
  const scan = await collect([dir]);
  assert.equal(scan.functions, scan.probed.size + scan.skipped.size);
  assert.equal(scan.functions, 2);          // f probed, g skipped (no arguments)
  assert.equal(scan.unloadable.size, 1);    // refused.js, counted as a FILE
  assert.equal(scan.files, 2);
});

test('a clock in a BODY refuses the function, and the file still loads', async () => {
  // The whole point of splitting the gate. `formatDate` reads the clock when CALLED,
  // which is no evidence about importing the module — and refusing the file for it
  // took every pure helper beside it down, which on a barrel is the difference between
  // a useful run and a zero.
  const dir = writeTree({
    'helpers.js': 'export function sizeHuman(n) { return n + " B"; }\n'
      + 'export function formatDate(v) { return new Date(v).toISOString(); }\n',
  });
  const scan = await collect([dir]);
  assert.equal(scan.unloadable.size, 0);
  assert.equal(scan.functions, 2);
  assert.deepEqual([...scan.probed.keys()].map((r) => r.split('::')[1]), ['sizeHuman']);
  assert.match([...scan.skipped.values()][0], /reads the clock/);
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
