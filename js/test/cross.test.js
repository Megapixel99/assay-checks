/**
 * Comparing a JavaScript function to a Python one.
 *
 * Two things have to be true before that means anything, and both are asserted rather
 * than assumed:
 *
 *   1. THE TWO LADDERS HOLD IDENTICAL VALUES, not merely identically-versioned ones.
 *      One JSON document, carried by both halves, with its digest in the ladder key.
 *   2. THE OUTCOMES ARE COMPARABLE. `V:False` and `V:false` are two spellings of one
 *      answer, and the interlingua is where that is decided.
 *
 * These run the JAVASCRIPT half only, and that is on purpose: a suite that needs the
 * other runtime silently skips when it is missing, and a skip reports a pass for a
 * check that never ran. The Python side of a comparison arrives here as a RECORD,
 * which is exactly how it arrives in real use. `test_parity.py` is what pins the two
 * halves against each other.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/cli.js';
import {
  compareCross, crossDiscriminating, crossKey, crossLadder, crossOutcome,
  crossProjections, crossRender, CROSS_VALUES, PROBE_SCHEMA,
} from '../src/sameness.js';

async function cli(...argv) {
  let text = '';
  const code = await run(argv, (s) => { text += s; });
  return { code, text };
}

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'assay-cross-'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, name), body, 'utf8');
  }
  return root;
}

const YELL = 'export function yell(text) { return `${text.toUpperCase()}!`; }\n';

// --------------------------------------------------------------------------- //
// The interlingua
// --------------------------------------------------------------------------- //

test('the two booleans and the two absences render alike', () => {
  assert.equal(crossRender(true), 'true');
  assert.equal(crossRender(false), 'false');
  assert.equal(crossRender(null), 'null');
});

test('undefined and null are ONE absence here', () => {
  // Python has one absence and JavaScript has two, so the interlingua carries the one
  // both can state. It MERGES, and merging can only produce a `same` — the verdict
  // that fails — so it is the direction worth saying out loud.
  assert.equal(crossRender(undefined), crossRender(null));
});

test('an integral number and its float twin render alike', () => {
  // JavaScript has one number type, so Python's `2` and `2.0` are one number here.
  assert.equal(crossRender(2), crossRender(2.0));
  assert.equal(crossRender(3.5), '3.5');
  assert.equal(crossRender(-0.5), '-0.5');
  // A sign on a zero is not an answer either language gives on purpose.
  assert.equal(crossRender(-0), crossRender(0));
});

test('NaN and the infinities are spelled out', () => {
  // JSON cannot hold them and `JSON.stringify` turns all three into `null` — three
  // different answers reported as one absence.
  assert.equal(crossRender(NaN), 'NaN');
  assert.equal(crossRender(Infinity), 'Infinity');
  assert.equal(crossRender(-Infinity), '-Infinity');
});

test('object keys are SORTED', () => {
  // Two implementations differing only in insertion order are not differing.
  assert.equal(crossRender({ b: 1, a: 2 }), crossRender({ a: 2, b: 1 }));
});

test('a value the interlingua CANNOT STATE is refused, not approximated', () => {
  // `JSON.stringify` would flatten several of these into `{}` — one answer standing in
  // for four. Rendering approximately is inventing a fact about a value this cannot
  // read.
  assert.equal(crossRender(new Map()), null);
  assert.equal(crossRender(new Set([1])), null);
  assert.equal(crossRender(new Date(0)), null);
  assert.equal(crossRender(10n), null);
  assert.equal(crossRender({ nested: new Map() }), null);
});

test('an unstatable value becomes an X outcome', async () => {
  const outcome = await crossOutcome(() => new Map(), [1]);
  assert.match(outcome, /^X:/);
});

test('a THROW carries no NAME', async () => {
  // The two languages' error taxonomies diverge, so naming them would make every
  // honest pair `differs`. Declaring them equal is worse: `same` is the verdict that
  // FAILS, so a wrong equality manufactures findings.
  const outcome = await crossOutcome(() => { throw new RangeError('nope'); }, [1]);
  assert.equal(outcome, 'E:*');
});

// --------------------------------------------------------------------------- //
// The shared ladder
// --------------------------------------------------------------------------- //

test('the ladder is ONE JSON DOCUMENT parsed by each half', () => {
  assert.ok(CROSS_VALUES.includes('½'));
  assert.ok(CROSS_VALUES.includes(''));
  assert.ok(CROSS_VALUES.includes(null));
});

test('the KEY carries a DIGEST of the rungs', () => {
  // `arity1/v3` says two vectors came from ladders with the same NAME. The whole
  // hazard across languages is two lists that were meant to hold the same values and
  // quietly stopped, and a name cannot see that.
  const key = crossKey(1);
  assert.match(key, /^cross1\/v3\/[0-9a-f]{12}$/);
  assert.notEqual(crossKey(1), crossKey(2));
});

test('every rung is expressible in the interlingua', () => {
  for (const args of crossLadder(2)) {
    for (const value of args) assert.notEqual(crossRender(value), null);
  }
});

test('the rungs are DEDUPLICATED and deterministic', () => {
  const first = crossLadder(2);
  assert.deepEqual(first, crossLadder(2));
  assert.equal(new Set(first.map((a) => JSON.stringify(a))).size, first.length);
});

// --------------------------------------------------------------------------- //
// Comparing
// --------------------------------------------------------------------------- //

test('a rung where BOTH threw is MASKED', () => {
  // Two refusals that may have nothing to do with each other. Counting it as agreement
  // would let two functions that share only their type errors be reported as one.
  // The answered rungs are deliberately NOT the identity, or the vacuity guard would
  // refuse the pair for that instead.
  const rungs = [[0], [1], [2]];
  const [verdict] = compareCross(['E:*', 'V:10', 'V:20'], ['E:*', 'V:10', 'V:20'],
    'k', 'k', rungs);
  assert.equal(verdict, 'same');
});

test('a rung where ONE threw is a WITNESS', () => {
  const rungs = [[0], [1], [2]];
  const [verdict, detail] = compareCross(['E:*', 'V:10', 'V:20'],
    ['V:0', 'V:10', 'V:20'], 'k', 'k', rungs);
  assert.equal(verdict, 'differs');
  assert.match(detail, /E:\* vs V:0/);
});

test('two vectors from DIFFERENT ladders are refused', () => {
  const [verdict, detail] = compareCross(['V:1'], ['V:1'], 'cross1/v3/aaa',
    'cross1/v3/bbb', [[0]]);
  assert.equal(verdict, 'look');
  assert.match(detail, /not comparable/);
});

test('an outcome the interlingua cannot state is a LOOK', () => {
  const [verdict, detail] = compareCross(['X:Map', 'V:1'], ['V:0', 'V:1'], 'k', 'k',
    [[0], [1]]);
  assert.equal(verdict, 'look');
  assert.match(detail, /cannot state/);
});

test('a CONSTANT is not discriminated', () => {
  const rungs = crossLadder(1);
  assert.equal(crossDiscriminating(new Array(rungs.length).fill('V:1'), rungs), null);
});

test('a PROJECTION is not discriminated', () => {
  const rungs = crossLadder(1);
  assert.equal(crossDiscriminating(crossProjections(rungs)[0], rungs), null);
});

// --------------------------------------------------------------------------- //
// The probe record, and the comparison
// --------------------------------------------------------------------------- //

test('probe writes a record on STDOUT with the ladder it used', async () => {
  const root = tree({ 'ui.mjs': YELL });
  const { code, text } = await cli('probe', `${path.join(root, 'ui.mjs')}::yell`);
  assert.equal(code, 0, text);
  const record = JSON.parse(text);
  assert.equal(record.assay_probe, PROBE_SCHEMA);
  assert.equal(record.language, 'javascript');
  assert.equal(record.ladder, crossKey(1));
  assert.equal(record.vector.length, crossLadder(1).length);
});

test('its KEYS are SORTED', () => {
  // The Python half sorts too. One record written as two different documents is one
  // contract with two implementations, which is the duplication this package finds.
  const root = tree({ 'ui.mjs': YELL });
  return cli('probe', `${path.join(root, 'ui.mjs')}::yell`).then(({ text }) => {
    const keys = Object.keys(JSON.parse(text));
    assert.deepEqual(keys, [...keys].sort());
  });
});

test('a reference that names nothing is exit 2 AND STILL A RECORD', async () => {
  // ONE SHAPE, ALWAYS, and `--json` is not what decides it here: this command's output
  // IS JSON, so there is no prose form to switch away from. A consumer never has to ask
  // which of two shapes it received, and `2` still means the tool could not run.
  const { code, text } = await cli('probe', 'nowhere.js::x');
  assert.equal(code, 2);
  const record = JSON.parse(text);
  assert.equal(record.assay_probe, PROBE_SCHEMA);
  assert.ok(record.error);
  assert.equal(record.vector, undefined);
});

test('a record that SUCCEEDED carries a null error', async () => {
  const root = tree({ 'ui.mjs': YELL });
  const { text } = await cli('probe', `${path.join(root, 'ui.mjs')}::yell`);
  assert.equal(JSON.parse(text).error, null);
});

test('--json changes NOTHING about probe', async () => {
  // It is already the JSON command. A `--json` that produced a second shape here would
  // be the thing `--json` exists to prevent.
  const root = tree({ 'ui.mjs': YELL });
  const ref = `${path.join(root, 'ui.mjs')}::yell`;
  const plain = JSON.parse((await cli('probe', ref)).text);
  const flagged = JSON.parse((await cli('--json', 'probe', ref)).text);
  assert.deepEqual(plain.vector, flagged.vector);
});

test('a REFUSED function is a record with a look, not an error', async () => {
  // The reference resolved and the tool ran, so this is not exit 2 — and a consumer
  // gets one shape either way.
  const root = tree({ 'ui.mjs': 'export function nullary() { return 1; }\n' });
  const { code, text } = await cli('probe', `${path.join(root, 'ui.mjs')}::nullary`);
  assert.equal(code, 0, text);
  const record = JSON.parse(text);
  assert.ok(record.look);
  assert.equal(record.vector, undefined);
});

/** A Python-side record, written by hand — a record is a record whoever wrote it. */
function pythonRecord(root, vector, extra = {}) {
  const file = path.join(root, 'side.json');
  writeFileSync(file, JSON.stringify({
    assay_probe: PROBE_SCHEMA,
    ref: 'api.py::shout',
    language: 'python',
    arity: 1,
    ladder: crossKey(1),
    vector,
    ...extra,
  }), 'utf8');
  return file;
}

