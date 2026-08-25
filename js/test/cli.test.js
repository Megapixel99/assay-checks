/**
 * The CLI contract: one exit-code rule across every subcommand.
 *
 * Scripts depend on the exit code more than on anything printed, so the codes are
 * tested per subcommand rather than once. `2` must mean "the tool could not run" and
 * never "the tool found nothing" — collapsing those two is how a broken invocation
 * reads as a clean audit in CI. The Python half is tested the same way, and the two
 * must agree or a polyglot project gets different answers from one config.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseArgs, run } from '../src/cli.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'js', 'src', 'cli.js');

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

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'assay-cli-'));
  // A throwaway project must DECLARE its module type, and this is not fixture
  // tidiness. A `.js` file containing `export` in a directory with no
  // `package.json` is a SyntaxError on Node 18 and loads fine on Node 22, because
  // module-syntax detection arrived in between. Without this the suite passes on
  // a new Node and fails on an old one for a reason that has nothing to do with
  // the code under test — and a real project always has a package.json, so the
  // fixture was the unrealistic thing.
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

async function cli(...argv) {
  let text = '';
  const code = await run(argv, (s) => { text += s; });
  return { code, text };
}

// --------------------------------------------------------------------------- //
// Flag placement
// --------------------------------------------------------------------------- //

test('a global flag works on BOTH sides of the subcommand', () => {
  // `assay scan src -q` is how people type it. A parser that only accepts one order
  // is one people work around rather than learn.
  assert.equal(parseArgs(['-q', 'scan', 'X']).quiet, true);
  assert.equal(parseArgs(['scan', 'X', '-q']).quiet, true);
  assert.equal(parseArgs(['scan', 'X']).quiet, false);
  assert.equal(parseArgs(['--root', 'R', 'scan', 'X']).root, 'R');
  assert.equal(parseArgs(['scan', 'X', '--root', 'R']).root, 'R');
});

test('--in collects several paths and stops at the next flag', () => {
  const opts = parseArgs(['search', 'a.js::f', '--in', 'src', 'lib', '-q']);
  assert.deepEqual(opts.into, ['src', 'lib']);
  assert.equal(opts.quiet, true);
  assert.deepEqual(opts.positional, ['a.js::f']);
});

// --------------------------------------------------------------------------- //
// Exit codes
// --------------------------------------------------------------------------- //

test('no subcommand prints usage and exits 2', async () => {
  const { code, text } = await cli();
  assert.equal(code, 2);
  assert.match(text, /usage/);
});

test('an unknown subcommand exits 2 rather than doing nothing quietly', async () => {
  const { code, text } = await cli('frobnicate');
  assert.equal(code, 2);
  assert.match(text, /unknown command/);
});

test('scan exits 1 when it finds a group', async () => {
  const { code, text } = await cli('scan', tree({ 'm.js': TWINS }));
  assert.equal(code, 1);
  assert.match(text, /same answer/);
});

test('scan exits 0 when it finds nothing', async () => {
  const root = tree({ 'm.js': 'export function a(n) { return n * 2; }\n' });
  const { code, text } = await cli('scan', root);
  assert.equal(code, 0);
  assert.match(text, /no findings/);
});

test('pair reports differs as an OK, not a finding', async () => {
  // A witness is the good outcome: it proves the two are different.
  const root = tree({
    'm.js': 'export function a(n) { return n * 2; }\nexport function b(n) { return n + 2; }\n',
  });
  const file = path.join(root, 'm.js');
  const { code, text } = await cli('pair', `${file}::a`, `${file}::b`);
  assert.equal(code, 0);
  assert.match(text, /differs/);
});

test('pair reports same as a finding', async () => {
  const file = path.join(tree({ 'm.js': TWINS }), 'm.js');
  const { code } = await cli('pair', `${file}::a`, `${file}::b`);
  assert.equal(code, 1);
});

test('pair exits 2 on a reference it cannot resolve', async () => {
  const file = path.join(tree({ 'm.js': TWINS }), 'm.js');
  const { code, text } = await cli('pair', `${file}::a`, `${file}::nosuch`);
  assert.equal(code, 2);
  assert.match(text, /no function named/);
});

test('a function that CANNOT be probed is a look, not a failed run', async () => {
  // 2 must mean "the tool could not run" and never "the tool found nothing". A
  // function that exists and is refused — a generator here — is a `look`: the tool ran
  // and cannot decide. Collapsing that into 2 is how a broken invocation and an
  // undecidable one become indistinguishable to a script. The Python half splits them
  // the same way, and the exit codes are the contract both halves publish.
  const root = tree({
    'm.js': 'export function* a(n) { yield n * 2; }\n'
      + 'export function b(n) { return n * 2; }\n',
  });
  const file = path.join(root, 'm.js');
  const { code, text } = await cli('pair', `${file}::a`, `${file}::b`);
  assert.equal(code, 0, text);
  assert.match(text, /look/);
  assert.match(text, /generator/);
});

test('search says the tree was NOT searched when the query cannot be probed', async () => {
  // "Nothing answers this" and "we never asked" are different claims, and only the
  // second one is true here.
  const root = tree({ 'm.js': 'export function* a(n) { yield n * 2; }\n' });
  const { code, text } = await cli('search', `${path.join(root, 'm.js')}::a`,
    '--in', root);
  assert.equal(code, 0, text);
  assert.match(text, /the tree was not searched/);
});

test('search does not hide a twin that shares the query name', async () => {
  // Excluding every ref that ENDS in the query's name hides the answer the command
  // exists to find: a second implementation called the same thing is still a second
  // implementation. Only the query itself is excluded.
  const root = tree({
    'a.js': 'export function dup(s) {\n'
      + "  if (typeof s !== 'string') throw new TypeError('str');\n"
      + "  return s.split('').reverse().join('');\n}\n",
    'b.js': 'export function dup(t) {\n'
      + "  if (typeof t !== 'string') throw new TypeError('str');\n"
      + "  let r = '';\n  for (const c of t) r = c + r;\n  return r;\n}\n",
  });
  const { code, text } = await cli('search', `${path.join(root, 'a.js')}::dup`,
    '--in', root);
  assert.equal(code, 1, text);
  assert.match(text, /already answers/);
  assert.match(text, /b\.js::dup/);
});

test('a reference without :: is refused with the reason named', async () => {
  const { code, text } = await cli('pair', 'a.js', 'b.js');
  assert.equal(code, 2);
  assert.match(text, /FILE::NAME/);
});

test('search finds what the tree already answers', async () => {
  const root = tree({ 'm.js': TWINS });
  const { code, text } = await cli('search', `${path.join(root, 'm.js')}::a`, '--in', root);
  assert.equal(code, 1);
  assert.match(text, /already answers/);
});

test('search that finds nothing exits 0 and says so', async () => {
  const root = tree({ 'm.js': 'export function only(n) { return n * 3 + 1; }\n' });
  const { code, text } = await cli('search', `${path.join(root, 'm.js')}::only`,
    '--in', root);
  assert.equal(code, 0);
  assert.match(text, /none/);
});

test('search without --in exits 2 rather than searching nothing', async () => {
  const { code, text } = await cli('search', 'a.js::f');
  assert.equal(code, 2);
  assert.match(text, /--in/);
});

test('runners on a project with none exits 0', async () => {
  const { code } = await cli('--root', tree({ 'a.js': 'export const x = 1;\n' }), 'runners');
  assert.equal(code, 0);
});

test('a broken config exits 2 rather than auditing without it', async () => {
  const root = tree({ 'a.js': 'export const x = 1;\n', 'assay.json': '{not json' });
  const { code, text } = await cli('--root', root, 'runners');
  assert.equal(code, 2);
  assert.match(text, /not valid JSON/);
});

test('anchors names itself as Python-only rather than shipping a weak version', async () => {
  // A regex that reports confident nonsense about which strings are anchors would be
  // worse than the gap, and a silent no-op would be worse still.
  const { code, text } = await cli('anchors');
  assert.equal(code, 2);
  assert.match(text, /Python/);
});

// --------------------------------------------------------------------------- //
// Config wiring
// --------------------------------------------------------------------------- //

test('a baseline entry turns a finding into a pass', async () => {
  const root = tree({ 'm.js': TWINS });
  const first = await cli('scan', root, '-q');
  assert.equal(first.code, 1);
  const message = first.text.split('finding  ')[1].split('\n')[0];

  const configRoot = tree({ 'assay.json': JSON.stringify({ baseline: [message] }) });
  const { code, text } = await cli('--root', configRoot, 'scan', root);
  assert.equal(code, 0, text);
  assert.match(text, /1 accepted/);
});

test('a PARTIAL run does not call a baseline entry stale', async () => {
  // The flaw this rule exists for, caught on this tool's own repository. `scan`
  // cannot produce a finding that only `diff` reports, so calling a line stale from
  // it marks every `diff` line as fixed — the audit reporting a problem with its own
  // config, on a clean tree, on every run. A check that cries wolf at itself is the
  // one nobody keeps. The Python half is tested the same way.
  const root = tree({
    'assay.json': JSON.stringify({ baseline: ['a diff-only finding'] }),
    'm.js': 'export function a(n) { return n * 2; }\n',
  });
  const { code, text } = await cli('--root', root, 'scan', root);
  assert.equal(code, 0, text);
  assert.doesNotMatch(text, /no longer fires/);
  assert.match(text, /staleness needs/);
});

test('and NAMES the half that can, rather than printing 0 stale', async () => {
  // No command here performs every audit able to produce a baseline line, because
  // `anchors` is Python-only. `0 stale` would read as "nothing is stale", which is a
  // different claim from "this half never looked".
  const root = tree({
    'assay.json': JSON.stringify({ baseline: ['a finding long gone'] }),
    'm.js': 'export function a(n) { return n * 2; }\n',
  });
  const { text } = await cli('--root', root, 'scan', root);
  assert.match(text, /staleness needs the Python `assay all`/);
  assert.match(text, /anchors/);
});

test('all folds in the sameness half when asked', async () => {
  // Without `--scan` a `same answer` line in the baseline would belong to a run that
  // never scanned anything. The Python half takes the same flag.
  const root = tree({ 'm.js': TWINS });
  const { code, text } = await cli('--root', root, 'all', '--base', 'HEAD',
    '--scan', root);
  assert.equal(code, 1, text);
  assert.match(text, /same answer/);
});

// --------------------------------------------------------------------------- //
// As a real process
// --------------------------------------------------------------------------- //

test('it runs as a program from an UNRELATED cwd', () => {
  // A tool that only works from its own directory cannot be wired into CI.
  const root = tree({ 'm.js': TWINS });
  let status = 0;
  try {
    execFileSync(process.execPath, [CLI, 'scan', root],
      { cwd: mkdtempSync(path.join(tmpdir(), 'assay-elsewhere-')), encoding: 'utf8' });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 1);
});

test('it runs through a SYMLINK, which is how npm installs the command', () => {
  // THE SYMLINK IS CREATED HERE rather than assumed, for the reason the symlink guard
  // in `changedFiles` learned the same way: a test that relies on the platform having
  // one is exercised by accident on some machines and not at all on others.
  //
  // `npm` installs a `bin` as a link — `node_modules/.bin/assay` pointing at
  // `node_modules/assay-checks/js/src/cli.js` — so `process.argv[1]` is the link and
  // `import.meta.url` is its target. Comparing them unresolved made the published
  // command do nothing, print nothing and exit 0: "the tool ran and found nothing",
  // from a tool that never ran. Both 0.1.0 and 0.2.0 shipped that way.
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-bin-'));
  const link = path.join(dir, 'assay');
  symlinkSync(CLI, link);

  const printed = execFileSync(process.execPath, [link, '--version'],
    { encoding: 'utf8' });
  assert.match(printed, /^assay \d+\.\d+\.\d+/,
    'the linked command printed nothing, so it never ran');

  // And it still REPORTS through the link: exiting 0 in silence was the whole defect,
  // so a version string alone would not tell the two apart.
  const root = tree({ 'm.js': TWINS });
  let status = 0;
  try {
    execFileSync(process.execPath, [link, 'scan', root], { encoding: 'utf8' });
  } catch (err) {
    status = err.status;
  }
  assert.equal(status, 1, 'a findings run through the link must still exit 1');
});

test('the package scans ITSELF clean', async () => {
  // Merging two tools is exactly when duplication arrives, so the combined package is
  // scanned by its own scanner.
  const { code, text } = await cli('scan', path.join(ROOT, 'js', 'src'));
  assert.equal(code, 0, text);
});

// --------------------------------------------------------------------------- //
// --json: the same Report, in the shape a machine can read
// --------------------------------------------------------------------------- //
// ONE SHAPE, ALWAYS. A run that could not start emits the same keys as one that
// finished, because prose on the failure path and JSON everywhere else hands a
// consumer a parse error at exactly the moment the tool could not run — and a sloppy
// consumer reads a parse error as no findings.

const JSON_KEYS = ['baseline', 'command', 'error', 'exit_code', 'items', 'language',
  'notes', 'root', 'scan', 'schema', 'tool', 'version'].sort();

async function payload(...argv) {
  const { code, text } = await cli(...argv);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    assert.fail(`--json printed something that is not JSON: ${text.slice(0, 200)}`);
  }
  return { code, data };
}

test('every subcommand emits the SAME KEYS', async () => {
  const root = tree({ 'm.js': TWINS });
  const runs = [
    ['--root', root, 'runners'],
    ['--root', root, 'anchors'],
    ['scan', root],
    ['pair', `${path.join(root, 'm.js')}::a`, `${path.join(root, 'm.js')}::b`],
    ['search', `${path.join(root, 'm.js')}::a`, '--in', root],
  ];
  for (const argv of runs) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await payload('--json', ...argv);
    assert.deepEqual(Object.keys(data).sort(), JSON_KEYS, argv[0]);
  }
});

test('the payload exit code IS the returned exit code', async () => {
  // Agreeing by construction is worth proving: a consumer that trusts the field and
  // a script that trusts the code must never be told two different things.
  const root = tree({ 'm.js': TWINS });
  const runs = [
    ['scan', root],
    ['scan', tree({ 'm.js': 'export function f(n) { return n * 2; }\n' })],
    ['search', 'nope.js::x', '--in', root],
  ];
  for (const argv of runs) {
    // eslint-disable-next-line no-await-in-loop
    const { code, data } = await payload('--json', ...argv);
    assert.equal(code, data.exit_code, argv.join(' '));
  }
});

test('a finding travels with its verdict rather than a severity', async () => {
  // Mapping the three verdicts onto somebody else's error/warning/note is the
  // collapse the verdict vocabulary exists to prevent.
  const { code, data } = await payload('--json', 'scan', tree({ 'm.js': TWINS }));
  assert.equal(code, 1);
  assert.ok(data.items.some((i) => i.verdict === 'finding'));
  for (const item of data.items) {
    assert.deepEqual(Object.keys(item).sort(), ['detail', 'message', 'verdict', 'where']);
  }
});

test('a look is carried and still exits 0', async () => {
  const root = tree({ 'm.js': 'export function t(n) { return Date.now() + n; }\n' });
  const ref = `${path.join(root, 'm.js')}::t`;
  const { code, data } = await payload('--json', 'pair', ref, ref);
  assert.equal(code, 0);
  assert.equal(data.exit_code, 0);
  assert.ok(data.items.some((i) => i.verdict === 'look'));
});

test('a run that could not start emits JSON and exits 2', async () => {
  const root = tree({ 'a.js': 'export const x = 1;\n', 'assay.json': '{not json' });
  const { code, data } = await payload('--root', root, '--json', 'runners');
  assert.equal(code, 2);
  assert.equal(data.exit_code, 2);
  assert.match(data.error, /not valid JSON/);
  assert.deepEqual(data.items, []);
  assert.deepEqual(Object.keys(data).sort(), JSON_KEYS);
});

test('no subcommand under --json is an error object, not the usage text', async () => {
  const { code, data } = await payload('--json');
  assert.equal(code, 2);
  assert.equal(data.error, 'no subcommand');
});

test('anchors under --json names the gap rather than printing prose', async () => {
  // The command this half does not implement must still answer in the shape the
  // caller asked for. Exit 2 either way: `anchors` here is a run that cannot happen.
  const { code, data } = await payload('--json', 'anchors');
  assert.equal(code, 2);
  assert.match(data.error, /Python package only/);
});

test('the census is DATA rather than the printed equation', async () => {
  const { code, data } = await payload('--json', 'scan', path.join(ROOT, 'js', 'src'));
  assert.equal(code, 0);
  const census = data.scan;
  assert.equal(census.probed + census.not_probed, census.functions);
  // FILES ARE A SEPARATE POPULATION. Adding the two totals together prints a number
  // nobody measured, so they are two counts and not one.
  assert.ok(census.files > 0);
});

test('a command that ran no scan says null rather than zero', async () => {
  // Zero probed functions and no sameness half at all are different claims.
  const { data } = await payload('--root', tree({ 'a.js': 'export const x = 1;\n' }),
    '--json', 'runners');
  assert.equal(data.scan, null);
});

test('the baseline carries WHY this half could not check staleness', async () => {
  // No run on this half is complete — `anchors` is Python-only — so an empty `stale`
  // list without that flag would be this half claiming it checked and found none.
  const root = tree({
    'm.js': TWINS,
    'assay.json': JSON.stringify({ baseline: ['same answer (arity1/v3): x, y'] }),
  });
  const { data } = await payload('--root', root, '--json', 'scan', root);
  assert.equal(data.baseline.complete, false);
  assert.match(data.baseline.incomplete_because, /anchors/);
});

test('--json prints JSON AND NOTHING ELSE', async () => {
  // A prose banner in front of the object is a parse error, and a parse error at
  // exactly the wrong moment reads as a clean audit.
  const { text } = await cli('--json', 'scan', tree({ 'm.js': TWINS }));
  assert.equal(text.trimStart()[0], '{');
  JSON.parse(text);
});

test('--json works on BOTH sides of the subcommand', async () => {
  const root = tree({ 'm.js': TWINS });
  const first = await payload('--json', 'scan', root);
  const second = await payload('scan', root, '--json');
  assert.equal(first.code, second.code);
});

test('--json emits keys in sorted order, all the way down', async () => {
  // `JSON.stringify` emits insertion order and Python's `json.dump` is asked for
  // sorted keys, so without this the two halves print the same data as two different
  // documents. One contract, two implementations, is the duplication this package
  // exists to find — so the byte-level shape is made the same rather than left to how
  // each language happens to build an object.
  const { text } = await cli('--json', 'scan', tree({ 'm.js': TWINS }));
  const data = JSON.parse(text);
  const isSorted = (o) => assert.deepEqual(Object.keys(o), [...Object.keys(o)].sort());
  isSorted(data);
  isSorted(data.scan);
  isSorted(data.items[0]);
});
