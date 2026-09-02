/**
 * The check-audit half. Every detector is driven in BOTH directions.
 *
 * A detector tested only on code that should fail it will happily fire on code that
 * should pass, and that is the failure mode that gets an audit switched off. Each
 * property below has a harness that must be flagged and one that must not.
 *
 * The harness is BUILT rather than string-surgered, so a negative case drops exactly
 * one property and a test can only fail for the reason it names.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  auditDiff, auditRunners, changedFiles, checkExemptions, codeOnly, findRunners,
  PROPERTIES, PROPERTY_KEYS, stateTargets, targetsMentioned,
} from '../src/checks.js';
import { Config } from '../src/config.js';
import { Report } from '../src/verdicts.js';

function runner({
  evidence = true, partition = true, restoreInFinally = true, sigterm = true,
  parses = true, namedSection = false, treeWrite = false, restoreVerified = true,
} = {}) {
  const marker = evidence ? "const EVIDENCE = 'Ran ';" : "const MARKER = 'x';";
  const ranCheck = evidence
    ? "  if (!out.includes(EVIDENCE)) return [false, ['DID NOT RUN']];\n"
    : '  if (!out.includes(MARKER)) return [false, []];\n';
  let score;
  if (partition) {
    score = "      const dead = fails.filter((x) => x.includes('crashed'));\n"
      + '      const real = fails.filter((x) => !dead.includes(x));\n'
      + '      if (dead.length && !real.length) continue;\n';
  } else if (namedSection) {
    score = "      const wanted = 'the section this mutation must redden';\n"
      + "      if (!String(fails).includes(wanted)) console.log('WRONG section');\n";
  } else {
    score = '      void fails;\n';
  }
  const body = restoreInFinally
    ? '      try {\n        [ran, fails] = runSuite();\n'
      + '      } finally {\n        writeBack(original);\n      }\n'
    : '      [ran, fails] = runSuite();\n      writeBack(original);\n';
  const guard = parses ? '      new Function(mutated);\n' : '';
  const handler = sigterm
    ? "  handle('SIGTERM', () => {});\n"
    : "  handle('SIGUSR1', () => {});\n";
  // A GENUINE EXECUTABLE WRITE, so the positive case cannot pass by the detector
  // going back to matching text: the anchor test below quotes this very line and must
  // stay clean while this one stays a finding.
  const scratch = treeWrite
    ? "\nfunction save(results) {\n"
      + "  writeFileSync(join(__dirname, 'results.json'), JSON.stringify(results));\n"
      + '}\n' : '';
  // A restore that RAN is not a restore that WORKED. The verified harness digests the
  // bytes before anything is written and compares them after; the other one restores
  // exactly as diligently and never looks.
  const digest = restoreVerified
    ? "  const before = createHash('sha256').update(readBack()).digest('hex');\n" : '';
  const verify = restoreVerified
    ? "      const after = createHash('sha256').update(readBack()).digest('hex');\n"
      + "      if (after !== before) console.log('RESTORE FAILED — it did not come back');\n"
    : '';
  return `${marker}
export const MUTATIONS = [['a label', 'old code here', 'new code here']];

function handle(name, fn) { void name; void fn; }
function writeBack(text) { void text; }
function readBack() { return Buffer.from('source'); }

function runSuite() {
  const out = 'Ran 3 tests';
${ranCheck}  return [true, []];
}

export function main() {
  const original = 'source';
${digest}${handler}  for (const [name, old, next] of MUTATIONS) {
    const mutated = original.replace(old, next);
    let ran; let fails;
    if (true) {
${guard}${body}${score}${verify}    }
    void name; void ran;
  }
}
${scratch}`;
}

function project(source, name = 'mutations_thing.js', extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'assay-checks-'));
  writeFileSync(path.join(root, name), source, 'utf8');
  for (const [extraName, extraSource] of Object.entries(extra)) {
    const full = path.join(root, extraName);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, extraSource, 'utf8');
  }
  return root;
}

const missing = (source) => new Set(
  auditRunners(project(source), new Config(), new Report()).findings
    .map((f) => f.message.split('`')[1]).filter(Boolean),
);

// --------------------------------------------------------------------------- //
// Discovery
// --------------------------------------------------------------------------- //

test('harnesses are found by WALKING, not from a list', () => {
  // A list of harnesses is one more table that goes stale, and the harness nobody
  // added to it is the one that has been asleep longest.
  const root = project(runner(), 'mutations_thing.js',
    { 'deep/nest/mutations_other.js': runner() });
  assert.deepEqual(findRunners(root),
    ['deep/nest/mutations_other.js', 'mutations_thing.js']);
});

test('vendored directories are skipped', () => {
  const root = project(runner(), 'mutations_thing.js',
    { 'node_modules/pkg/mutations_vendor.js': runner() });
  assert.deepEqual(findRunners(root), ['mutations_thing.js']);
});

test('no harnesses is reported, not treated as a pass', () => {
  const report = auditRunners(mkdtempSync(path.join(tmpdir(), 'assay-empty-')),
    new Config(), new Report());
  assert.equal(report.exitCode(), 0);
  assert.match(report.sections.join('\n'), /none found/);
});

// --------------------------------------------------------------------------- //
// The six properties
// --------------------------------------------------------------------------- //

test('a complete harness is flagged for NOTHING', () => {
  assert.deepEqual([...missing(runner())], []);
});

test('no evidence the suite ran is flagged', () => {
  assert.deepEqual([...missing(runner({ evidence: false }))], ['evidence']);
});

test('no dead-vs-real partition is flagged', () => {
  assert.deepEqual([...missing(runner({ partition: false }))], ['dead-vs-real']);
});

test('a NAMED SECTION requirement satisfies the partition another way', () => {
  // A structural detector must not punish a design stronger than the one it knows.
  // Requiring the failure in a named section and printing WRONG otherwise makes a
  // crashed suite unscoreable without any partition at all.
  const flagged = missing(runner({ partition: false, namedSection: true, parses: false }));
  assert.ok(!flagged.has('dead-vs-real'));
  assert.ok(!flagged.has('parses-mutant'));
});

test('a restore outside finally is flagged', () => {
  assert.deepEqual([...missing(runner({ restoreInFinally: false }))],
    ['restore-in-finally']);
});

test('no sigterm handling is flagged', () => {
  assert.deepEqual([...missing(runner({ sigterm: false }))], ['sigterm']);
});

test('not checking the mutant parses is flagged', () => {
  assert.deepEqual([...missing(runner({ parses: false }))], ['parses-mutant']);
});

test('writing scratch state beside the code is flagged', () => {
  assert.deepEqual([...missing(runner({ treeWrite: true }))], ['no-tree-writes']);
});

test('an ANCHOR QUOTING a write is not the harness writing', () => {
  // The false positive six innocent runners hit in the repository this package came
  // out of. A mutation runner is the one kind of file that deliberately QUOTES other
  // files: its anchors are string literals holding fragments of the code under test,
  // for `replace(old, next)` to find. BOTH DIRECTIONS ARE ASSERTED HERE on purpose —
  // the quoted form clean AND the same line as code a finding — so this cannot pass by
  // the detector having quietly stopped detecting.
  const anchor = "\nexport const MORE = [['a label',\n"
    + "  '  writeFileSync(join(__dirname, \"results.json\"), x);',\n"
    + "  '  pass']];\n";
  assert.deepEqual([...missing(runner() + anchor)], []);
  assert.deepEqual([...missing(runner({ treeWrite: true }))], ['no-tree-writes']);
});

test('a path that LEAVES the directory is not state beside the code', () => {
  // Only the segment DIRECTLY under the directory constant counts, as on the Python
  // side: `join(__dirname, '..', other, 'x.json')` is somewhere else.
  const source = `${runner()}\nconst OUT = join(__dirname, '..', 'elsewhere', 'x.json');\n`;
  assert.deepEqual([...missing(source)], []);
});

test('a path a COMMENT mentions is not a write either', () => {
  const source = `${runner()}\n// never join(__dirname, 'results.json')\n`;
  assert.deepEqual([...missing(source)], []);
});

test('a REGEX holding a quote does not invert the literals after it', () => {
  // The one ambiguity a scanner this size has to settle, and getting it wrong here is
  // a false CONVICTION rather than a miss: `/['"]/` read as the start of a string
  // opens one that runs to the anchor's opening quote, and everything from there is
  // then scanned with its polarity inverted — the quoted write arriving as "code".
  //
  // ONE LINE, and that is the fixture doing work rather than looking tidy. A string
  // here ends at a newline whether or not it was closed, so the damage a mis-scanned
  // regex can do is bounded by the line it is on. Written across two lines this case
  // passes with the guard REMOVED, which is a fixture that cannot tell the guard from
  // its absence.
  const source = `${runner()}\n`
    + 'const OK = /[\'"]/.test(\'  writeFileSync(join(__dirname, "results.json"), x);\');\n';
  assert.deepEqual([...missing(source)], []);
});

test('a DIVISION is not mistaken for a regular expression', () => {
  // The mirror of the case above, and the same one-line reason. Reading `a / b` as a
  // regex swallows everything to the next `/` or the end of the line, so a real write
  // sitting in that span goes unreported — silence rather than a wrong conviction, and
  // the harder of the two to notice.
  const source = `${runner()}\n`
    + "const RATIO = passed / total; const OUT = join(__dirname, 'results.json');\n";
  assert.deepEqual([...missing(source)], ['no-tree-writes']);
});

test('the scanner reduces a string literal to its VALUE and nothing else', () => {
  // `codeOnly` and `stateTargets` driven directly, because the tests above prove the
  // detector's VERDICT and not what it read. A literal's contents must arrive as a
  // value between sentinels, a comment must not arrive at all, and the detector must
  // be able to NAME what it objected to — a `look` at a harness is answered by
  // opening it, and a finding that cannot say which path it means sends nobody there.
  assert.match(codeOnly("const A = 'x.json';"), /\0x\.json\0/);
  assert.equal(codeOnly('// join(HERE, "x.json")\n').trim(), '');
  assert.deepEqual(stateTargets(runner({ treeWrite: true })), ['results.json']);
});

test('a restore nothing VERIFIES is flagged', () => {
  // The seventh property, and the one the other six cannot see. This harness restores
  // in a `finally` and so passes `restore-in-finally`; it never reads the file back,
  // so it cannot tell a restore that put the bytes back from one that wrote a stale
  // buffer, the wrong encoding, or only one of two files.
  assert.deepEqual([...missing(runner({ restoreVerified: false }))], ['restore-verified']);
});

test('a digest NOTHING COMPARES does not satisfy restore-verified', () => {
  // Arithmetic is not a check: a hash nothing reads is a number nobody computed for a
  // reason, and the property is about the comparison rather than about the import.
  const source = `${runner({ restoreVerified: false })}\nconst H = createHash('sha256');\n`;
  assert.ok(missing(source).has('restore-verified'));
});

test('a message NOTHING COMPUTES does not satisfy it either', () => {
  const source = `${runner({ restoreVerified: false })}\nconst SAID = 'RESTORE FAILED';\n`;
  assert.ok(missing(source).has('restore-verified'));
});

test('the reported keys and the config-nameable keys are ONE set', () => {
  assert.deepEqual(new Set(PROPERTIES.map(([k]) => k)), PROPERTY_KEYS);
});

// --------------------------------------------------------------------------- //
// Exemptions, read in both directions
// --------------------------------------------------------------------------- //

test('an exemption silences the property it names', () => {
  const config = new Config({
    runnerExempt: new Map([['mutations_thing.js sigterm', 'writes only to a tempdir']]),
  });
  const report = auditRunners(project(runner({ sigterm: false })), config, new Report());
  assert.deepEqual(report.findings, []);
});

test('an exemption does NOT silence a property it does not name', () => {
  const config = new Config({
    runnerExempt: new Map([['mutations_thing.js evidence', 'different reason']]),
  });
  const report = auditRunners(project(runner({ sigterm: false })), config, new Report());
  assert.equal(report.findings.length, 1);
});

test('a star exemption covers every property', () => {
  const config = new Config({
    runnerExempt: new Map([['mutations_thing.js *', 'mutates in memory']]),
  });
  const report = auditRunners(project(runner({ sigterm: false, parses: false })),
    config, new Report());
  assert.deepEqual(report.findings, []);
});

test('an exemption for a file that no longer EXISTS is a finding', () => {
  // The second direction. Without it the file only ever grows, and after a while it
  // lists things somebody once believed rather than things that are true.
  const config = new Config({
    runnerExempt: new Map([['gone/mutations_old.js *', 'reason']]),
  });
  const report = checkExemptions(project(runner()), config, new Report());
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].message, /no longer exists/);
});

test('an exemption naming an UNKNOWN property is a finding', () => {
  const config = new Config({
    runnerExempt: new Map([['mutations_thing.js not-a-property', 'reason']]),
  });
  const report = checkExemptions(project(runner()), config, new Report());
  assert.match(report.findings[0].message, /unknown property/);
});

test('a stale ANCHOR exemption is a finding too', () => {
  const config = new Config({ anchorExempt: new Map([['gone.js', 'reason']]) });
  const report = checkExemptions(project(runner()), config, new Report());
  assert.equal(report.findings.length, 1);
});

// --------------------------------------------------------------------------- //
// Targets
// --------------------------------------------------------------------------- //

test('a mention counts as coverage, so this UNDER-reports', () => {
  // Stated rather than hidden: an audit that errs should err toward saying less.
  assert.deepEqual([...targetsMentioned("const TOOL = join(HERE, 'widget.js');")],
    ['widget.js']);
});

test('a bare word is not mistaken for a file', () => {
  assert.deepEqual([...targetsMentioned('just some prose about javascript')], []);
});

// --------------------------------------------------------------------------- //
// The change audit, which needs a real repository
// --------------------------------------------------------------------------- //

function repo() {
  const root = mkdtempSync(path.join(tmpdir(), 'assay-git-'));
  for (const args of [['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 't']]) {
    execFileSync('git', ['-C', root, ...args]);
  }
  return root;
}

function commit(root) {
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'c']);
}

function put(root, name, body) {
  const full = path.join(root, name);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body, 'utf8');
}

test('a bad ref is a finding rather than a crash', () => {
  const root = repo();
  put(root, 'a.js', 'export const x = 1;\n');
  commit(root);
  const report = auditDiff(root, 'no-such-ref', new Config(), new Report());
  assert.equal(report.exitCode(), 1);
  assert.match(report.findings[0].message, /valid ref/);
});

test('a changed file no harness names is a LOOK, not a finding', () => {
  const root = repo();
  put(root, 'a.js', 'export const x = 1;\n');
  commit(root);
  put(root, 'a.js', 'export const x = 2;\n');
  const report = auditDiff(root, 'HEAD', new Config(), new Report());
  assert.equal(report.exitCode(), 0);
  assert.ok(report.looks.some((i) => /NO mutation runner/.test(i.message)));
});

test('a guard added with no new mutation is a FINDING', () => {
  const root = repo();
  put(root, 'a.js', 'export function f(n) { return n; }\n');
  put(root, 'mutations_a.js', "export const T = 'a.js';\nexport const MUTATIONS = [];\n");
  commit(root);
  put(root, 'a.js', 'export function f(n) {\n  if (n < 0) { return 0; }\n  return n;\n}\n');
  const report = auditDiff(root, 'HEAD', new Config(), new Report());
  assert.equal(report.exitCode(), 1, JSON.stringify(report.items));
  assert.match(report.findings[0].message, /adds a guard/);
});

test('a guard added WITH its harness changed is fine', () => {
  const root = repo();
  put(root, 'a.js', 'export function f(n) { return n; }\n');
  put(root, 'mutations_a.js', "export const T = 'a.js';\nexport const MUTATIONS = [];\n");
  commit(root);
  put(root, 'a.js', 'export function f(n) {\n  if (n < 0) { return 0; }\n  return n;\n}\n');
  put(root, 'mutations_a.js',
    "export const T = 'a.js';\nexport const MUTATIONS = [['g', 'x', 'y']];\n");
  const report = auditDiff(root, 'HEAD', new Config(), new Report());
  assert.deepEqual(report.findings, []);
});

test('a guard in ONE file does not indict another changed file', () => {
  // Computing guards over the whole patch makes one guard look like an unguarded
  // change in every other file in the same commit.
  const root = repo();
  for (const name of ['a.js', 'b.js']) {
    put(root, name, 'export function f(n) { return n; }\n');
    put(root, `mutations_${name}`, `export const T = '${name}';\nexport const MUTATIONS = [];\n`);
  }
  commit(root);
  put(root, 'a.js', 'export function f(n) {\n  if (n < 0) { return 0; }\n  return n;\n}\n');
  put(root, 'b.js', 'export function f(n) { return n + 1; }\n');
  const report = auditDiff(root, 'HEAD', new Config(), new Report());
  assert.equal(report.findings.length, 1);
  assert.match(report.findings[0].message, /^a\.js/);
});

test('paths are rebased onto ROOT when code sits in a subdirectory', () => {
  // git reports paths from the TOPLEVEL and the harness walk yields them from ROOT.
  // When those differ every comparison between them is silently false — which does
  // not look like a bug, it looks like a clean audit.
  const top = repo();
  const sub = path.join(top, 'pkg');
  mkdirSync(sub, { recursive: true });
  put(top, 'pkg/a.js', 'export function f(n) { return n; }\n');
  put(top, 'pkg/mutations_a.js', "export const T = 'a.js';\nexport const MUTATIONS = [];\n");
  commit(top);
  put(top, 'pkg/a.js', 'export function f(n) {\n  if (n < 0) { return 0; }\n  return n;\n}\n');
  const report = auditDiff(sub, 'HEAD', new Config(), new Report());
  assert.equal(report.findings.length, 1, JSON.stringify(report.items));
  assert.match(report.findings[0].message, /^a\.js adds a guard/);
});

test('uncommitted work is visible to changedFiles', () => {
  // `base...HEAD` is committed history and contains nothing you have not committed
  // yet, which is exactly the state someone is in when they run this.
  const root = repo();
  put(root, 'a.js', 'export const x = 1;\n');
  commit(root);
  put(root, 'b.js', 'export const y = 2;\n');
  const [changed, error] = changedFiles(root, 'HEAD');
  assert.equal(error, null);
  assert.ok(changed.includes('b.js'), JSON.stringify(changed));
});

test('limitation-shaped tests are a LOOK', () => {
  const root = repo();
  put(root, 'a.js', 'export function f(n) { return n; }\n');
  put(root, 'a.spec.js', "it('cannot handle negatives', () => {});\n");
  put(root, 'mutations_a.js',
    "export const T = 'a.js a.spec.js';\nexport const MUTATIONS = [];\n");
  commit(root);
  put(root, 'a.spec.js',
    "it('cannot handle negatives', () => {});\nit('refuses strings', () => {});\n");
  const report = auditDiff(root, 'HEAD', new Config(), new Report());
  assert.ok(report.looks.some((i) => /limitation-shaped/.test(i.message)));
  assert.equal(report.exitCode(), 0);
});
