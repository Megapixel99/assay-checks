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
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('why needs exactly one reference', async () => {
  const { code } = await cli('why');
  assert.equal(code, 2);
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
