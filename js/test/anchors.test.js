/**
 * Anchor counting, read BY IMPORT rather than by parse.
 *
 * This is the one command whose two halves work by different mechanisms. Python lifts
 * the table out with `ast` and executes nothing; here the table is a JavaScript value,
 * so reading it as data means the module that builds it has run. What the two must
 * agree on is the RULE — an anchor matches exactly once, zero is a finding, twice in
 * one file is a finding — and that is what these drive, in both directions.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  anchorsOf, auditAnchors, harnessPaths, readTable, sourceFiles,
} from '../src/anchors.js';
import { Config } from '../src/config.js';

function project(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'assay-anchors-'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

/** A harness that exports `table` and does nothing at import time. */
const harness = (table) => `import { pathToFileURL } from 'node:url';

export const MUTATIONS = ${table};

export function main() { console.log('EVIDENCE'); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
`;

const TARGET = `export function handle(x) {
  return x + 1;
}

export function other(x) {
  return x - 1;
}
`;

const audit = async (files, config = new Config()) => {
  const report = await auditAnchors(project(files), config);
  return report;
};
const messages = (report, verdict) => report.of(verdict).map((i) => i.message);

// --------------------------------------------------------------------------- //
// Reading the table
// --------------------------------------------------------------------------- //

test('the anchor is the SECOND-TO-LAST string, in both documented shapes', () => {
  // A consequence of `replace(old, new)` rather than a guess about column order:
  // whatever else an entry carries, `old` and `new` are adjacent and in that order,
  // because that is the call they feed.
  const three = anchorsOf([['a label here', '  return x + 1;', '  return x - 1;']]);
  assert.deepEqual(three.found, ['  return x + 1;']);
  const four = anchorsOf([['a label', 'target.js', '  return x + 1;', '  return x - 1;']]);
  assert.deepEqual(four.found, ['  return x + 1;']);
});

test('a DECLARED TEST column does not shift the anchor onto the replacement', () => {
  // The third four-column shape: `(label, old, new, expectedTest)`, a table naming the
  // check each mutation must redden so that "something failed" and "the check that
  // covers this failed" stay different claims. Reading the second-to-last column there
  // lands on the REPLACEMENT, which matches nothing by construction — so every entry
  // becomes a dead-anchor finding on a harness that is perfectly healthy.
  const { found } = anchorsOf([
    ['a label here', '  return x + 1;', '  return x - 1;', 'handleAddsOne'],
  ]);
  assert.deepEqual(found, ['  return x + 1;']);
});

test('a four-column table ending in CODE still reads the third column', () => {
  // The other direction, which is what stops the rule above from being a position
  // swap: the target-column shape ends in a replacement rather than a name.
  const { found } = anchorsOf([
    ['a label', 'target.js', '  return x + 1;', '  return x - 1;'],
  ]);
  assert.deepEqual(found, ['  return x + 1;']);
});

test('a THREE-column entry ending in an identifier is left alone', () => {
  // Deliberately not disambiguated: a replacement that happens to be a bare identifier
  // is ordinary in a three-column table, and re-reading those would trade a false
  // finding on one shape for a false finding on another.
  const { found } = anchorsOf([['label', '  return x + 1;', 'pass']]);
  assert.deepEqual(found, ['  return x + 1;']);
});

test('a table shape it cannot read is OFFERED, not guessed at', () => {
  // Counting the wrong things precisely is worse than counting fewer things: an
  // earlier Python version took every string long enough to look like code, and half
  // of what it counted were labels that match nothing by construction.
  const { found, unreadable } = anchorsOf([['label', 'a', 'b', 'c', 'd', 'e']]);
  assert.deepEqual(found, []);
  assert.deepEqual(unreadable, ['label']);
});

test('an exported table is read as DATA, with no parser anywhere in the path', async () => {
  const root = project({
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return x - 1;']]"),
  });
  const result = await readTable(path.join(root, 'mutations-a.js'));
  assert.deepEqual(result.table, [['label', '  return x + 1;', '  return x - 1;']]);
});

test('a COMPUTED anchor is a string here, which no parser could have told us', async () => {
  // The compensation for importing: the Python half can only report a built anchor as
  // unreadable, because `ast` sees an expression rather than a value.
  const root = project({
    'mutations-a.js': harness("[['label', `  return ${'x'} + 1;`, '  return x - 1;']]"),
  });
  const result = await readTable(path.join(root, 'mutations-a.js'));
  assert.deepEqual(result.table[0][1], '  return x + 1;');
});