async function jsVector(root) {
  const { text } = await cli('probe', `${path.join(root, 'ui.mjs')}::yell`);
  return JSON.parse(text).vector;
}

test('two halves that AGREE are a finding', async () => {
  // `same` is not proof, and it is the verdict that fails: something a person must read.
  const root = tree({ 'ui.mjs': YELL });
  const other = pythonRecord(root, await jsVector(root));
  const { code, text } = await cli('cross', `${path.join(root, 'ui.mjs')}::yell`, other);
  assert.equal(code, 1, text);
  assert.match(text, /same answer across languages/);
});

test('a WITNESS is an ok rather than a finding', async () => {
  // `differs` is proof, and proof of difference is the good outcome.
  const root = tree({ 'ui.mjs': YELL });
  const vector = await jsVector(root);
  vector[12] = 'V:"different"';
  const other = pythonRecord(root, vector);
  const { code, text } = await cli('cross', `${path.join(root, 'ui.mjs')}::yell`, other);
  assert.equal(code, 0, text);
  assert.match(text, /differs:/);
});

test('a record from ANOTHER SCHEMA is refused', async () => {
  // Comparing a new answer against the wrong earlier answer is precisely the defect a
  // difference checker exists to catch.
  const root = tree({ 'ui.mjs': YELL });
  const other = pythonRecord(root, await jsVector(root),
    { assay_probe: PROBE_SCHEMA + 99 });
  const { code, text } = await cli('cross', `${path.join(root, 'ui.mjs')}::yell`, other);
  assert.equal(code, 2);
  assert.match(text, /schema/);
});

