/**
 * The shared verdict vocabulary. Both halves depend on these rules holding.
 *
 * The Python and JavaScript implementations must agree here or one `assay.json` cannot
 * serve a polyglot repository, so these mirror `tests/test_verdicts.py` case for case.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FINDING, Item, Report, render } from '../src/verdicts.js';

function rendered(report, options) {
  let text = '';
  const code = render(report, (s) => { text += s; }, options);
  return { code, text };
}

test('an unknown verdict is refused at construction', () => {
  assert.throws(() => new Item('probably', 'something'), TypeError);
});

test('a look NEVER changes the exit code', () => {
  const report = new Report().look('could not decide').look('nor this');
  assert.equal(report.exitCode(), 0);
});

test('one finding fails', () => {
  assert.equal(new Report().finding('this is wrong').exitCode(), 1);
});

test('ok items never fail', () => {
  assert.equal(new Report().ok('checked and fine').exitCode(), 0);
});

test('findings survive being mixed with looks', () => {
  const report = new Report().look('a').finding('b').ok('c');
  assert.equal(report.exitCode(), 1);
  assert.equal(report.findings.length, 1);
  assert.equal(report.looks.length, 1);
  assert.equal(report.oks.length, 1);
});

test('extend keeps both reports items and notes', () => {
  const a = new Report().finding('a').note('count: 1');
  const b = new Report().look('b').note('count: 2');
  a.extend(b);
  assert.equal(a.items.length, 2);
  assert.deepEqual(a.sections, ['count: 1', 'count: 2']);
});

test('no findings says so rather than printing nothing', () => {
  // Silence and success are different claims, and only one of them is evidence.
  const { code, text } = rendered(new Report().ok('a thing'));
  assert.equal(code, 0);
  assert.match(text, /no findings/);
});

test('looks print under a heading that says they do not fail', () => {
  const { code, text } = rendered(new Report().look('cannot decide this'));
  assert.equal(code, 0);
  assert.match(text, /LOOK/);
  assert.match(text, /never fail/);
});

test("a finding's detail is printed below it", () => {
  const report = new Report();
  report.finding('the thing', null, 'because X');
  const { text } = rendered(report);
  assert.match(text, /the thing/);
  assert.match(text, /because X/);
});

test('quiet still prints findings because that is the point', () => {
  const report = new Report().finding('the thing').ok('fine');
  const { code, text } = rendered(report, { verbose: false });
  assert.equal(code, 1);
  assert.match(text, /the thing/);
  assert.doesNotMatch(text, /fine/);
});

test('the exit code is 1 only for findings, never for looks or oks', () => {
  assert.equal(new Report().exitCode(), 0);
  assert.equal(new Report().ok('a').look('b').exitCode(), 0);
  assert.equal(new Report().ok('a').look('b').finding('c').exitCode(), 1);
  assert.equal(FINDING, 'finding');
});