test('a harness that exports NO table is absent, not empty', async () => {
  // Two different claims: one has not opted into being read this way, and the other
  // has and holds nothing.
  const root = project({
    'mutations-a.js': "const MUTATIONS = [['a', 'b', 'c']];\nexport function main() { void MUTATIONS; }\n",
    'mutations-b.js': harness('[]'),
  });
  assert.equal((await readTable(path.join(root, 'mutations-a.js'))).absent, true);
  assert.deepEqual((await readTable(path.join(root, 'mutations-b.js'))).table, []);
});

test('a module that will not import is an error, never an empty table', async () => {
  const root = project({ 'mutations-a.js': 'this is not javascript(((\n' });
  const result = await readTable(path.join(root, 'mutations-a.js'));
  assert.ok(result.error, JSON.stringify(result));
  assert.equal(result.table, undefined);
});

// --------------------------------------------------------------------------- //
// The rule, in both directions
// --------------------------------------------------------------------------- //

test('an anchor matching exactly once is ok', async () => {
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return x - 1;']]"),
  });
  assert.deepEqual(report.findings, []);
  assert.equal(report.oks.length, 1);
});

test('an anchor matching NOTHING is a finding', async () => {
  // Silently inert if the harness does not check its target, which is a guard nobody
  // is testing any more inside a suite that still reports a pass.
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': harness("[['label', '  return x + 99;', '  return x - 1;']]"),
  });
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].message, /matches NOTHING/);
  // ONE file, not two: the harness is not part of its own corpus. "Matches nothing"
  // and "there was nothing to match it against" are different claims, and a root
  // pointed one directory too deep makes every anchor dead at once — only the count
  // tells those apart.
  assert.match(report.findings[0].message, /in any of 1 file —/);
});

test('an anchor matching TWICE IN ONE FILE is a finding', async () => {
  const report = await audit({
    'src/thing.js': 'export function a(x) {\n  return x;\n}\n\nexport function b(x) {\n  return x;\n}\n',
    'mutations-a.js': harness("[['label', '  return x;', '  return 0;']]"),
  });
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].message, /matches 2 times in ONE file/);
});

test('the finding NAMES THE FILE holding the copies', async () => {
  // The finding is about the HARNESS, and the copies are usually somewhere else —
  // often a file added since that harness was last touched. A reader given only the
  // count starts from the file they already know about and greps the tree for the one
  // they do not.
  const report = await audit({
    'src/thing.js': TARGET,
    'src/elsewhere.js': 'export function a(x) {\n  return x;\n}\n\nexport function b(x) {\n  return x;\n}\n',
    'mutations-a.js': harness("[['label', '  return x;', '  return 0;']]"),
  });
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].message, /\(src\/elsewhere\.js\)/);
  // AND NOT the file the reader would have started from: `src/thing.js` holds no copy
  // at all, so naming it would be worse than naming nothing.
  assert.doesNotMatch(report.findings[0].message, /thing\.js/);
});

test('a TIE names the same file every run', async () => {
  // Two files equally guilty is one problem, not two. `>` rather than `>=` over a
  // sorted walk keeps the finding's text stable, and the text is what a `baseline`
  // entry matches whole.
  const files = {
    'b_two.js': 'export function a(x) {\n  return x;\n}\n\nexport function b(x) {\n  return x;\n}\n',
    'a_two.js': 'export function c(x) {\n  return x;\n}\n\nexport function d(x) {\n  return x;\n}\n',
    'mutations-a.js': harness("[['label', '  return x;', '  return 0;']]"),
  };
  const first = (await audit(files)).findings[0].message;
  assert.match(first, /a_two\.js/);
  assert.equal(first, (await audit(files)).findings[0].message);
});

test('the same anchor once in TWO files is not ambiguous', async () => {
  // Per file, not in total. A harness that names its target is not confused by a line
  // that appears once in each of two places, and calling it so is the crying-wolf
  // failure this package refuses.
  const report = await audit({
    'src/one.js': 'export function a(x) {\n  return x + 1;\n}\n',
    'src/two.js': 'export function b(x) {\n  return x + 1;\n}\n',
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return 0;']]"),
  });
  assert.deepEqual(report.findings, []);
});

test('NO HARNESS is part of the corpus, so anchors never match themselves', async () => {
  // A harness's source contains its own anchors as string literals. Counting them
  // there makes every anchor match twice and the audit reports problems that are all
  // itself.
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return x - 1;']]"),
  });
  assert.deepEqual(report.findings, []);
});