test('a record from ANOTHER LADDER is a look, not a comparison', async () => {
  const root = tree({ 'ui.mjs': YELL });
  const other = pythonRecord(root, await jsVector(root),
    { ladder: 'cross1/v3/deadbeefcafe' });
  const { code, text } = await cli('cross', `${path.join(root, 'ui.mjs')}::yell`, other);
  assert.equal(code, 0, text);
  assert.match(text, /not comparable/);
});

test('a side that could not be PROBED is a look', async () => {
  const root = tree({ 'ui.mjs': YELL });
  const file = pythonRecord(root, [], { look: 'reads the clock' });
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  delete raw.vector;
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  const { code, text } = await cli('cross', `${path.join(root, 'ui.mjs')}::yell`, file);
  assert.equal(code, 0, text);
  assert.match(text, /could not be probed/);
});

test('TWO JAVASCRIPT references are a look pointing at `pair`', async () => {
  // The cross ladder is a subset of what one language can express. Two functions of
  // one language deserve the stronger instrument.
  const root = tree({
    'ui.mjs': `${YELL}export function bellow(t) { return \`\${t.toUpperCase()}!\`; }\n`,
  });
  const ref = path.join(root, 'ui.mjs');
  const { code, text } = await cli('cross', `${ref}::yell`, `${ref}::bellow`);
  assert.equal(code, 0, text);
  assert.match(text, /`pair`/);
});

