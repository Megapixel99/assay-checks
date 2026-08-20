/**
 * Config, and the rule that every table is read in BOTH directions.
 *
 * The Python and JavaScript implementations must agree on this format or one
 * `assay.json` cannot serve a polyglot repository, so these mirror
 * `tests/test_config.py` case for case.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Config, ConfigError, applyBaseline, load } from '../src/config.js';
import { Item } from '../src/verdicts.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function writeConfig(payload, name = 'assay.json') {
  const root = mkdtempSync(path.join(tmpdir(), 'assay-config-'));
  const file = path.join(root, name);
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return [root, file];
}

test('an ABSENT config is an empty one, not an error', () => {
  // The tool must work on a project that has never heard of it.
  const config = load(null, mkdtempSync(path.join(tmpdir(), 'assay-none-')));
  assert.equal(config.runnerExempt.size, 0);
  assert.deepEqual(config.baseline, []);
  assert.equal(config.path, null);
});

test('a config named in full that is missing IS an error', () => {
  // Asking for a specific file and silently getting none hides a typo.
  assert.throws(() => load(path.join(tmpdir(), 'assay-nope.json')), ConfigError);
});

test('broken JSON is a hard error, not a silent empty config', () => {
  // Ignoring it would run the audit with none of the judgment the file carries.
  const [, file] = writeConfig('{not json');
  assert.throws(() => load(file), /not valid JSON/);
});

test('a dotfile name is found too', () => {
  const [root] = writeConfig({ baseline: ['x'] }, '.assay.json');
  assert.deepEqual(load(null, root).baseline, ['x']);
});

test('an exemption without a REASON is refused', () => {
  // An exemption with no reason cannot be told from an oversight.
  const [, file] = writeConfig({
    runner_exempt: [{ path: 'a.js', property: 'sigterm' }],
  });
  assert.throws(() => load(file), /reason/);
});

test('a baseline that is not a list of strings is refused', () => {
  const [, file] = writeConfig({ baseline: [{ msg: 'x' }] });
  assert.throws(() => load(file), ConfigError);
});

test('a star exemption covers every property', () => {
  const [, file] = writeConfig({
    runner_exempt: [{ path: 'a.js', property: '*', reason: 'r' }],
  });
  const config = load(file);
  assert.equal(config.exemptRunner('a.js', 'sigterm'), 'r');
  assert.equal(config.exemptRunner('a.js', 'evidence'), 'r');
});

test('a named exemption covers only that property', () => {
  const [, file] = writeConfig({
    runner_exempt: [{ path: 'a.js', property: 'sigterm', reason: 'r' }],
  });
  const config = load(file);
  assert.equal(config.exemptRunner('a.js', 'sigterm'), 'r');
  assert.equal(config.exemptRunner('a.js', 'evidence'), null);
});

test('the property field defaults to star', () => {
  const [, file] = writeConfig({ runner_exempt: [{ path: 'a.js', reason: 'r' }] });
  assert.equal(load(file).exemptRunner('a.js', 'anything'), 'r');
});

test('an exemption key survives a round trip through the file', () => {
  // The lookup key is built by joining a path and a property with a separator, and a
  // Map lookup that silently misses is invisible: the audit simply reports the finding
  // the exemption was written to silence, and reads as if the file were never there.
  const [, file] = writeConfig({
    runner_exempt: [{ path: 'deep/nest/mutations_a.js', property: 'sigterm', reason: 'r' }],
  });
  assert.equal(load(file).exemptRunner('deep/nest/mutations_a.js', 'sigterm'), 'r');
});

// --------------------------------------------------------------------------- //
// Baseline
// --------------------------------------------------------------------------- //

const findings = (...messages) => messages.map((m) => new Item('finding', m));

test('an accepted finding stops failing', () => {
  const [still, stale] = applyBaseline(findings('old problem'), ['old problem']);
  assert.deepEqual(still, []);
  assert.deepEqual(stale, []);
});

test('a NEW finding still fails', () => {
  const [still] = applyBaseline(findings('old', 'new'), ['old']);
  assert.deepEqual(still.map((f) => f.message), ['new']);
});

test('a baseline line that no longer fires is ITSELF a finding', () => {
  // The second direction. Someone fixed it and left the record claiming otherwise,
  // which is how a suppression file becomes a work of fiction.
  const [still, stale] = applyBaseline(findings(), ['fixed long ago']);
  assert.deepEqual(still, []);
  assert.deepEqual(stale, ['fixed long ago']);
});

test('an empty baseline changes nothing', () => {
  const [still, stale] = applyBaseline(findings('a'), []);
  assert.equal(still.length, 1);
  assert.deepEqual(stale, []);
});

test('matching is on the exact message, not a prefix', () => {
  // A prefix match would let one accepted line silence a family of findings.
  const [still] = applyBaseline(findings('problem in a.js'), ['problem in']);
  assert.equal(still.length, 1);
});

// --------------------------------------------------------------------------- //
// A byte-level guard, earned by a real defect
// --------------------------------------------------------------------------- //

test('no source file contains a NUL byte', () => {
  // A NUL landed where a space belonged inside a template literal here. Every way of
  // reading the code agreed it was correct — the file displayed correctly, the parser
  // accepted it, and `Function.prototype.toString` printed a space — while the key it
  // built at runtime could never match. The failure was invisible to everything except
  // a byte-level check, so this is the byte-level check.
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs|json)$/.test(name)) {
        assert.ok(!readFileSync(full).includes(0), `${full} contains a NUL byte`);
      }
    }
  };
  walk(SRC);
});