test("a SIBLING harness's source is out of the corpus too", async () => {
  // One harness's replacement text routinely appears in another's, so excluding only
  // the declaring harness produces a confident finding about a file it has nothing to
  // do with.
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return x - 1;']]"),
    'mutations-b.js': harness("[['other', '  return x - 1;', '  return 0;']]"),
  });
  assert.deepEqual(report.findings, []);
});

test('a PYTHON harness leaves the corpus as well', async () => {
  // A polyglot repository has both, and each half can only READ its own. What must
  // happen to all of them is the same: they leave the corpus, or one half's anchors
  // are counted inside the other half's harness.
  const root = project({
    'src/thing.js': TARGET,
    'mutations_py.py': 'MUTATIONS = [("label", "  return x + 1;", "  return x - 1;")]\n',
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return x - 1;']]"),
  });
  const report = await auditAnchors(root, new Config());
  assert.deepEqual(report.findings, []);
  assert.ok([...harnessPaths(root)].some((p) => p.endsWith('mutations_py.py')));
});

test('an exempt harness is skipped and says so', async () => {
  const config = new Config({ anchorExempt: new Map([['mutations-a.js', 'generated']]) });
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': harness("[['label', '  return x + 99;', '  return x - 1;']]"),
  }, config);
  assert.deepEqual(report.findings, []);
  assert.ok(report.sections.some((s) => s.includes('exempt')));
});

test('a harness with no exported table is a LOOK and never fails the run', async () => {
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': "const MUTATIONS = [['a', 'b', 'c']];\nexport function main() { void MUTATIONS; }\n",
  });
  assert.deepEqual(report.findings, []);
  assert.equal(report.exitCode(), 0);
  assert.match(messages(report, 'look')[0], /exports no MUTATIONS table/);
});

test('ZERO ANCHORS IS A LOOK, NOT AN `ok`', async () => {
  // The failure this half was most recently wrong about. "0 anchors, each matching
  // exactly once" is true of the empty set and reads as a clean bill of health, so a
  // harness whose table shape was never recognised printed exactly what a harness with
  // a page of unique anchors printed. Measured on the Python half's real tree: 82 of 95
  // audited runners printed it, and one of the 82 held an anchor matching TWICE in the
  // file it points at — the exact defect this audit exists to find, under an `ok`.
  const report = await audit({
    'src/thing.js': TARGET,
    // Exported, so it is not `absent`; every entry too short to carry an anchor, so
    // there is nothing to read out of it.
    'mutations-a.js': harness("[['just a label']]"),
  });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.oks, []);
  assert.match(messages(report, 'look')[0], /yielded NO anchor this can read/);
  // ...and it says the table was not read, NOT that everything matched.
  for (const message of messages(report, 'look')) {
    assert.doesNotMatch(message, /matching exactly once/);
  }
});

test('a harness WITH anchors still says ok', async () => {
  // The other direction, and the reason the change above is not just louder: a zero
  // that becomes a `look` is only an improvement if a real count still reads as one.
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return x - 1;']]"),
  });
  assert.equal(report.oks.length, 1);
  assert.match(report.oks[0].message, /1 anchors, each matching exactly once/);
  assert.deepEqual(report.of('look'), []);
});

test('the TOTALS name the denominator, not just the count', async () => {
  // "296 anchors checked across 101 runners" is a true sentence about a run in which 82
  // of those runners contributed nothing, and it is the sentence a person reads as "101
  // runners are clean". A zero-anchor runner is not a clean one.
  const report = await audit({
    'src/thing.js': TARGET,
    'mutations-a.js': harness("[['label', '  return x + 1;', '  return x - 1;']]"),
    'mutations-b.js': harness("[['just a label']]"),
  });
  const notes = report.sections.join('\n');
  assert.match(notes, /1 anchors from 1 of 2 runners/);
  assert.match(notes, /ZERO anchors: 1 runner\(s\)/);
});

test('no harnesses at all is reported, not treated as a pass', async () => {
  const report = await audit({ 'src/thing.js': TARGET });
  assert.deepEqual(report.findings, []);
  assert.ok(report.sections.some((s) => s.includes('no mutation runners found')));
});

test('the corpus holds source in BOTH languages', () => {
  const root = project({ 'a.py': 'x = 1\n', 'b.js': 'export const y = 2;\n', 'c.md': '# no\n' });
  const names = sourceFiles(root).map((f) => path.basename(f));
  assert.ok(names.includes('a.py'));
  assert.ok(names.includes('b.js'));
  assert.ok(!names.includes('c.md'));
});
