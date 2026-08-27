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
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from 'node:fs';
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

async function cliStdin(input, ...argv) {
  let text = '';
  const code = await run(argv, (s) => { text += s; }, () => input);
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

test('anchors runs here now, and says so when there is nothing to audit', async () => {
  // It used to exit 2 and point at PyPI. The table is read by IMPORT rather than by
  // parse, so there is no regex and no approximation — and a project with no harness
  // is reported rather than passing silently.
  const { code, text } = await cli('--root', tree({ 'm.js': 'export const x = 1;\n' }),
    'anchors');
  assert.equal(code, 0, text);
  assert.match(text, /no mutation runners found/);
  assert.doesNotMatch(text, /Python package only/);
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
  assert.match(text, /NOT checked for staleness/);
});

test('runners does not claim it performed every audit either', async () => {
  // Driven per COMMAND rather than once: `performed` is a literal at each call site,
  // so a command that claims more than it did is a defect one test cannot see. This
  // one was NOT DETECTED until it existed.
  const root = tree({
    'assay.json': JSON.stringify({ baseline: ['a scan-only finding'] }),
    'm.js': 'export function a(n) { return n * 2; }\n',
  });
  const { code, text } = await cli('--root', root, 'runners');
  assert.equal(code, 0, text);
  assert.doesNotMatch(text, /no longer fires/);
  assert.match(text, /NOT checked for staleness/);
});

test('a line that NAMES its command is answered by that command', async () => {
  // The point of `from`. `assay scan` knows perfectly well whether a `scan` finding
  // fired, and needed a whole `assay all` to be allowed to say so.
  const root = tree({
    'assay.json': JSON.stringify({
      baseline: [{ line: 'a scan finding long gone', reason: 'read it', from: 'scan' }],
    }),
    'm.js': 'export function a(n) { return n * 2; }\n',
  });
  const { code, text } = await cli('--root', root, 'scan', root);
  assert.equal(code, 1, text);
  assert.match(text, /no longer fires/);
});

test('a line from ANOTHER command is counted rather than called stale', async () => {
  const root = tree({
    'assay.json': JSON.stringify({
      baseline: [{ line: 'an anchors finding', reason: 'read it', from: 'anchors' }],
    }),
    'm.js': 'export function a(n) { return n * 2; }\n',
  });
  const { code, text } = await cli('--root', root, 'scan', root);
  assert.equal(code, 0, text);
  assert.doesNotMatch(text, /no longer fires/);
  assert.match(text, /NOT checked for staleness \(anchors: 1\)/);
});

test('all WITHOUT --scan does not claim it performed the sameness half', async () => {
  const root = tree({
    'assay.json': JSON.stringify({
      baseline: [{ line: 'same answer (arity1/v3): a.js::x, b.js::y', reason: 'read them', from: 'scan' }],
    }),
    'm.js': 'export const x = 1;\n',
  });
  // The exit code is not asserted: a temp directory is not a git repository, so
  // `diff` reports one of its own findings here and the run fails for a reason that
  // has nothing to do with the baseline.
  const { text } = await cli('--root', root, 'all', '--base', 'HEAD');
  assert.doesNotMatch(text, /no longer fires/);
  assert.match(text, /NOT checked for staleness \(scan: 1\)/);
});

test('...and `all` DOES call one stale, now that this half can run every audit', async () => {
  // The gap that used to make this impossible is closed: `anchors` reads a mutation
  // table by importing it, so `assay all` here performs every audit able to produce a
  // baseline line. A line that no longer fires is somebody's fixed problem with the
  // record still claiming otherwise.
  const root = tree({
    'assay.json': JSON.stringify({ baseline: ['a finding long gone'] }),
    'm.js': 'export function a(n) { return n * 2; }\n',
  });
  // `--scan` is what makes the run complete: without it the sameness half did not
  // run, so an UNTAGGED line — one that names no command — is still unchecked.
  const { code, text } = await cli('--root', root, 'all', '--base', 'HEAD',
    '--scan', root);
  assert.equal(code, 1, text);
  assert.match(text, /no longer fires/);
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

test('the version it prints is the version the manifest publishes', () => {
  // `cli.js` carries the number as a LITERAL, separate from `package.json`, so the two
  // can drift. The Python half's parity test compares all six places a version is
  // written and would catch it, but a suite that cannot check its own half leaves the
  // literal guarded only by the other language: a bump that missed this file would go
  // red in Python and green in everything the JavaScript mutations are scored against.
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const printed = execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(printed.trim(), `assay ${manifest.version}`);
});

test('the package scans ITSELF clean', async () => {
  // Merging two tools is exactly when duplication arrives, so the combined package is
  // scanned by its own scanner.
  const { code, text } = await cli('scan', path.join(ROOT, 'js', 'src'));
  assert.equal(code, 0, text);
});

// --------------------------------------------------------------------------- //
// accept: the command that writes the baseline line for you
// --------------------------------------------------------------------------- //
// The 0.2.2 changelog records shipping a config example that baselined a `look`. A
// look never fails the run, so the line could never be suppressed and could never
// expire: a record of nothing, indistinguishable from a record of something already
// fixed. An example is fixed once per copy of it; a command that cannot make the
// mistake is fixed once.

const HARNESS = "export const MUTATIONS = [['label', '  return x + 1;', '  return x - 1;']];\n";
const UNREADABLE = "export const MUTATIONS = [['a label', 'b', 'c', 'd', 'e', 'f']];\n";
const SIGTERM = 'mutations-x.js: no `sigterm` (SIGTERM does not run `finally`; '
  + 'a kill leaves the tree broken)';

const acceptProject = (body = HARNESS, config = null) => {
  const files = { 'mutations-x.js': body };
  if (config) files['assay.json'] = JSON.stringify(config);
  return tree(files);
};
const written = (root) => JSON.parse(readFileSync(path.join(root, 'assay.json'), 'utf8'));

test('accept REFUSES without a reason', async () => {
  // The same rule an exemption follows: an acceptance without one cannot be told from
  // an oversight, and this is the table that rots fastest.
  const root = acceptProject();
  const { code, text } = await cli('--root', root, 'accept', '--base', 'HEAD');
  assert.equal(code, 2);
  assert.match(text, /--reason/);
  assert.ok(!existsSync(path.join(root, 'assay.json')));
});

test('accept writes the LINE, the REASON and what FIRES it', async () => {
  const root = acceptProject();
  const { code, text } = await cli('--root', root, 'accept', SIGTERM,
    '--reason', 'a tempdir, so a kill leaves nothing mutated', '--base', 'HEAD');
  assert.equal(code, 0, text);
  assert.deepEqual(written(root).baseline, [{
    line: SIGTERM,
    reason: 'a tempdir, so a kill leaves nothing mutated',
    from: 'runners',
  }]);
});

test('what accept wrote is then SUPPRESSED by the audit that fires it', async () => {
  // The round trip is the point: the entry is the finding's exact text, taken from the
  // run rather than typed, which is what makes whole-line matching safe.
  const root = acceptProject();
  await cli('--root', root, 'accept', SIGTERM, '--reason', 'r', '--base', 'HEAD');
  const { text } = await cli('--root', root, 'runners');
  assert.match(text, /1 accepted/);
  assert.ok(!text.split('FINDINGS').pop().includes(SIGTERM));
});

test('accept REFUSES a look', async () => {
  const root = acceptProject(UNREADABLE);
  const { text: anchorsText } = await cli('--root', root, 'anchors');
  const look = anchorsText.split('\n').find((l) => l.includes('  look     '))
    .split('look     ')[1].trim();
  const { code, text } = await cli('--root', root, 'accept', look, '--reason', 'r',
    '--base', 'HEAD');
  assert.equal(code, 2);
  assert.match(text, /`look` never fails the run/);
  assert.ok(!existsSync(path.join(root, 'assay.json')));
});

test('accept REFUSES a line nothing printed', async () => {
  // Accepting a line that does not fire writes an entry that is stale the moment it
  // lands, and the file then arrives already claiming something untrue.
  const root = acceptProject();
  const { code, text } = await cli('--root', root, 'accept', 'a finding I invented',
    '--reason', 'r', '--base', 'HEAD');
  assert.equal(code, 2);
  assert.match(text, /stale the moment it lands/);
});

test('accept REFUSES a line already accepted', async () => {
  const root = acceptProject(HARNESS, {
    baseline: [{ line: SIGTERM, reason: 'read it', from: 'runners' }],
  });
  const { code, text } = await cli('--root', root, 'accept', SIGTERM, '--reason', 'r',
    '--base', 'HEAD');
  assert.equal(code, 2);
  assert.match(text, /already in the baseline/);
});

test('with no LINE, accept takes every NEW finding', async () => {
  const root = acceptProject();
  const { code } = await cli('--root', root, 'accept', '--reason', 'adopting this',
    '--base', 'HEAD');
  assert.equal(code, 0);
  const entries = written(root).baseline;
  assert.ok(entries.some((e) => e.line === SIGTERM));
  assert.ok(entries.every((e) => e.reason === 'adopting this'));
});

test('accept leaves every OTHER key and every existing entry alone', async () => {
  // Rewriting somebody's file into a shape they did not ask for is not the job of a
  // command asked to add one line.
  const root = acceptProject(HARNESS, {
    runner_exempt: [{ path: 'other.js', reason: 'elsewhere' }],
    baseline: ['a line pasted straight out of a run'],
  });
  await cli('--root', root, 'accept', SIGTERM, '--reason', 'r', '--base', 'HEAD');
  const raw = written(root);
  assert.deepEqual(raw.runner_exempt, [{ path: 'other.js', reason: 'elsewhere' }]);
  assert.equal(raw.baseline[0], 'a line pasted straight out of a run');
  assert.equal(raw.baseline[1].line, SIGTERM);
});

test('nothing new is not an error', async () => {
  const root = acceptProject(HARNESS, { baseline: [] });
  await cli('--root', root, 'accept', '--reason', 'r', '--base', 'HEAD');
  const { code, text } = await cli('--root', root, 'accept', '--reason', 'r',
    '--base', 'HEAD');
  assert.equal(code, 0);
  assert.match(text, /nothing new to accept/);
});

// --------------------------------------------------------------------------- //
// why: the census, for one name
// --------------------------------------------------------------------------- //
// The census gives aggregate refusal reasons with counts, which is the right shape for
// a tree and the wrong shape for a question: somebody who expected a particular
// function to be probed cannot read `no arguments 274` and learn whether theirs is one
// of them. Every case here is a `look` or an `ok` and never a finding.

const WHY_FIXTURE = `
export function double(x) { return x + x; }
export function constant(x) { void x; return 1; }
export function identity(x) { return x; }
export function nullary() { return 1; }
export function throwsOnEverything(x) { return x.noSuchProperty.deeper; }
`;

async function why(name, files = { 'm.js': WHY_FIXTURE }) {
  const root = tree(files);
  return cli('why', `${path.join(root, Object.keys(files)[0])}::${name}`);
}

test('a PROBED function says so rather than staying silent', async () => {
  // "It was probed" and "nothing looked at it" are different claims, and only one of
  // them is evidence.
  const { code, text } = await why('double');
  assert.equal(code, 0, text);
  assert.match(text, /probed on arity1\//);
  assert.match(text, /distinct value/);
});

test('a CONSTANT and a PROJECTION are told apart', async () => {
  // The census collapses both into `not discriminated by the ladder`, which is one
  // reason with two very different answers: a constant needs a wider ladder and a
  // projection needs a different function.
  const constant = (await why('constant')).text;
  const projection = (await why('identity')).text;
  assert.match(constant, /it is a constant/);
  assert.doesNotMatch(constant, /projection/);
  assert.match(projection, /a projection/);
  assert.doesNotMatch(projection, /it is a constant/);
});

test('a zero-arity function gets the gate the census counts', async () => {
  const { text } = await why('nullary');
  assert.match(text, /no arguments/);
});

test('a refused FILE is answered at the file level, not per function', async () => {
  // Python lifts one function's source out and never imports the module; here a
  // function object only exists once its module has been evaluated, so a file that
  // reads the clock is refused WHOLE and none of its functions were ever looked at.
  // A per-function reason would be a reason invented after the fact.
  const { code, text } = await why('fine', {
    'm.js': 'export function fine(x) { return x + x; }\n'
      + 'export function clock() { return Date.now(); }\n',
  });
  assert.equal(code, 0, text);
  assert.match(text, /the FILE was refused: reads the clock/);
  assert.match(text, /never loaded/);
});

test('a vector that THREW EVERYWHERE is not called a constant', async () => {
  // A function the ladder never reached is a different problem from one it reached and
  // found constant: the first needs inputs of another shape, the second needs a wider
  // ladder. Both are `not discriminated`, and saying which is the point of `why`.
  const { text } = await why('throwsOnEverything');
  assert.match(text, /threw on all/);
  assert.doesNotMatch(text, /it is a constant/);
});

test('why NEVER produces a finding', async () => {
  for (const name of ['double', 'constant', 'identity', 'nullary', 'throwsOnEverything']) {
    // eslint-disable-next-line no-await-in-loop
    const { code, text } = await why(name);
    assert.equal(code, 0, `${name}: ${text}`);
  }
});

test('an unexported function says WHY it is unreachable rather than "cannot resolve"', async () => {
  // The gap is real and the reason is worth printing: a module's functions arrive
  // through its exports, and finding an unexported declaration would mean reading
  // source with a regex.
  const { code, text } = await why('hidden', {
    'm.js': 'function hidden(x) { return x; }\nexport function shown(x) { return x + 1; }\n',
  });
  assert.equal(code, 2);
  assert.match(text, /EXPORTS no function named hidden/);
  assert.match(text, /shown/);
});

test('a reference with no separator exits 2', async () => {
  const { code, text } = await cli('why', 'justaname');
  assert.equal(code, 2);
  assert.match(text, /FILE::NAME/);
});

test('why needs one of the two ways in, and says which two', async () => {
  const { code, text } = await cli('why');
  assert.equal(code, 2);
  assert.match(text, /why needs a FILE::NAME or --stdin/);
});

test('a second reference is a second question, not an ignored argument', async () => {
  const { code, text } = await cli('why', 'a.js::f', 'b.js::g');
  assert.equal(code, 2);
  assert.match(text, /takes one FILE::NAME/);
});

// --------------------------------------------------------------------------- //
// why --stdin: the same question, about code that is not a file yet
// --------------------------------------------------------------------------- //
// `search --stdin` has to answer it on the way, so asking it directly should not
// require inventing a file: writing the file first in order to be told the file was
// never the problem is the shape `--stdin` exists to avoid.

test('a snippet gets the same answer as the file it will become', async () => {
  const source = 'export function constant(x) { void x; return 1; }\n';
  const fromFile = (await why('constant', { 'm.js': source })).text;
  const { code, text: fromStdin } = await cliStdin(source, 'why', '--stdin');
  assert.equal(code, 0, fromStdin);
  for (const text of [fromFile, fromStdin]) {
    assert.match(text, /not discriminated by the ladder/);
    assert.match(text, /it is a constant/);
  }
  assert.match(fromStdin, /<stdin>::constant/);
});

test('a PROBED snippet says so rather than staying silent', async () => {
  const { code, text } = await cliStdin('export function d(x) { return x + x; }\n',
    'why', '--stdin');
  assert.equal(code, 0, text);
  assert.match(text, /probed on arity1\//);
});

test('a snippet the file gate refuses is answered without being loaded', async () => {
  const { code, text } = await cliStdin(
    'export function t(x) { return Date.now() + x; }\n', 'why', '--stdin');
  assert.equal(code, 0, text);
  assert.match(text, /reads the clock/);
});

test('why --name picks one function out of a snippet', async () => {
  const { code, text } = await cliStdin(
    'export function a(x) { return x + 1; }\nexport function b(x) { return x * 2; }\n',
    'why', '--stdin', '--name', 'b');
  assert.equal(code, 0, text);
  assert.match(text, /<stdin>::b/);
  assert.doesNotMatch(text, /<stdin>::a\b/);
});

test('an AMBIGUOUS snippet is refused rather than guessed', async () => {
  const { code, text } = await cliStdin(
    'export function a(x) { return x + 1; }\nexport function b(x) { return x * 2; }\n',
    'why', '--stdin');
  assert.equal(code, 2);
  assert.match(text, /name one with --name/);
});

test('why --stdin with a reference is two queries and exits 2', async () => {
  const { code, text } = await cliStdin('export function a(x) { return x; }\n',
    'why', '--stdin', 'm.js::a');
  assert.equal(code, 2);
  assert.match(text, /two different queries/);
});

test('why --name without --stdin is an ERROR rather than ignored', async () => {
  // A flag that is accepted, documented and inert is the defect this CLI already
  // carries two docstrings about.
  const { code, text } = await cli('why', '--name', 'a', 'm.js::a');
  assert.equal(code, 2);
  assert.match(text, /--name selects a function inside a --stdin snippet/);
});

// --------------------------------------------------------------------------- //
// search: a query the ladder could never have matched
// --------------------------------------------------------------------------- //
// `collect` files every function the ladder cannot tell apart under skipped, so a
// constant query can only fail to find the other constants: the match was never
// possible, and the tree was never really searched. Printing the clean `same none`
// there states the one thing this tool refuses to state — found none, where the truth
// is never looked. `why` already answered this about the same vector, so `search`
// gives the same answer from the same function.
//
// THE COST LANDS ON THE BUSIEST PATH. `--stdin` is search before you generate, so the
// person reading that line is about to write the function.

const SEARCH_TREE = { 'm.js': 'export function only(n) { return n * 3 + 1; }\n' };
const CONSTANT = 'export function k(n) { void n; return 7; }\n';
const PROJECTION = 'export function p(n) { return n; }\n';
const THROWS = 'export function r(n) { return n.noSuchProperty.deeper; }\n';

async function search(snippet) {
  return cliStdin(snippet, 'search', '--stdin', '--in', tree(SEARCH_TREE));
}

test('a CONSTANT query is a look rather than a clean none', async () => {
  const { code, text } = await search(CONSTANT);
  assert.equal(code, 0, text);
  assert.match(text, /not discriminated by the ladder/);
  assert.match(text, /it is a constant/);
  assert.doesNotMatch(text, /nothing in the tree matched/);
});

test('a PROJECTION query is told apart from a constant', async () => {
  // The two need opposite fixes — a wider ladder, or a different function — and
  // `search` inherits that split rather than repeating the decision.
  const { code, text } = await search(PROJECTION);
  assert.equal(code, 0, text);
  assert.match(text, /a projection/);
  assert.doesNotMatch(text, /it is a constant/);
  assert.doesNotMatch(text, /nothing in the tree matched/);
});

test('a query that THREW EVERYWHERE is not called a constant', async () => {
  const { text } = await search(THROWS);
  assert.match(text, /threw on all/);
  assert.doesNotMatch(text, /it is a constant/);
});

test('search says the tree was NOT searched when a match was never possible', async () => {
  // "We found none" and "we never looked" are different claims. This is the second way
  // not to look, and it used to print as the first.
  const { text } = await search(CONSTANT);
  assert.match(text, /the tree was not searched/);
});

test('a DISCRIMINATING query still gets the clean none', async () => {
  // The check must not swallow the result it was added to protect: a real search that
  // really found nothing still says so.
  const { code, text } = await search('export function q(n) { return n - 17; }\n');
  assert.equal(code, 0, text);
  assert.match(text, /nothing in the tree matched/);
  assert.doesNotMatch(text, /not discriminated by the ladder/);
});

test('a FILE::NAME query gets the SAME answer as a snippet', async () => {
  const root = tree({ 'm.js': CONSTANT });
  const { code, text } = await cli('search', `${path.join(root, 'm.js')}::k`,
    '--in', root);
  assert.equal(code, 0, text);
  assert.match(text, /not discriminated by the ladder/);
  assert.match(text, /it is a constant/);
});

test('search and why give ONE answer for one function', async () => {
  // The defect this replaced was the two of them disagreeing: `why` said the ladder
  // could not see the function and `search`, on the same vector, printed the result
  // that means a clean sweep.
  const root = tree({ 'm.js': PROJECTION });
  const ref = `${path.join(root, 'm.js')}::p`;
  const searched = (await cli('search', ref, '--in', root)).text;
  const asked = (await cli('why', ref)).text;
  for (const text of [searched, asked]) {
    assert.match(text, /::p — not discriminated by the ladder/);
    assert.match(text, /a projection: everywhere it answered/);
  }
});

test('the verdict IS a look, not an ok that reads as clean', async () => {
  // The whole answer is the verdict. An `ok` carrying the same sentence says the tool
  // decided and found nothing wrong, which is the claim it must not make — and it
  // would read identically in the prose the eye skims.
  const root = tree({ 'm.js': CONSTANT });
  const { data } = await payload('--json', 'search', `${path.join(root, 'm.js')}::k`,
    '--in', root);
  const looks = data.items.filter(
    (i) => i.message.includes('not discriminated by the ladder'));
  assert.equal(looks.length, 1, JSON.stringify(data.items));
  assert.equal(looks[0].verdict, 'look');
});

test('a look from search NEVER fails the run', async () => {
  for (const snippet of [CONSTANT, PROJECTION, THROWS]) {
    // eslint-disable-next-line no-await-in-loop
    const { code, text } = await search(snippet);
    assert.equal(code, 0, text);
  }
});

// --------------------------------------------------------------------------- //
// --json: the same Report, in the shape a machine can read
// --------------------------------------------------------------------------- //
// ONE SHAPE, ALWAYS. A run that could not start emits the same keys as one that
// finished, because prose on the failure path and JSON everywhere else hands a
// consumer a parse error at exactly the moment the tool could not run — and a sloppy
// consumer reads a parse error as no findings.

const JSON_KEYS = ['baseline', 'command', 'error', 'exit_code', 'items', 'language',
  'notes', 'other', 'root', 'scan', 'schema', 'tool', 'version'].sort();

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

test('anchors under --json is a report like any other command now', async () => {
  // It used to exit 2 here and name the gap. The gap is closed — the table is read by
  // IMPORT rather than by parse — so what has to hold is that it emits the same
  // envelope every other command does, with no error.
  const root = tree({ 'm.js': 'export const x = 1;\n' });
  const { code, data } = await payload('--root', root, '--json', 'anchors');
  assert.equal(code, 0);
  assert.equal(data.error, null);
  assert.ok(data.notes.some((n) => n.includes('no mutation runners found')));
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

// `displayPath` names a file relative to CWD, and a tmpdir fixture is not under it,
// so these look the entry up by its basename rather than assuming a spelling.
function entry(map, base) {
  const hit = Object.entries(map).filter(([k]) => k.endsWith(base));
  assert.equal(hit.length, 1, `${base} appears ${hit.length} times in ${Object.keys(map)}`);
  return hit[0][1];
}

test('the census NAMES the files it never opened, not just how many', async () => {
  // A tally answers "how many" and cannot answer "which". `could not load 12` names
  // nothing a person can open, and `assay why FILE::NAME` — the only recourse — has to
  // be told a file and a function name in it, which is what the tally withheld.
  const root = tree({
    // AT MODULE SCOPE, so the file genuinely never opens. The same call inside a body
    // is a refusal of the FUNCTION now, and would leave this census empty.
    'clock.js': 'export const at = Date.now();\n',
    'pure.js': 'export const twice = (n) => n * 2;\n',
  });
  const { code, data } = await payload('--json', 'scan', root);
  assert.equal(code, 0);
  const census = data.scan;
  assert.equal(Object.keys(census.unloadable_paths).length, 1);
  assert.equal(entry(census.unloadable_paths, 'clock.js'), 'reads the clock');
  // THE MAP AND THE TALLY DESCRIBE ONE POPULATION. Letting them drift would put two
  // different answers to "how much did this run never look at" in one document.
  const tallied = Object.values(census.unloadable).reduce((a, b) => a + b, 0);
  assert.equal(tallied, Object.keys(census.unloadable_paths).length);
});

test('the detail map keeps the load error the tally truncates away', async () => {
  // `tally` keys on `why.split('(')[0]` so one bucket counts every spelling of a
  // failure — and a load error's message begins at exactly that `(`. The diagnosis the
  // child already computed is the thing most worth reading in the largest bucket.
  const root = tree({ 'boom.js': 'throw new Error("JWT_SECRET must be set");\n' });
  const { data } = await payload('--json', 'scan', root);
  const census = data.scan;
  assert.deepEqual(Object.keys(census.unloadable), ['could not load']);
  assert.match(entry(census.unloadable_paths, 'boom.js'), /JWT_SECRET must be set/);
});

test('the census NAMES the functions it did not probe', async () => {
  const root = tree({ 'wide.js': 'export const four = (a, b, c, d) => a + b + c + d;\n' });
  const { data } = await payload('--json', 'scan', root);
  const census = data.scan;
  assert.equal(Object.keys(census.skipped_refs).length, 1);
  assert.match(entry(census.skipped_refs, 'wide.js::four'), /arity 4/);
  const tallied = Object.values(census.skipped).reduce((a, b) => a + b, 0);
  assert.equal(tallied, census.not_probed);
});

test('a command that ran no scan says null rather than zero', async () => {
  // Zero probed functions and no sameness half at all are different claims.
  const { data } = await payload('--root', tree({ 'a.js': 'export const x = 1;\n' }),
    '--json', 'runners');
  assert.equal(data.scan, null);
});

test('the baseline carries WHAT this run could not check for staleness', async () => {
  // The caveat travels as data, and it is a LIST rather than a boolean now.
  // Completeness stopped being a property of the run when a baseline entry learned to
  // name the command that fires it: `performed` says what this run audited, and
  // `unchecked` names each entry it could not have seen fire. A consumer reading
  // `stale: []` and nothing else would read "nothing is stale".
  const root = tree({
    'm.js': TWINS,
    'assay.json': JSON.stringify({ baseline: ['same answer (arity1/v3): x, y'] }),
  });
  const { data } = await payload('--root', root, '--json', 'scan', root);
  assert.deepEqual(data.baseline.performed, ['scan']);
  assert.deepEqual(data.baseline.stale, []);
  assert.deepEqual(data.baseline.unchecked,
    [{ line: 'same answer (arity1/v3): x, y', from: null }]);
});

test('a TAGGED baseline entry is answered by one command in JSON too', async () => {
  // The per-line rule, in the shape a machine reads. `assay scan` performed the audit
  // that fires this line, so it is stale — and nothing is left unchecked.
  const root = tree({
    'm.js': TWINS,
    'assay.json': JSON.stringify({
      baseline: [{ line: 'a scan finding long gone', reason: 'read it', from: 'scan' }],
    }),
  });
  const { data } = await payload('--root', root, '--json', 'scan', root);
  assert.deepEqual(data.baseline.stale, ['a scan finding long gone']);
  assert.deepEqual(data.baseline.unchecked, []);
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

// --------------------------------------------------------------------------- //
// search --stdin: a function that is not a file yet
// --------------------------------------------------------------------------- //
// SEARCH BEFORE YOU GENERATE cannot mean "first write the file", which is what a
// command taking only a FILE::NAME asks for. Everything downstream of resolving the
// query is the same code path, so these are about the query: which function it picked,
// and what it does when it cannot pick one.

test('a snippet the tree already answers is a finding', async () => {
  const root = tree({ 'm.js': TWINS });
  const { code, text } = await cliStdin(
    "export function c(s) {\n"
    + "  if (typeof s !== 'string') throw new TypeError('str');\n"
    + "  return s.split('').reverse().join('');\n}\n",
    'search', '--stdin', '--in', root,
  );
  assert.equal(code, 1, text);
  assert.match(text, /<stdin>::c/);
});

test('a snippet nothing answers exits 0 and says so', async () => {
  const root = tree({ 'm.js': 'export function only(n) { return n * 3 + 1; }\n' });
  const { code, text } = await cliStdin('export function q(n) { return n - 17; }\n',
    'search', '--stdin', '--in', root);
  assert.equal(code, 0, text);
  assert.match(text, /none/);
});

test('the query is named <stdin>, which collides with nothing a tree holds', async () => {
  // It is excluded from its own hits by REFERENCE, so that exclusion needs no
  // special case for a query that never had a path.
  const root = tree({ 'm.js': TWINS });
  const { text } = await cliStdin(
    "export function c(s) { return s.split('').reverse().join(''); }\n",
    'search', '--stdin', '--in', root,
  );
  assert.match(text, /<stdin>::c/);
});

test('several functions and no --name is a REFUSAL rather than a guess', async () => {
  // Picking one would make the tool answer about code nobody asked about, which
  // reads exactly like an answer about the code they did ask about.
  const { code, text } = await cliStdin(
    'export function a(x) { return x + 1; }\nexport function b(x) { return x * 2; }\n',
    'search', '--stdin', '--in', '.',
  );
  assert.equal(code, 2);
  assert.match(text, /a, b/);
});

test('--name picks one out of several', async () => {
  const root = tree({ 'm.js': 'export function only(n) { return n * 3 + 1; }\n' });
  const { code, text } = await cliStdin(
    'export function a(x) { return x + 1; }\nexport function b(x) { return x * 2; }\n',
    'search', '--stdin', '--name', 'a', '--in', root,
  );
  assert.equal(code, 0, text);
  assert.match(text, /<stdin>::a/);
});

test('a --name that is not in the snippet exits 2', async () => {
  const { code, text } = await cliStdin('export function a(x) { return x + 1; }\n',
    'search', '--stdin', '--name', 'zzz', '--in', '.');
  assert.equal(code, 2);
  assert.match(text, /no function named zzz/);
});

test('a snippet that exports nothing asks for a --name rather than reading source', async () => {
  // Finding an unexported declaration means reading names out of source with a
  // regex. The user knows the name; guessing at it is how a tool starts reporting
  // confident nonsense about code it never parsed.
  const { code, text } = await cliStdin('function a(x) { return x + 1; }\n',
    'search', '--stdin', '--in', '.');
  assert.equal(code, 2);
  assert.match(text, /exports nothing/);
});

test('a snippet that exports nothing is probed once --name says which', async () => {
  const root = tree({ 'm.js': 'export function only(n) { return n * 3 + 1; }\n' });
  const { code, text } = await cliStdin('function a(x) { return x + 1; }\n',
    'search', '--stdin', '--name', 'a', '--in', root);
  assert.equal(code, 0, text);
  assert.match(text, /<stdin>::a/);
});

test('a snippet that imports from the tree is a look, not a search', async () => {
  // A module has to be on disk to be imported. Outside the root its relative imports
  // resolve to nothing, and inside the root it would be scratch state beside the code
  // under test — the thing `no-tree-writes` audits harnesses for.
  const { code, text } = await cliStdin(
    "import { x } from './other.js';\nexport function f(y) { return y + x; }\n",
    'search', '--stdin', '--in', '.',
  );
  assert.equal(code, 0);
  assert.match(text, /imports from the tree/);
  assert.match(text, /the tree was not searched/);
});

test('a snippet this tool may not RUN is a look and never exit 2', async () => {
  // A function that exists and is refused is not a query that could not be read.
  // Collapsing those two is how exit 2 starts meaning "found nothing".
  const { code, text } = await cliStdin(
    'export function t(x) { return Date.now() + x; }\n', 'search', '--stdin', '--in', '.',
  );
  assert.equal(code, 0);
  assert.match(text, /the tree was not searched/);
});

test('--stdin and a FILE::NAME are two queries and exit 2', async () => {
  const { code, text } = await cliStdin('export function c(s) { return s; }\n',
    'search', '--stdin', 'm.js::a', '--in', '.');
  assert.equal(code, 2);
  assert.match(text, /two different queries/);
});

test('neither --stdin nor a FILE::NAME exits 2', async () => {
  const { code, text } = await cli('search', '--in', '.');
  assert.equal(code, 2);
  assert.match(text, /FILE::NAME or --stdin/);
});

test('--name without --stdin is an ERROR rather than ignored', async () => {
  // A flag that is accepted, documented and inert is the shape of the installed-CLI
  // defect this package shipped in 0.2.0 and the `-q` defect the parser carries a
  // comment about.
  const { code, text } = await cli('search', '--name', 'a', 'm.js::f', '--in', '.');
  assert.equal(code, 2);
  assert.match(text, /--name/);
});

// --------------------------------------------------------------------------- //
// bundle / sweep — the tree-wide half of the cross-language question
//
// `cross` answers about a pair somebody already suspected. Nobody suspects the pair
// that matters — a rule written once in the API and again in the front end, by two
// people, a year apart — so the command that finds it must not need either name.
// --------------------------------------------------------------------------- //

// Two functions with a TYPE GUARD, which is what makes them comparable ACROSS the
// languages rather than merely inside one. `s.toUpperCase()` and `s.upper()` answer
// the same question; `'a' * 2` and `"a" * 2` do not, because one is NaN and the other
// repeats — so a fixture without the guard proves the ladder found a coercion
// difference, not that the sweep works.
const CROSS_TWINS = `
export function shout(s) {
  if (typeof s !== 'string') throw new TypeError('str');
  return s.toUpperCase() + '!';
}

export function twice(x) {
  if (typeof x !== 'number') throw new TypeError('number');
  return x * 2;
}
`;

async function bundleOf(...paths) {
  const { code, text } = await cli('bundle', ...paths);
  return { code, document: JSON.parse(text) };
}

/**
 * The same bundle, relabelled as though the OTHER binary had written it.
 *
 * THE RECORD IS THE CONTRACT and this fixture is what says so. `sweep` compares
 * vectors and ladder keys; nothing about the comparison depends on which process
 * produced them, which is exactly why one half can answer for a tree it cannot parse.
 * Relabelling a bundle this half wrote exercises the bucketing without a second
 * runtime — and a suite that skips when a runtime is missing reports a pass for a
 * check that never ran.
 */
function asOtherHalf(document, language = 'python', suffix = '.py') {
  const out = JSON.parse(JSON.stringify(document));
  out.language = language;
  for (const record of out.records) {
    record.language = language;
    record.ref = record.ref.replace(/\.m?js::/, `${suffix}::`);
  }
  return out;
}

async function otherBundle(files, language, suffix) {
  const { document } = await bundleOf(tree(files));
  const file = path.join(tree({}), 'other.json');
  writeFileSync(file, JSON.stringify(asOtherHalf(document, language, suffix)), 'utf8');
  return file;
}

test('a bundle carries both schemas, the records and the census', async () => {
  const { code, document } = await bundleOf(tree({ 'm.js': CROSS_TWINS }));
  assert.equal(code, 0);
  assert.equal(document.assay_bundle, 1);
  assert.equal(document.assay_probe, 1);
  assert.equal(document.language, 'javascript');
  assert.deepEqual(
    document.records.map((r) => r.ref.split('::')[1]).sort(), ['shout', 'twice'],
  );
  assert.equal(document.census.probed, 2);
});

test('a bundle RECORD is the shape `assay probe` writes', async () => {
  // A record lifted out of a bundle is one `cross` already reads. Two shapes for one
  // artefact is two answers to what `vector` means.
  const { document } = await bundleOf(tree({ 'm.js': CROSS_TWINS }));
  for (const record of document.records) {
    assert.deepEqual(Object.keys(record).sort(),
      ['arity', 'assay_probe', 'error', 'ladder', 'language', 'ref', 'vector']);
    assert.match(record.ladder, /^cross/);
  }
});

test('a bundle RECORD holds what `assay probe` WROTE', async () => {
  // The shape is not the contract; the VECTOR is.
  //
  // A bundle built on the NATIVE ladder still carries cross ladder keys, and every one
  // of them matches the other half's key while meaning something else entirely — the
  // mismatched-ladder comparison the key exists to refuse, arriving inside the artefact
  // that carries the key. Nothing about the record's shape would say so, and
  // relabelling one bundle as the other half cannot say so either, because both sides
  // of that fixture drift together.
  const { document } = await bundleOf(tree({ 'm.js': CROSS_TWINS }));
  assert.ok(document.records.length);
  for (const record of document.records) {
    // eslint-disable-next-line no-await-in-loop
    const { code, text } = await cli('probe', record.ref);
    assert.equal(code, 0, text);
    const probed = JSON.parse(text);
    assert.equal(probed.ladder, record.ladder);
    assert.deepEqual(probed.vector, record.vector);
  }
});

test('a bundle with NO PATH emits the same shape and exits 2', async () => {
  // ONE SHAPE, ALWAYS. This command's output IS JSON, so a broken invocation that
  // printed prose would hand a consumer a parse error at exactly the moment the tool
  // could not run — and a sloppy consumer reads that as no findings.
  const { code, document } = await bundleOf();
  assert.equal(code, 2);
  assert.equal(document.assay_bundle, 1);
  assert.match(document.error, /needs a path/);
});

test('a refused function is in the CENSUS and not in the RECORDS', async () => {
  // A short `records` list with no census says "nothing here answers that" for a tree
  // that was never probed, which is the one claim this refuses to make.
  const { document } = await bundleOf(tree({
    'm.js': 'export function r(n) { return Math.random() + n; }\n',
  }));
  assert.deepEqual(document.records, []);
  assert.equal(document.census.not_probed, 1);
  assert.equal(Object.values(document.census.skipped_refs).length, 1);
});

test('sweep finds the pair NOBODY NAMED', async () => {
  const against = await otherBundle({ 'm.js': CROSS_TWINS });
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', against);
  assert.equal(code, 1, text);
  assert.match(text, /same answer across languages/);
  assert.match(text, /\[javascript\]/);
  assert.match(text, /\[python\]/);
  assert.match(text, /shout/);
});

test('a sweep that matches nothing exits 0 and SAYS SO', async () => {
  const against = await otherBundle({ 'm.js': CROSS_TWINS });
  const root = tree({
    'm.js': 'export function only(n) {\n'
      + "  if (typeof n !== 'number') throw new TypeError('number');\n"
      + '  return n * 3 + 1;\n}\n',
  });
  const { code, text } = await cli('sweep', root, '--against', against);
  assert.equal(code, 0, text);
  assert.match(text, /same {3}none/);
});

test('sweep prints the OTHER half\'s census TOO', async () => {
  // The far side is where a silence costs the most: a report that says `same none`
  // while staying quiet about the functions the OTHER binary never probed is reporting
  // "we never looked" as "we found none", across a boundary the reader cannot check.
  const against = await otherBundle({
    'm.js': 'export function r(n) { return Math.random() + n; }\n',
  });
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', against);
  assert.equal(code, 0, text);
  assert.match(text, /\[python\] 1 functions, 0 probed, 1 not probed/);
});

test('sweep REFUSES a bundle of its own language', async () => {
  // `scan` compares one language's functions on its own ladder, which is stronger.
  // Answering the weaker question without saying so is the failure.
  const { document } = await bundleOf(tree({ 'm.js': CROSS_TWINS }));
  const file = path.join(tree({}), 'same.json');
  writeFileSync(file, JSON.stringify(document), 'utf8');
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', file);
  assert.equal(code, 2);
  assert.match(text, /`scan`/);
});

test('sweep REFUSES a bundle from another schema', async () => {
  // Comparing a new answer against the wrong earlier answer is precisely the defect a
  // difference checker exists to catch.
  const { document } = await bundleOf(tree({ 'm.js': CROSS_TWINS }));
  const stale = asOtherHalf(document);
  stale.assay_bundle = 2;
  const file = path.join(tree({}), 'old.json');
  writeFileSync(file, JSON.stringify(stale), 'utf8');
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', file);
  assert.equal(code, 2);
  assert.match(text, /bundle schema/);
});

test('sweep REFUSES a bundle that could not be BUILT', async () => {
  // An `error` bundle has an empty `records` list, and comparing against it would
  // print `same none` for a tree the other half never managed to probe.
  const file = path.join(tree({}), 'broken.json');
  writeFileSync(file, JSON.stringify({
    assay_bundle: 1, assay_probe: 1, language: 'python', records: [], census: null,
    error: 'bundle needs a path',
  }), 'utf8');
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', file);
  assert.equal(code, 2);
  assert.match(text, /could not be built/);
});

test('sweep names the OTHER BINARY rather than guessing at it', async () => {
  // Both packages install a command called `assay`, so a half that guessed would run
  // itself and compare a tree with itself.
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', 'other/src');
  assert.equal(code, 2);
  assert.match(text, /--with/);
});

test('sweep reports a broken --with COMMAND rather than an empty bundle', async () => {
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', 'other/src', '--with', `${process.execPath} -e ''`);
  assert.equal(code, 2);
  assert.match(text, /--with/);
});

test('sweep NEVER buckets what the pairwise command would REFUSE', async () => {
  // A constant is not discriminated by the ladder, so `cross` calls two of them a
  // `look`. A bucketing scan that admitted them would print a FINDING for the same
  // pair — two answers to one question, and the weaker one on screen.
  const constant = 'export function k(n) { return 7; }\n';
  const { document } = await bundleOf(tree({ 'm.js': constant }));
  assert.deepEqual(document.records, []);
  assert.deepEqual(Object.values(document.census.skipped_refs),
    ['not discriminated by the ladder']);
  const against = await otherBundle({ 'm.js': constant });
  const { code, text } = await cli('sweep', tree({ 'm.js': constant }),
    '--against', against);
  assert.equal(code, 0, text);
});

test('an outcome the INTERLINGUA CANNOT STATE is never bucketed', async () => {
  // `compareCross` calls an `X:` rung a `look` because a value it cannot read is one
  // it must not pronounce on. Equality on the raw vector would call two of them
  // `same` — the verdict that FAILS.
  const { admit } = await import('../src/sameness.js');
  const { key, why } = admit(['V:1', 'X:Set', 'V:2'], 1, true);
  assert.equal(key, undefined);
  assert.match(why, /interlingua/);
});

test('sweep checks BOTH schemas of a bundle it ran itself', async () => {
  // The envelope and the record are versioned apart, so a far binary whose BUNDLE
  // schema matches can still mean something else by `vector`.
  const stale = JSON.stringify({
    assay_bundle: 1, assay_probe: 2, language: 'python', records: [], census: null,
    error: null,
  });
  const far = path.join(tree({ 'far.js': `console.log(${JSON.stringify(stale)});\n` }),
    'far.js');
  const { code, text } = await cli('sweep', tree({ 'm.js': CROSS_TWINS }),
    '--against', 'other/src', '--with', `${process.execPath} ${far}`);
  assert.equal(code, 2, text);
  assert.match(text, /records of schema/);
});
