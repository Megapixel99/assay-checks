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

import { Accepted, Config, ConfigError, applyBaseline, load } from '../src/config.js';
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
  assert.deepEqual(load(null, root).baselineLines, ['x']);
});

test('an exemption without a REASON is refused', () => {
  // An exemption with no reason cannot be told from an oversight.
  const [, file] = writeConfig({
    runner_exempt: [{ path: 'a.js', property: 'sigterm' }],
  });
  assert.throws(() => load(file), /reason/);
});

test('a baseline entry that is neither a line nor an object is refused', () => {
  const [, file] = writeConfig({ baseline: [42] });
  assert.throws(() => load(file), ConfigError);
});

test('a baseline entry in OBJECT form carries a reason and what fires it', () => {
  // A bare string stays legal — adopting this means pasting lines out of a run, and a
  // format that refuses the paste is a format nobody adopts.
  const [, file] = writeConfig({
    baseline: [
      'pasted straight out of a run',
      { line: 'read and accepted', reason: 'the fix is the 0.3 job', from: 'anchors' },
    ],
  });
  const config = load(file);
  assert.deepEqual(config.baselineLines,
    ['pasted straight out of a run', 'read and accepted']);
  assert.equal(config.baseline[0].reason, null);
  assert.equal(config.baseline[0].producedBy, null);
  assert.equal(config.baseline[1].reason, 'the fix is the 0.3 job');
  assert.equal(config.baseline[1].producedBy, 'anchors');
});

test('an object-form entry without a REASON is refused', () => {
  // The same rule an exemption follows, about the table that rots fastest: an
  // acceptance without one cannot be told from an oversight.
  const [, file] = writeConfig({ baseline: [{ line: 'a finding' }] });
  assert.throws(() => load(file), /reason/);
});

test('an object-form entry without a LINE is refused', () => {
  const [, file] = writeConfig({ baseline: [{ reason: 'because' }] });
  assert.throws(() => load(file), /line/);
});

test('a `from` naming no real command is refused', () => {
  // Read in both directions, like every other table here. A `from` nothing can
  // produce would make the line permanently uncheckable, in silence.
  const [, file] = writeConfig({
    baseline: [{ line: 'a finding', reason: 'r', from: 'lint' }],
  });
  assert.throws(() => load(file), /from/);
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
const accept = (...lines) => lines.map((l) => new Accepted(l));
const lines = (entries) => entries.map((e) => e.line);
const EVERY = ['runners', 'anchors', 'diff', 'scan'];

test('an accepted finding stops failing', () => {
  const [still, stale] = applyBaseline(findings('old problem'), accept('old problem'),
    EVERY);
  assert.deepEqual(still, []);
  assert.deepEqual(stale, []);
});

test('a NEW finding still fails', () => {
  const [still] = applyBaseline(findings('old', 'new'), accept('old'), EVERY);
  assert.deepEqual(still.map((f) => f.message), ['new']);
});

test('a baseline line that no longer fires is ITSELF a finding', () => {
  // The second direction. Someone fixed it and left the record claiming otherwise,
  // which is how a suppression file becomes a work of fiction.
  const [still, stale] = applyBaseline(findings(), accept('fixed long ago'), EVERY);
  assert.deepEqual(still, []);
  assert.deepEqual(lines(stale), ['fixed long ago']);
});

test('an empty baseline changes nothing', () => {
  const [still, stale] = applyBaseline(findings('a'), [], EVERY);
  assert.equal(still.length, 1);
  assert.deepEqual(stale, []);
});

test('matching is on the exact message, not a prefix', () => {
  // A prefix match would let one accepted line silence a family of findings.
  const [still] = applyBaseline(findings('problem in a.js'), accept('problem in'),
    EVERY);
  assert.equal(still.length, 1);
});

// --------------------------------------------------------------------------- //
// Staleness is per LINE, not per run
// --------------------------------------------------------------------------- //

test('an UNTAGGED line is unchecked by a partial run and stale by a complete one', () => {
  // Nothing narrower than every audit knows what could have produced it, so a partial
  // run has no business calling it fixed.
  const entry = new Accepted('some finding', 'read it', null);
  const partial = applyBaseline(findings(), [entry], ['runners']);
  assert.deepEqual(partial[1], []);
  assert.deepEqual(lines(partial[2]), ['some finding']);
  const complete = applyBaseline(findings(), [entry], EVERY);
  assert.deepEqual(lines(complete[1]), ['some finding']);
  assert.deepEqual(complete[2], []);
});

test('a TAGGED line is answered by the one command that fires it', () => {
  // The point of `from`: `assay runners` knows perfectly well whether a `runners`
  // finding fired, and needed a whole `assay all` to be allowed to say so.
  const entry = new Accepted('a runners finding', 'read it', 'runners');
  const [, stale, unchecked] = applyBaseline(findings(), [entry], ['runners']);
  assert.deepEqual(lines(stale), ['a runners finding']);
  assert.deepEqual(unchecked, []);
});

test('a line THIS RUN COULD NOT SEE is never called stale', () => {
  // The cry-wolf failure, and the reason the first fix was a whole-run flag.
  const entry = new Accepted('an anchors finding', 'read it', 'anchors');
  const [, stale, unchecked] = applyBaseline(findings(), [entry], ['runners', 'diff']);
  assert.deepEqual(stale, []);
  assert.deepEqual(lines(unchecked), ['an anchors finding']);
});

test('a tagged line that FIRED is suppressed whatever the run performed', () => {
  // Suppression is safe from any run: a line that fires is a line that fires.
  const entry = new Accepted('an anchors finding', 'read it', 'anchors');
  const [still, stale, unchecked] = applyBaseline(findings('an anchors finding'),
    [entry], []);
  assert.deepEqual(still, []);
  assert.deepEqual(stale, []);
  assert.deepEqual(unchecked, []);
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