test('a PYTHON reference without --with says exactly what to run', async () => {
  // The two halves do not invoke each other: neither package can assume the other is
  // installed, and a command that shells out to a binary that may not exist fails in a
  // way that reads like the code being wrong.
  const root = tree({ 'ui.mjs': YELL, 'api.py': 'def shout(t):\n    return t\n' });
  const { code, text } = await cli('cross', `${path.join(root, 'ui.mjs')}::yell`,
    `${path.join(root, 'api.py')}::shout`);
  assert.equal(code, 2);
  assert.match(text, /assay probe/);
  assert.match(text, /--with/);
});

test('cross answers in JSON when asked', async () => {
  // `cross` builds a Report like every other audit, so it emits the envelope — and a
  // refusal emits it too, with `error` set and `items` empty.
  const root = tree({ 'ui.mjs': YELL });
  const other = pythonRecord(root, await jsVector(root));
  const ref = `${path.join(root, 'ui.mjs')}::yell`;
  const data = JSON.parse((await cli('--json', 'cross', ref, other)).text);
  assert.equal(data.error, null);
  assert.equal(data.exit_code, 1);
  assert.equal(data.items[0].verdict, 'finding');
  const refused = JSON.parse((await cli('--json', 'cross', ref, 'notes.txt::x')).text);
  assert.equal(refused.exit_code, 2);
  assert.match(refused.error, /no language/);
  assert.deepEqual(refused.items, []);
});

test('a reference in NO KNOWN LANGUAGE exits 2', async () => {
  const root = tree({ 'ui.mjs': YELL });
  const { code, text } = await cli('cross', `${path.join(root, 'ui.mjs')}::yell`,
    'notes.txt::something');
  assert.equal(code, 2);
  assert.match(text, /no language/);
});
