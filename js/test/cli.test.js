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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test('a baseline entry that no longer fires FAILS', async () => {
  const root = tree({
    'assay.json': JSON.stringify({ baseline: ['a finding long gone'] }),
    'm.js': 'export function a(n) { return n * 2; }\n',
  });
  const { code, text } = await cli('--root', root, 'scan', root);
  assert.equal(code, 1);
  assert.match(text, /no longer fires/);
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

test('the package scans ITSELF clean', async () => {
  // Merging two tools is exactly when duplication arrives, so the combined package is
  // scanned by its own scanner.
  const { code, text } = await cli('scan', path.join(ROOT, 'js', 'src'));
  assert.equal(code, 0, text);
});
