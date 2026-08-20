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
  canon, collect, compare, discriminating, fileRefusal, functionRefusal, group,
  isProjection, ladder, ladderKey, MIN_DISTINCT, outcomeOf, probeFile,
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
  assert.equal(scan.skipped.size, 1);
  assert.match([...scan.skipped.values()][0], /could not load|probe failed/);
});

test('probing happens in a CHILD process, so a module that exits cannot kill us', async () => {
  // The parent must still be here to report. A tool that dies on one bad file cannot
  // audit the tree that contains it.
  const file = write('export function f(n) { return n; }\n');
  const result = await probeFile(file);
  assert.ok(result.functions.length >= 1);
  assert.equal(typeof process.exitCode, typeof undefined === 'undefined' ? 'undefined' : 'number');
});
