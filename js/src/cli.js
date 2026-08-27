#!/usr/bin/env node
/**
 * assay — one command for two questions ordinary CI does not answer.
 *
 *     could those checks have failed?      assay runners | anchors | diff | all
 *     does the tree already answer this?   assay scan | pair | search
 *     ...does the OTHER language answer it?  assay search REF --against BUNDLE
 *     why was my function not probed?      assay why FILE::NAME
 *     ...and why did it not CROSS?         assay why FILE::NAME --cross
 *     ...and does the OTHER half answer it?  assay probe FILE::NAME | assay cross A B
 *     ...for a whole tree, not one pair?   assay bundle PATHS | assay sweep PATHS
 *     I have read this one and accept it   assay accept --reason "..." [LINE]
 *
 * EXIT CODES, identical for every subcommand, because scripts depend on them more than
 * on anything printed:
 *
 *     0   the tool ran and there is nothing to read
 *     1   at least one FINDING
 *     2   the tool could not run
 *
 * `look` items never affect the exit code. That is the whole reason they exist as a
 * separate verdict: a check that reports things a person then has to dismiss stops
 * being read, and an unread check occupies the place where a working one would go.
 *
 * `anchors` READS THE TABLE AS DATA rather than parsing source, which is the one thing
 * this half can do that the Python half cannot. Python lifts the table out with `ast`
 * and executes nothing; there is no parser in the JavaScript standard library and this
 * package has no dependencies, so the alternative here was a regex — and a regex cannot
 * tell a label from an anchor, so it would report confident nonsense. A harness opts in
 * by EXPORTING its table (`export const MUTATIONS = [...]`), which makes reading it a
 * property access with no approximation anywhere in the path. One that exports none is
 * a `look`, never a finding: it has not opted in, and inventing a reading of it is the
 * thing this deliberately does not do.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { auditAnchors } from './anchors.js';
import { auditDiff, auditRunners, checkExemptions } from './checks.js';
import {
  applyBaseline, CONFIG_NAMES, ConfigError, load, writeBaseline,
} from './config.js';
import {
  admit, BUNDLE_SCHEMA, collect, compare, compareCross, crossDiscriminating, crossKey,
  crossLadder, discriminating, discriminationDetail, displayPath, fileRefusal, group,
  jsFiles, ladder, ladderKey, probeFile, PROBE_SCHEMA, reportCensus, reportScan, Scan,
  SNIPPET_PATH, stripNonCode, UNSTATEABLE,
} from './sameness.js';
import { relativeSpecifiers } from './probe.js';
import { FINDING, Report, render, renderJson } from './verdicts.js';

const VERSION = '0.4.0';

const USAGE = `usage: assay [--root DIR] [--config FILE] [-q] [--json] <command>

  runners                     audit mutation runners against seven properties
  anchors                     every mutation anchor matches exactly once
  diff [--base REF]           does this change carry the checks it needs?
  all  [--base REF]           runners + anchors + diff
       [--scan PATH...]       ...and the sameness half over these paths
       [--sweep PATH...]      ...and the CROSS half over these
       [--against B]          ...against the other half's bundle
  accept [LINE] --reason R    write a finding into the baseline, with a reason
  scan PATH...                discover functions that answer the same question
  pair FILE::NAME FILE::NAME  compare two named functions
  search FILE::NAME --in DIR  does the tree already answer this?
         --against B          ...and/or does the OTHER language already answer it?
         --stdin [--name N]   ...about a function that is not a file yet
  why FILE::NAME              which gate refused this function, or that it was probed
      --cross                 ...on the SHARED ladder: why is it not in a bundle?
      --stdin [--name N]      ...about a function that is not a file yet
  probe FILE::NAME            one function's cross-language vector, as JSON on stdout
  cross A B [--with CMD]      compare a JavaScript function to a Python one
  bundle PATH...              a whole tree's cross vectors, as JSON on stdout
  sweep PATH... --against B   which functions here does the OTHER language answer?
        [--with CMD]          ...building B with the other binary over those paths

  --json                      one JSON object instead of the prose report

exit: 0 nothing to read, 1 findings, 2 could not run
`;

/**
 * Flags are accepted on BOTH sides of the subcommand, because that is how people type
 * them. A parser that only accepts `assay -q scan src` and rejects `assay scan src -q`
 * is one people work around rather than learn.
 */
export function parseArgs(argv) {
  const opts = {
    root: '.', config: null, quiet: false, base: 'origin/main',
    cmd: null, positional: [], into: [], scan: [], against: [], againstPaths: [],
    asJson: false, stdin: false, name: null, reason: null, withCmd: null, cross: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-q' || arg === '--quiet') opts.quiet = true;
    else if (arg === '--json') opts.asJson = true;
    else if (arg === '--stdin') opts.stdin = true;
    else if (arg === '--cross') opts.cross = true;
    else if (arg === '--root') { i += 1; opts.root = argv[i]; }
    else if (arg === '--config') { i += 1; opts.config = argv[i]; }
    else if (arg === '--base') { i += 1; opts.base = argv[i]; }
    else if (arg === '--reason') { i += 1; opts.reason = argv[i]; }
    else if (arg === '--with') { i += 1; opts.withCmd = argv[i]; }
    else if (arg === '--name') { i += 1; opts.name = argv[i]; }
    else if (arg === '--in' || arg === '--scan' || arg === '--against'
      || arg === '--sweep') {
      const target = {
        '--in': opts.into,
        '--scan': opts.scan,
        '--against': opts.against,
        '--sweep': opts.againstPaths,
      }[arg];
      i += 1;
      while (i < argv.length && !argv[i].startsWith('-')) { target.push(argv[i]); i += 1; }
      i -= 1;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--version') opts.version = true;
    else rest.push(arg);
  }
  [opts.cmd, ...opts.positional] = rest;
  return opts;
}

/**
 * Apply the baseline, render, and return the exit code.
 *
 * STALE DETECTION NEEDS A COMPLETE RUN, and getting this wrong made the tool cry wolf
 * at itself. A baseline line records a finding you have read and accepted; it goes
 * stale when it stops firing. But `runners` cannot produce a finding that only `diff`
 * reports, so checking staleness there flags every `diff` line as fixed — the audit
 * reporting a problem with its own config, on a clean tree, every run.
 *
 * So a line that does not fire is only called stale when the run performed EVERY audit
 * that can produce one, which is `assay all`. Every command still suppresses accepted
 * findings, because that direction is safe from any command: a line that fires is a
 * line that fires.
 *
 * `performed` is what this run actually audited, so a baseline entry that names the
 * command firing it can be answered by that command alone. Everything else is COUNTED
 * as not checked rather than silently treated as fresh.
 *
 * THIS HALF USED TO BE UNABLE TO HAVE A COMPLETE RUN AT ALL, because `anchors` was
 * Python-only, and it said so rather than printing `0 stale`. It now reads a mutation
 * table by importing it, so `assay all` here performs every audit.
 */
function baselineSummary(accepted, still, stale, unchecked) {
  const parts = [`${accepted} accepted`, `${still.length} new`, `${stale.length} stale`];
  if (unchecked.length) {
    const why = new Map();
    for (const entry of unchecked) {
      const key = entry.producedBy || 'no `from`, so it needs `assay all`';
      why.set(key, (why.get(key) || 0) + 1);
    }
    const named = [...why.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, n]) => `${k}: ${n}`).join('; ');
    parts.push(`${unchecked.length} NOT checked for staleness (${named})`);
  }
  return parts.join(', ');
}

function finish(report, config, write, opts, performed = []) {
  const verbose = !opts.quiet && !opts.asJson;
  if (config.baseline.length) {
    const [still, stale, unchecked] = applyBaseline(report.findings, config.baseline,
      performed);
    const accepted = report.findings.length - still.length;
    report.items = report.items.filter((i) => i.verdict !== FINDING).concat(still);
    for (const entry of stale) {
      report.finding('baseline line no longer fires (fixed? then delete it): '
        + `${entry.line}`);
    }
    // THE CAVEAT TRAVELS AS DATA rather than as a sentence a human has to notice.
    // `unchecked` is the caveat: a line this run could not have seen fire, which is a
    // different claim from one it checked and found still firing. There is no
    // `complete` boolean any more because completeness stopped being a property of the
    // RUN — `performed` says what this run audited, and each entry names the command
    // that can answer it.
    report.baseline = {
      path: config.path,
      accepted,
      new: still.length,
      performed: [...performed].sort(),
      stale: stale.map((e) => e.line),
      unchecked: unchecked.map((e) => ({ line: e.line, from: e.producedBy })),
    };
    if (verbose) {
      write(`\nBASELINE ${config.path} — `
        + `${baselineSummary(accepted, still, stale, unchecked)}\n`);
    }
  }
  if (opts.asJson) return renderJson(report, write, meta(opts));
  if (verbose) write(`\n${'-'.repeat(72)}\n`);
  return render(report, write, { verbose });
}

/**
 * What a machine reading this output needs in order to know whose it is.
 *
 * `language` is here because a polyglot repository runs both halves over one root, and
 * a consumer merging two reports has no other way to tell which produced which.
 */
function meta(opts) {
  return {
    version: VERSION, language: 'node', command: opts.cmd || null,
    root: path.resolve(opts.root),
  };
}

/**
 * Exit 2, in whichever shape the caller asked for. Always returns 2.
 *
 * UNDER `--json` A BROKEN INVOCATION STILL EMITS JSON. Prose on the failure path and
 * JSON everywhere else gives a consumer a parse error exactly when the tool could not
 * run, and a sloppy consumer reads that as no findings. "Could not run" and "found
 * nothing" are opposite situations; this is the one place where letting the second
 * swallow the first is easiest to do by accident.
 */
function fail(opts, write, message) {
  if (opts.asJson) return renderJson(null, write, meta(opts), message);
  write(`assay: ${message}\n`);
  return 2;
}

/**
 * One function of a `file.js::name` reference.
 *
 * `{ entry, display }` when it probed, `{ unresolved }` when the reference names
 * nothing, `{ display, unprobed }` when it names a real function this tool may not
 * execute. THE THIRD CASE IS NOT THE SECOND, and collapsing them is how exit 2 starts
 * meaning "found nothing". A function that exists and is refused — async, impure, the
 * wrong arity — is a `look`: the tool ran and cannot decide. Only a reference that
 * resolves to nothing is "the tool could not run". The Python half splits these the
 * same way, and its exit codes are the contract both halves publish.
 *
 * `display` is the reference renamed the way a scan names it, so `search` can exclude
 * the query itself by IDENTITY rather than by matching a name.
 */
async function probeRef(ref, cross = false) {
  const split = ref.lastIndexOf('::');
  if (split < 0) return { unresolved: `not a FILE::NAME reference: ${ref}` };
  const file = path.resolve(ref.slice(0, split));
  const name = ref.slice(split + 2);
  const display = `${displayPath(file)}::${name}`;
  const result = await probeFile(file, undefined, null, cross);
  if (result.error) return { unresolved: result.error };
  const entry = (result.functions || []).find((f) => f.name === name);
  if (!entry) return { unresolved: `${file} exports no function named ${name}` };
  if (entry.skip) return { display, unprobed: entry.skip };
  return { entry, display };
}

/**
 * The census, for one name: which gate refused THIS function.
 *
 * `assay scan` prints refusal reasons with counts, which is the right shape for a tree
 * and the wrong shape for a question. Somebody who expected a particular function to be
 * probed cannot read `no arguments 274` and learn whether theirs is one of the 274.
 *
 * THE FILE GATE IS CHECKED FIRST, and on this half that is usually the answer. Python
 * lifts one function's source out and never imports the module; here a function object
 * only exists once its module has been evaluated, so a file that reaches for the clock
 * or the filesystem is refused WHOLE and none of its functions were ever looked at.
 * Reporting a per-function reason for a file nobody opened would be a reason invented
 * after the fact.
 */
async function whyRef(ref, report, cross = false) {
  const split = ref.lastIndexOf('::');
  if (split < 0) return { unresolved: `not a FILE::NAME reference: ${ref}` };
  const file = path.resolve(ref.slice(0, split));
  const name = ref.slice(split + 2);
  const display = `${displayPath(file)}::${name}`;
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return { unresolved: `cannot read ${file}` };
  }
  const refused = fileRefusal(source);
  if (refused) {
    report.look(`${display} — the FILE was refused: ${refused}`, display,
      'the module was never loaded, so no function in it was looked at — this is a '
      + 'file-level answer and every other function here has the same one');
    return { answered: true };
  }
  const result = await probeFile(file, undefined, source, cross);
  if (result.error) return { unresolved: result.error };
  const entry = (result.functions || []).find((f) => f.name === name);
  if (!entry) {
    const roster = (result.functions || []).map((f) => f.name).sort();
    return {
      unresolved: `${displayPath(file)} EXPORTS no function named ${name} (it exports: `
        + `${roster.join(', ') || 'nothing'}). Only exported functions reach the probe: `
        + 'a module\'s functions arrive through its exports, and finding an unexported '
        + 'declaration would mean reading source with a regex',
    };
  }
  if (entry.skip) {
    report.look(cross ? `${display} — ${entry.skip}, on the SHARED ladder`
      : `${display} — ${entry.skip}`, display,
    cross ? 'refused before the ladder, so it is in no bundle and can cross with nothing'
      : 'refused before the ladder, so it is in no bucket and can pair with nothing');
    return { answered: true };
  }
  if (cross) reportCrossProbed(entry, display, report);
  else reportProbed(entry, display, report);
  return { answered: true };
}

/**
 * What a probed function's vector says about it: the `look`, or the `ok`.
 *
 * An `ok` is PRINTED rather than left silent, for the same reason every other one is:
 * "it was probed" and "nothing looked at it" are different claims and only one of them
 * is evidence.
 */
function reportProbed(entry, display, report) {
  if (undiscriminated(report, entry, display)) return;
  const inputs = ladder(entry.arity);
  const { returned, distinct } = discriminating(entry.vector, inputs);
  report.ok(`${display} — probed on ${ladderKey(entry.arity)}: ${returned} of `
    + `${entry.vector.length} rungs answered, ${distinct} distinct value(s)`, display);
}

/**
 * The same question about the SHARED ladder: why is this not in a bundle?
 *
 * `sweep` prints `50 functions, 0 probed, 50 not probed` and that is the right shape
 * for a tree and the wrong shape for a question. Somebody who expected a PARTICULAR
 * function to cross the boundary cannot read `not discriminated by the ladder 8` and
 * learn whether theirs is one of the eight — and the cross ladder refuses for a reason
 * the native one has no equivalent of, which is the whole reason this flag exists
 * rather than a footnote on the native answer.
 *
 * A NATIVE `why` CANNOT ANSWER THIS, and answering it as though it could is the
 * failure. The two ladders hold different values and refuse different functions: one
 * the native ladder discriminates can be a constant on the shared one, because the
 * shared one is the intersection of what the two languages can express. Reporting the
 * native verdict for a cross question would be confident and wrong.
 */
function reportCrossProbed(entry, display, report) {
  const rungs = crossLadder(entry.arity);
  // THE INTERLINGUA'S OWN REFUSAL, WHICH THE NATIVE LADDER HAS NO EQUIVALENT OF. An
  // outcome JSON cannot hold is not a value this can compare, and `compareCross` calls
  // such a pair a `look` rather than pronouncing on it. Naming the rung matters more
  // here than anywhere else: it is a fact about ONE input, and a person can usually see
  // immediately which of their return paths it is.
  const unstateable = [];
  entry.vector.forEach((o, i) => { if (o.startsWith('X:')) unstateable.push(i); });
  if (unstateable.length) {
    const first = unstateable[0];
    report.look(`${display} — ${UNSTATEABLE}`, display,
      `${unstateable.length} of ${entry.vector.length} rungs answered with one, the `
      + `first at ${JSON.stringify(rungs[first])} -> ${entry.vector[first]} — the `
      + 'interlingua is JSON, so bytes, a Map, a Date or a class instance cannot be '
      + 'said in it');
    return;
  }
  const detail = discriminationDetail(entry.vector, rungs, 'cross');
  if (detail !== null) {
    report.look(`${display} — not discriminated by the SHARED ladder`, display,
      `${detail}; the shared ladder is the intersection of what the two languages can `
      + 'express, so it discriminates less than the native one');
    return;
  }
  const { returned, distinct } = crossDiscriminating(entry.vector, rungs);
  report.ok(`${display} — probed on ${crossKey(entry.arity)}: ${returned} of `
    + `${entry.vector.length} rungs answered, ${distinct} distinct value(s)`, display);
}

/**
 * Report the `look` that says the ladder could not tell this function apart.
 *
 * True when it did, and nothing was decided. ONE PLACE FOR ONE ANSWER, because `why`
 * and `search` are asking the same question of the same vector — and the defect this
 * replaced was the two of them answering it differently. `search` deduced nothing and
 * printed the clean `same none`; `why`, on the identical function, said the ladder
 * could not see it. Two deciders that can disagree is the shape of defect this package
 * exists to report, and a sentence kept in step by hand is how they get there.
 */
function undiscriminated(report, entry, display) {
  const detail = discriminationDetail(entry.vector, ladder(entry.arity));
  if (detail === null) return false;
  report.look(`${display} — not discriminated by the ladder`, display, detail);
  return true;
}

/**
 * The two ways a query arrives, checked once for both commands that take them.
 *
 * A FILE::NAME names something that already exists; `--stdin` takes something that does
 * not exist yet, which is the case `search` is named for — SEARCH BEFORE YOU GENERATE
 * cannot mean "first write the file". `why` takes the same two because it is the same
 * question asked one step earlier, and answering it only for code already on disk would
 * mean writing the file first in order to be told the file was never the problem.
 *
 * A FLAG OR AN ARGUMENT THAT DOES NOT APPLY IS AN ERROR RATHER THAN A NO-OP. `--name`
 * picks one definition out of a snippet, so with a FILE::NAME it has nothing to pick;
 * a second reference is a second question this answers nothing about. Accepting either
 * quietly leaves something documented, parsed and inert.
 *
 * Returns the message to fail with, or null when the invocation makes sense.
 */
function queryFlags(opts) {
  if (opts.name !== null && !opts.stdin) {
    return '--name selects a function inside a --stdin snippet; '
      + 'a FILE::NAME already names one';
  }
  if (opts.stdin && opts.positional.length) {
    return '--stdin and a FILE::NAME are two different queries; give one';
  }
  if (!opts.stdin && !opts.positional.length) {
    return `${opts.cmd} needs a FILE::NAME or --stdin`;
  }
  if (opts.positional.length > 1) return `${opts.cmd} takes one FILE::NAME`;
  return null;
}

/**
 * Every audit, folded into `report`. Returns `{ families, performed }`.
 *
 * ONE PLACE KNOWS WHAT A COMPLETE RUN IS, and `accept` is why it has to be one. `all`
 * needs the list to say whether it may call a line stale; `accept` needs it to write
 * `from` on the entries it adds. Two lists that had to agree about what "every audit"
 * means would be the exact duplication this package exists to find, and the way they
 * would disagree is silent: `accept` would tag a line with a command `all` no longer
 * performs, and that line could then never be called stale.
 *
 * `--scan PATH` folds the sameness half in. WITHOUT IT THE RUN DID NOT PERFORM THAT
 * HALF, and saying otherwise is how a `same answer` line gets called stale on a clean
 * tree — so `scan` joins the performed set only when a scan actually ran.
 */
async function auditEverything(root, opts, config, report, document = null) {
  const families = new Map();
  const performed = [];
  // A SEPARATE REPORT PER AUDIT, so a finding can be attributed to the audit that
  // produced it. Reading it back off the shared report afterwards would mean guessing
  // from the message text, which is a parser of our own output.
  const perform = async (name, audit) => {
    const sub = new Report();
    await audit(sub);
    for (const item of sub.findings) {
      if (!families.has(item.message)) families.set(item.message, name);
    }
    report.extend(sub);
    performed.push(name);
  };
  await perform('runners', (rep) => {
    auditRunners(root, config, rep);
    checkExemptions(root, config, rep);
  });
  await perform('anchors', (rep) => auditAnchors(root, config, rep));
  await perform('diff', (rep) => auditDiff(root, opts.base, config, rep));
  if (opts.scan.length) {
    await perform('scan', async (rep) => {
      const scan = await collect(opts.scan);
      group(scan);
      reportScan(scan, rep);
      // The census as DATA travels on the SHARED report, because that is the one a
      // renderer sees. A sub-report is only ever a way to attribute findings to the
      // audit that produced them — so setting it on `rep` would drop it, and
      // `assay all --scan --json` answered `"scan": null` here while the Python half
      // answered with the census. One invocation, two documents, decided by which
      // binary CI installed.
      report.scan = scan.toDict();
    });
  }
  // THE CROSS HALF JOINS `performed` ONLY WHEN IT ACTUALLY RAN, exactly as `scan` does,
  // and for the same reason: a run that names an audit it did not perform can call a
  // line stale that nothing in the run could have fired.
  if (document) {
    await perform('sweep', async (rep) => {
      const scan = await collect(opts.againstPaths, new Scan(), true);
      const theirs = document.language || 'unknown';
      for (const [key, mine, them] of crossBuckets(scan, document)) {
        rep.finding(
          `same answer across languages (${key}): ${mine.join(', ')} [javascript]  vs  `
          + `${them.join(', ')} [${theirs}]`, mine[0],
          'no input in the shared ladder told them apart — READ them; only a person '
          + 'decides whether the duplication is a defect',
        );
      }
      reportScan(scan, rep);
      if (document.census) reportCensus(document.census, rep, `[${theirs}]`);
      report.other = {
        language: theirs, records: (document.records || []).length,
        census: document.census ?? null,
      };
    });
  }
  return { families, performed };
}

/**
 * The bundle `all` and `accept` will sweep against: `{ document }`, `{}` when none was
 * asked for, or `{ unresolved }`. Resolved BEFORE any audit runs.
 *
 * A bundle this half cannot read is exit 2, and finding that out after `runners`,
 * `anchors` and `diff` have all reported would bury the reason under three audits the
 * caller was not asking about — and, worse, print their findings from a run that then
 * exits 2, which reads as though those findings were the failure.
 */
function farSide(opts) {
  if (!opts.against.length) return {};
  const found = otherSide(opts.against, opts.withCmd);
  if (found.unresolved) return found;
  if (found.document.language === 'javascript') {
    return {
      unresolved: '--against is a javascript bundle and this is the javascript half — '
        + "`--scan` folds in one language's own ladder, which is stronger",
    };
  }
  if (!opts.againstPaths.length) {
    return {
      unresolved: '--against needs --sweep PATH: the bundle is the OTHER half\'s tree '
        + 'and this is the one to compare against it',
    };
  }
  return found;
}

// The suffix decides which half a reference belongs to. Inferred rather than declared,
// because a flag naming both a file and a language can disagree with itself and the
// suffix is the fact.
const LANGUAGE_OF = {
  '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
};

/** 'python' | 'javascript' | null, from a FILE::NAME reference's suffix. */
export function languageOf(ref) {
  const split = ref.lastIndexOf('::');
  const file = split < 0 ? ref : ref.slice(0, split);
  return LANGUAGE_OF[path.extname(file)] || null;
}

const CROSS_TIMEOUT_MS = 120000;

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const BUNDLE_TIMEOUT_MS = 900000;   // the OTHER half's `bundle`: a whole tree, not one

/**
 * Every function under `targets` as CROSS records, plus the census. One object.
 *
 * THE RECORDS ARE THE SAME SHAPE `assay probe` WRITES, and that is the point of the
 * envelope rather than a nicety: a bundle entry lifted out on its own is a record
 * `assay cross` already reads, so the two commands cannot come to mean different things
 * by `vector` without one of them failing its own schema check.
 *
 * A REFUSED FUNCTION IS IN THE CENSUS AND NOT IN `records`. Both facts are carried,
 * because a bundle whose `records` list is short and whose census is missing says
 * "nothing here answers that" for a tree it never managed to probe — which is the one
 * claim this tool exists to refuse to make.
 */
async function bundleDocument(targets) {
  const scan = await collect(targets, new Scan(), true);
  const records = [...scan.probed.keys()].sort().map((ref) => ({
    assay_probe: PROBE_SCHEMA,
    ref,
    language: 'javascript',
    arity: scan.arity.get(ref),
    ladder: scan.keys.get(ref),
    vector: scan.probed.get(ref),
    error: null,
  }));
  return {
    assay_bundle: BUNDLE_SCHEMA,
    assay_probe: PROBE_SCHEMA,
    language: 'javascript',
    records,
    census: scan.toDict(),
    error: null,
  };
}

/**
 * An `assay bundle` document from a file: `{ document }` or `{ unresolved }`.
 *
 * THE SCHEMA IS CHECKED, for the reason a record's is: a bundle from a version that
 * meant something else by `vector` would be compared anyway, and comparing a new answer
 * against the wrong earlier answer is precisely the defect a difference checker exists
 * to catch.
 */
function readBundle(file) {
  let document;
  try {
    document = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { unresolved: `cannot read ${file} as an \`assay bundle\` document (${err.message})` };
  }
  if (typeof document !== 'object' || document === null || !('assay_bundle' in document)) {
    return { unresolved: `${file} is not an \`assay bundle\` document` };
  }
  if (document.assay_bundle !== BUNDLE_SCHEMA) {
    return {
      unresolved: `${file} was written by bundle schema ${document.assay_bundle} and `
        + `this is schema ${BUNDLE_SCHEMA} — the two do not mean the same thing by `
        + '`records`',
    };
  }
  if (document.assay_probe !== PROBE_SCHEMA) {
    return {
      unresolved: `${file} carries records of schema ${document.assay_probe} and this `
        + `is schema ${PROBE_SCHEMA} — the two do not mean the same thing by \`vector\``,
    };
  }
  if (document.error) {
    return { unresolved: `${file} is a bundle that could not be built: ${document.error}` };
  }
  return { document };
}

/**
 * The other half's bundle: `{ document }` or `{ unresolved }`.
 *
 * TWO WAYS IN, and they are the two `cross` already has minus the one that cannot
 * apply. A `.json` path is a bundle somebody produced. Anything else is a list of paths
 * in the OTHER language, which needs the other binary — and `--with CMD` is how you say
 * where it is, rather than guessing at a command name that is `assay` for both packages.
 */
function otherSide(against, withCmd) {
  if (against.length === 1 && against[0].endsWith('.json') && existsSync(against[0])) {
    return readBundle(against[0]);
  }
  const named = against.join(' ');
  if (!withCmd) {
    return {
      unresolved: `--against ${named} does not name a bundle this half can read.\n`
        + `       Run \`assay bundle ${named} > other.json\` with the OTHER half's `
        + 'binary and pass\n       other.json here, or give --with CMD so this can run '
        + 'it for you.',
    };
  }
  const parts = withCmd.split(/\s+/).filter(Boolean);
  let stdout;
  try {
    stdout = execFileSync(parts[0], [...parts.slice(1), 'bundle', ...against],
      { encoding: 'utf8', timeout: BUNDLE_TIMEOUT_MS, maxBuffer: MAX_BUNDLE_BYTES });
  } catch (err) {
    return { unresolved: `--with '${withCmd}' could not run (${err.message})` };
  }
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    return { unresolved: `--with '${withCmd}' did not print an \`assay bundle\` document` };
  }
  if (document.assay_bundle !== BUNDLE_SCHEMA) {
    return {
      unresolved: `--with '${withCmd}' wrote bundle schema ${document.assay_bundle} and `
        + `this is schema ${BUNDLE_SCHEMA}`,
    };
  }
  // BOTH SCHEMAS, on this path as on the file one. The envelope and the record are
  // versioned apart, so a far binary whose bundle schema happens to match can still
  // mean something else by `vector` — and that is the comparison the check exists to
  // refuse, not the one it exists to allow.
  if (document.assay_probe !== PROBE_SCHEMA) {
    return {
      unresolved: `--with '${withCmd}' wrote records of schema ${document.assay_probe} `
        + `and this is schema ${PROBE_SCHEMA}`,
    };
  }
  if (document.error) {
    return { unresolved: `--with '${withCmd}' could not build a bundle: ${document.error}` };
  }
  return { document };
}

/**
 * The buckets both trees are in: `[[key, mine, theirs], ...]`, sorted.
 *
 * THE BUCKET IS THE COMPARISON, and it is a legitimate one only because `collect`
 * already refused everything `compareCross` would have refused: a vector holding an
 * outcome the interlingua cannot state, and a vector the ladder never told apart from a
 * constant. What survives to a bucket is a pair that command would have called `same`.
 * If that stops being true, this prints findings the pairwise command disagrees with,
 * and the weaker answer is the one on screen.
 */
function crossBuckets(scan, document) {
  const buckets = new Map();
  for (const [ref, vector] of scan.probed) {
    const key = `${scan.keys.get(ref)}|${vector.join(' ')}`;
    if (!buckets.has(key)) buckets.set(key, { ladder: scan.keys.get(ref), mine: [], theirs: [] });
    buckets.get(key).mine.push(ref);
  }
  for (const record of document.records || []) {
    const key = `${record.ladder}|${(record.vector || []).join(' ')}`;
    if (buckets.has(key)) buckets.get(key).theirs.push(record.ref);
  }
  const first = (row) => [row[1][0], row[2][0]];
  return [...buckets.values()]
    .filter((b) => b.theirs.length)
    .map((b) => [b.ladder, b.mine.sort(), b.theirs.sort()])
    // Ordered on the two REFS rather than on the two of them concatenated, because
    // that is what the Python half orders on — and one report printed in two orders is
    // one more thing a polyglot project has to know which binary produced.
    .sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0));
}

/**
 * The same object with its keys in sorted order, all the way down.
 *
 * `JSON.stringify` emits insertion order and Python's `json.dump` is asked to sort, so
 * without this the two halves write the same record as two different documents — and a
 * record is the one artefact that crosses between them.
 */
function sortedKeys(value) {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortedKeys(value[key]);
  return out;
}

/**
 * One function's CROSS record: `{ record }` or `{ unresolved }`.
 *
 * A refusal is a record with `look` instead of `vector` rather than an error: the
 * reference resolved and the tool ran, so this is not exit 2 — and a consumer gets one
 * shape either way.
 */
async function crossRecord(ref) {
  const split = ref.lastIndexOf('::');
  if (split < 0) return { unresolved: `not a FILE::NAME reference: ${ref}` };
  const file = path.resolve(ref.slice(0, split));
  const name = ref.slice(split + 2);
  const display = `${displayPath(file)}::${name}`;
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return { unresolved: `cannot read ${file}` };
  }
  const record = { assay_probe: PROBE_SCHEMA, ref: display, language: 'javascript' };
  const refused = fileRefusal(source);
  if (refused) return { record: { ...record, arity: 0, look: `the FILE was refused: ${refused}` } };
  const result = await probeFile(file, undefined, source, true);
  if (result.error) return { unresolved: result.error };
  const entry = (result.functions || []).find((f) => f.name === name);
  if (!entry) return { unresolved: `${displayPath(file)} exports no function named ${name}` };
  if (entry.skip) return { record: { ...record, arity: 0, look: entry.skip } };
  return {
    record: {
      ...record, arity: entry.arity, ladder: crossKey(entry.arity), vector: entry.vector,
    },
  };
}

/**
 * An `assay probe` record from a file: `{ record }` or `{ unresolved }`.
 *
 * THE SCHEMA IS CHECKED. A record from a version that meant something else by `vector`
 * would be compared anyway, and comparing a new answer against the wrong earlier
 * answer is precisely the defect a difference checker exists to catch.
 */
function readRecord(file) {
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { unresolved: `cannot read ${file} as an \`assay probe\` record (${err.message})` };
  }
  if (typeof record !== 'object' || record === null || !('assay_probe' in record)) {
    return { unresolved: `${file} is not an \`assay probe\` record` };
  }
  if (record.assay_probe !== PROBE_SCHEMA) {
    return {
      unresolved: `${file} was written by schema ${record.assay_probe} and this is `
        + `schema ${PROBE_SCHEMA} — the two do not mean the same thing by \`vector\``,
    };
  }
  return { record };
}

/**
 * One side of a cross comparison.
 *
 * THREE WAYS IN, and the third exists because the first two are not always enough. A
 * `.json` path is a record somebody already produced. A JavaScript reference is probed
 * here. A reference in the OTHER language needs the other binary, and `--with CMD` is
 * how you say where it is — without it this refuses and says exactly what to run,
 * rather than guessing at a command name that is `assay` for both packages.
 */
async function crossSide(ref, withCmd) {
  if (ref.endsWith('.json') && existsSync(ref)) return readRecord(ref);
  const language = languageOf(ref);
  if (language === 'javascript') return crossRecord(ref);
  if (language === null) {
    return {
      unresolved: `${ref} names no language this understands — a reference is `
        + 'FILE::NAME and the suffix says which half',
    };
  }
  if (!withCmd) {
    return {
      unresolved: `${ref} is a Python reference and this is the JavaScript half.\n`
        + `       Run \`assay probe ${ref} > side.json\` with the Python binary and `
        + 'pass\n       side.json here, or give --with CMD so this can run it for you.',
    };
  }
  const parts = withCmd.split(/\s+/).filter(Boolean);
  let stdout;
  try {
    stdout = execFileSync(parts[0], [...parts.slice(1), 'probe', ref],
      { encoding: 'utf8', timeout: CROSS_TIMEOUT_MS });
  } catch (err) {
    return { unresolved: `--with '${withCmd}' could not run (${err.message})` };
  }
  let record;
  try {
    record = JSON.parse(stdout);
  } catch {
    return { unresolved: `--with '${withCmd}' did not print an \`assay probe\` record` };
  }
  if (record.assay_probe !== PROBE_SCHEMA) {
    return {
      unresolved: `--with '${withCmd}' wrote schema ${record.assay_probe} and this is `
        + `schema ${PROBE_SCHEMA}`,
    };
  }
  return { record };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * One function of a snippet that is not a file yet, read from stdin.
 *
 * SEARCH BEFORE YOU GENERATE cannot mean "first write the file", which is what a
 * FILE::NAME-only command asks for. The same three shapes come back as `probeRef`
 * returns — probed, unresolved, or a real function this tool may not execute — and
 * they stay three for the same reason: a refused function is a `look`, and only a
 * query this tool cannot make sense of at all is exit 2.
 *
 * A SNIPPET MAY NOT IMPORT FROM THE TREE, and that is a limit rather than an
 * oversight. A module has to be on disk to be imported, so the snippet is written to a
 * temp file; outside the root its relative imports resolve to nothing, and inside the
 * root it would be scratch state beside the code under test, which is the thing
 * `no-tree-writes` audits harnesses for. A snippet that already imports half the tree
 * is a file, so point this at the file.
 */
async function probeStdin(text, wanted, cross = false) {
  // Named only when the caller named it: the module has not been loaded at this point,
  // so a snippet refused by the file gate has no roster and therefore no name. A
  // placeholder name would be a name this tool made up.
  const unnamed = wanted ? `${SNIPPET_PATH}::${wanted}` : SNIPPET_PATH;
  const why = fileRefusal(text);
  if (why) return { display: unnamed, unprobed: why };
  if (relativeSpecifiers(text).length) {
    return {
      display: unnamed,
      unprobed: 'the snippet imports from the tree — point search at the file instead',
    };
  }
  // A snippet with no `export` puts its functions nowhere the module system can reach,
  // and finding them anyway would mean reading declarations out of source with a
  // regex. `--name` is asked for instead: the user knows the name, and guessing at it
  // is how a tool starts reporting confident nonsense about code it never parsed.
  const stripped = stripNonCode(text, true);
  let source = text;
  if (stripped === null || !/(^|\n)\s*export[\s{]/.test(stripped)) {
    if (!wanted) {
      return {
        unresolved: 'the snippet exports nothing, so name the function with --name '
          + '(or add `export` to it)',
      };
    }
    if (!IDENTIFIER.test(wanted)) {
      return { unresolved: `not a function name: ${wanted}` };
    }
    source = `${text}\nexport { ${wanted} };\n`;
  }
  const file = path.join(tmpdir(), `assay-stdin-${process.pid}-${Date.now()}.mjs`);
  let result;
  try {
    writeFileSync(file, source);
    result = await probeFile(file, undefined, source, cross);
  } finally {
    try { unlinkSync(file); } catch { /* the probe may have been killed mid-write */ }
  }
  if (result.error) return { unresolved: result.error };
  const roster = result.functions || [];
  if (!roster.length) return { unresolved: 'the snippet defines no top-level function' };
  let entry;
  if (wanted) {
    entry = roster.find((f) => f.name === wanted);
    if (!entry) {
      return {
        unresolved: `the snippet defines no function named ${wanted} (it defines `
          + `${roster.map((f) => f.name).sort().join(', ')})`,
      };
    }
  } else if (roster.length > 1) {
    // NEVER GUESSED. Picking one would make the tool answer about code nobody asked
    // about, which reads exactly like an answer about the code they did ask about.
    return {
      unresolved: `the snippet defines ${roster.length} functions `
        + `(${roster.map((f) => f.name).sort().join(', ')}) — name one with --name`,
    };
  } else {
    [entry] = roster;
  }
  const display = `${SNIPPET_PATH}::${entry.name}`;
  if (entry.skip) return { display, unprobed: entry.skip };
  return { entry, display };
}

/**
 * `readStdin` is injected for the same reason `write` is: a CLI whose only interface
 * is the process it runs in cannot be tested except by spawning one, and a test that
 * spawns is a test that cannot see the Report the run built.
 */

/** The one-language half of `search`: this tree, on this language's own ladder. */
async function searchNative(found, targets, report) {
  if (found.unprobed) {
    report.look(`${found.display} — ${found.unprobed}`, found.display);
    report.note('       the tree was not searched, because this function could '
      + 'not be probed');
    return;
  }
  const { entry, display: ref } = found;
  // THERE ARE TWO WAYS NOT TO SEARCH and only one of them used to be reported. A query
  // refused before the ladder is obvious: no vector, nothing to match, and the branch
  // above says so. A query the ladder cannot DISCRIMINATE is the quiet one — it has a
  // vector, the matching runs, and it matches nothing, because `collect` files every
  // function the ladder cannot tell apart under skipped and a constant can therefore
  // only fail to find the other constants. This printed `same none`, which is the
  // clean result, for a search never capable of a hit.
  if (undiscriminated(report, entry, ref)) {
    report.note('       the tree was not searched: the census excludes every '
      + 'function this ladder cannot tell apart, so a match was never possible');
    return;
  }
  const scan = await collect(targets);
  const key = ladderKey(entry.arity);
  const target = entry.vector.join(' ');
  // Excluded by REFERENCE, not by name. Filtering every ref ending in the query's name
  // hides the answer the command exists to find: a second implementation that happens
  // to be called the same thing is still a second implementation.
  const hits = [...scan.probed.entries()]
    .filter(([r, v]) => scan.keys.get(r) === key && v.join(' ') === target && r !== ref)
    .map(([r]) => r).sort();
  if (hits.length) {
    report.finding(`the tree already answers ${ref}: ${hits.join(', ')}`, ref,
      'read them before writing a second one');
  } else {
    report.note(`\nsame   none — nothing in the tree matched ${ref}'s outcome vector`);
    report.note('       which is not proof that nothing answers it; see Limits');
  }
  reportScan(scan, report);
  report.scan = scan.toDict();
}

/**
 * The other-language half: one function against a bundle the far binary wrote.
 *
 * THE SAME THREE REFUSALS, STATED IN THE SAME WORDS, because this is `sweep`'s question
 * asked about one function instead of a tree — and `admit` is what both of them ask. A
 * query the shared ladder cannot tell apart from a constant can only fail to match the
 * other constants, and printing the clean `none` there would say "we found none" where
 * the truth is "we never looked". That difference costs the most on exactly this path:
 * the person reading it is about to write the function.
 */
function searchCross(found, document, report) {
  const language = document.language || 'unknown';
  if (found.unprobed) {
    report.look(`${found.display} — ${found.unprobed}`, found.display);
    report.note(`       the ${language} tree was not searched, because this function `
      + 'could not be probed on the shared ladder');
    return;
  }
  const { entry, display: ref } = found;
  const admitted = admit(entry.vector, entry.arity, true);
  if (admitted.key === undefined) {
    report.look(`${ref} — ${admitted.why}, on the SHARED ladder`, ref,
      'the shared ladder is the intersection of what the two languages can express, '
      + 'so it discriminates less than either native one');
    report.note(`       the ${language} tree was not searched: a match was never `
      + 'possible');
    return;
  }
  const target = entry.vector.join(' ');
  const hits = (document.records || [])
    .filter((r) => r.ladder === admitted.key && (r.vector || []).join(' ') === target)
    .map((r) => r.ref).sort();
  if (hits.length) {
    report.finding(`the ${language} tree already answers ${ref}: ${hits.join(', ')}`,
      ref,
      'no input in the shared ladder told them apart — READ them before writing a '
      + 'second one');
  } else {
    report.note(`\nsame   none across languages — nothing in the ${language} bundle `
      + `matched ${ref}'s outcome vector`);
  }
  if (document.census) reportCensus(document.census, report, `[${language}]`);
  report.other = {
    language, records: (document.records || []).length, census: document.census ?? null,
  };
}

export async function run(argv, write = (s) => process.stdout.write(s),
  readStdin = () => readFileSync(0, 'utf8')) {
  const opts = parseArgs(argv);
  if (opts.version) { write(`assay ${VERSION}\n`); return 0; }
  if (opts.help) { write(USAGE); return 2; }
  // The usage text is what a person typing nothing needs; a consumer that asked for
  // JSON needs the failure in the shape it can read. Same exit code either way.
  if (!opts.cmd) {
    if (opts.asJson) return fail(opts, write, 'no subcommand');
    write(USAGE);
    return 2;
  }

  let config;
  try {
    config = load(opts.config, opts.root);
  } catch (err) {
    if (err instanceof ConfigError) return fail(opts, write, err.message);
    throw err;
  }
  const root = path.resolve(opts.root);
  const report = new Report();
  // `--json` silences the prose, exactly as `finish` does. `accept` renders its own
  // report rather than going through `finish`, so it needs the same rule stated here.
  const verbose = !opts.quiet && !opts.asJson;

  switch (opts.cmd) {
    case 'anchors':
      await auditAnchors(root, config, report);
      return finish(report, config, write, opts, ['anchors']);

    case 'why': {
      const bad = queryFlags(opts);
      if (bad) return fail(opts, write, bad);
      // A SNIPPET HAS NO FILE GATE TO CHECK FIRST, which is the whole of the
      // difference between these two paths. `whyRef` reads a module off disk and asks
      // whether the FILE was refused before it asks anything about one function;
      // `probeStdin` was handed the text, so its refusal is already the answer.
      const found = opts.stdin
        ? await probeStdin(readStdin(), opts.name, opts.cross)
        : await whyRef(opts.positional[0], report, opts.cross);
      if (found.unresolved) return fail(opts, write, found.unresolved);
      if (!found.answered) {
        if (found.unprobed) {
          report.look(opts.cross
            ? `${found.display} — ${found.unprobed}, on the SHARED ladder`
            : `${found.display} — ${found.unprobed}`, found.display,
          opts.cross
            ? 'refused before the ladder, so it is in no bundle and can cross with '
              + 'nothing'
            : 'refused before the ladder, so it is in no bucket and can pair with '
              + 'nothing');
        } else if (opts.cross) {
          reportCrossProbed(found.entry, found.display, report);
        } else reportProbed(found.entry, found.display, report);
      }
      return finish(report, config, write, opts);
    }

    case 'probe': {
      // THE TWO HALVES DO NOT INVOKE EACH OTHER, and that is deliberate rather than
      // lazy. `npm install assay-checks` gives you this half and `pip install` gives
      // you the other; neither can assume the other is on the machine, and a command
      // that shells out to a binary that may not exist fails in a way that reads like
      // the code being wrong. So one half writes a record and the other reads it.
      //
      // ONE SHAPE, ALWAYS, AND `--json` IS NOT WHAT DECIDES IT. This command's output
      // IS JSON — there is no prose form to switch away from — so a reference that
      // names nothing emits the same record with `error` where `vector` would be, and
      // exits 2. A consumer never has to ask which of two shapes it received, and `2`
      // still means the tool could not run.
      const ref = opts.positional[0];
      const said = (record, code) => {
        write(`${JSON.stringify(sortedKeys(record), null, 2)}\n`);
        return code;
      };
      if (opts.positional.length !== 1) {
        return said({
          assay_probe: PROBE_SCHEMA, ref: ref || null, language: 'javascript',
          error: 'probe needs one FILE::NAME',
        }, 2);
      }
      const found = await crossRecord(ref);
      if (found.unresolved) {
        return said({
          assay_probe: PROBE_SCHEMA, ref, language: 'javascript',
          error: found.unresolved,
        }, 2);
      }
      return said({ ...found.record, error: null }, 0);
    }

    case 'bundle': {
      // `assay cross` answers about two functions somebody already suspected. Nobody
      // suspects the pair that matters: a validator written once in the API and again
      // in the front end, by two people, a year apart, is exactly the duplication no
      // one goes looking for. Finding it means probing both trees, and the halves do
      // not invoke each other — so one writes a bundle and the other reads it.
      //
      // IT WRITES JSON ON STDOUT and emits ONE SHAPE on every path: a broken
      // invocation is the same document with `error` set and exit 2, so a consumer
      // never has to ask which of two shapes it received.
      const said = (document, code) => {
        write(`${JSON.stringify(sortedKeys(document), null, 2)}\n`);
        return code;
      };
      const envelope = {
        assay_bundle: BUNDLE_SCHEMA, assay_probe: PROBE_SCHEMA, language: 'javascript',
      };
      if (!opts.positional.length) {
        return said({
          ...envelope, records: [], census: null, error: 'bundle needs a path',
        }, 2);
      }
      return said(await bundleDocument(opts.positional), 0);
    }

    case 'sweep': {
      // Which functions in THIS tree does the other language already answer?
      //
      // `cross` needs the pair named. This needs neither name, which is what makes it
      // the command that finds the duplication a polyglot repository actually
      // accumulates: two implementations of one rule, one per language, that no
      // differential test covers because writing one means agreeing by hand on what
      // `false` and `False` have in common.
      if (!opts.positional.length) return fail(opts, write, 'sweep needs a path');
      const found = otherSide(opts.against, opts.withCmd);
      if (found.unresolved) return fail(opts, write, found.unresolved);
      const document = found.document;
      if (document.language === 'javascript') {
        return fail(opts, write,
          '--against is a javascript bundle and this is the javascript half — `scan` '
          + "compares one language's functions on its own ladder, which is stronger");
      }
      const theirs = document.language || 'unknown';
      const scan = await collect(opts.positional, new Scan(), true);
      const shared = crossBuckets(scan, document);
      for (const [key, mine, them] of shared) {
        report.finding(
          `same answer across languages (${key}): ${mine.join(', ')} [javascript]  vs  `
          + `${them.join(', ')} [${theirs}]`, mine[0],
          'no input in the shared ladder told them apart — READ them; only a person '
          + 'decides whether the duplication is a defect',
        );
      }
      if (!shared.length) {
        report.note('\nsame   none — no function here shares an outcome vector with '
          + `one in the ${theirs} bundle`);
      }
      reportScan(scan, report);
      // BOTH CENSUSES ARE PRINTED, and the other half's is the one that would
      // otherwise lie by omission. A function the OTHER binary refused was never
      // compared, and a report that says `same none` while staying quiet about the two
      // hundred functions the far side never probed is reporting "we never looked" as
      // "we found none" — across a boundary where the reader has no way to check.
      if (document.census) reportCensus(document.census, report, `[${theirs}]`);
      report.scan = scan.toDict();
      report.other = {
        language: theirs, records: (document.records || []).length,
        census: document.census ?? null,
      };
      return finish(report, config, write, opts);
    }

    case 'cross': {
      if (opts.positional.length !== 2) {
        return fail(opts, write, 'cross needs two references');
      }
      const sides = [];
      for (const ref of opts.positional) {
        // eslint-disable-next-line no-await-in-loop
        const found = await crossSide(ref, opts.withCmd);
        if (found.unresolved) return fail(opts, write, found.unresolved);
        sides.push(found.record);
      }
      const [first, second] = sides;
      const pair = `${first.ref} [${first.language}]  vs  ${second.ref} [${second.language}]`;
      const refused = sides.find((s) => s.look !== undefined);
      if (refused) {
        report.look(`${pair} — ${refused.ref} could not be probed: ${refused.look}`,
          first.ref);
        return finish(report, config, write, opts);
      }
      if (first.language === second.language) {
        report.look(`${pair} — both sides are ${first.language}; \`pair\` compares two `
          + 'functions of one language on its own ladder, which is stronger', first.ref);
        return finish(report, config, write, opts);
      }
      const rungs = crossLadder(first.arity);
      const [verdict, detail] = compareCross(first.vector, second.vector, first.ladder,
        second.ladder, rungs);
      if (verdict === 'same') {
        report.finding(`same answer across languages (${first.ladder}): ${pair}`,
          first.ref,
          'no input in the shared ladder told them apart — READ them; only a person '
          + 'decides whether the duplication is a defect');
      } else if (verdict === 'differs') {
        report.ok(`differs: ${pair} — ${detail}`, first.ref);
      } else {
        report.look(`${pair} — ${detail}`, first.ref);
      }
      return finish(report, config, write, opts);
    }

    case 'runners':
      auditRunners(root, config, report);
      checkExemptions(root, config, report);
      return finish(report, config, write, opts, ['runners']);

    case 'diff':
      auditDiff(root, opts.base, config, report);
      return finish(report, config, write, opts, ['diff']);

    case 'all': {
      const far = farSide(opts);
      if (far.unresolved) return fail(opts, write, far.unresolved);
      const { performed } = await auditEverything(root, opts, config, report,
        far.document || null);
      return finish(report, config, write, opts, performed);
    }

    case 'accept': {
      if (!opts.reason) {
        return fail(opts, write, 'accept needs --reason. An acceptance without one '
          + 'cannot be told from an oversight,\n       and the baseline is the table '
          + 'that accumulates most and rots first.');
      }
      const far = farSide(opts);
      if (far.unresolved) return fail(opts, write, far.unresolved);
      const { families } = await auditEverything(root, opts, config, report,
        far.document || null);
      const known = new Set(config.baselineLines);
      const fired = new Set(report.findings.map((i) => i.message));
      const line = opts.positional[0];
      let chosen;
      if (line !== undefined) {
        if (known.has(line)) return fail(opts, write, `already in the baseline: ${line}`);
        if (report.looks.some((i) => i.message === line)) {
          return fail(opts, write, 'that line is a `look`. '
            + 'A `look` never fails the run, so there is nothing\n'
            + '       to accept: baselining one writes a record that can never match '
            + 'and\n       never expire.');
        }
        if (!fired.has(line)) {
          return fail(opts, write, 'nothing in this run printed that line. Accepting '
            + 'it would write an entry\n'
            + '       that is stale the moment it lands — paste a `finding` exactly '
            + 'as it was\n       printed.');
        }
        chosen = [line];
      } else {
        chosen = report.findings.map((i) => i.message).filter((m) => !known.has(m));
      }
      // WHAT IT WROTE IS REPORTED AS `ok` ITEMS, and this deliberately does NOT go
      // through `finish`. `finish` applies the baseline, and the baseline it would
      // apply is the one loaded BEFORE these lines were written — so every entry
      // already in the file would be measured against a report holding no findings at
      // all and come back stale. An audit reading its own writing is not an audit.
      const written = new Report();
      if (!chosen.length) {
        written.note('assay: nothing new to accept.');
      } else {
        const file = config.path || path.join(root, CONFIG_NAMES[0]);
        writeBaseline(file, chosen.map((l) => ({
          line: l, reason: opts.reason, producedBy: families.get(l) || null,
        })));
        written.note(`assay: wrote ${chosen.length} `
          + `${chosen.length === 1 ? 'entry' : 'entries'} to ${file}`);
        for (const l of chosen) written.ok(`[${families.get(l) || 'no from'}] ${l}`);
      }
      if (opts.asJson) return renderJson(written, write, meta(opts));
      render(written, write, { verbose });
      return 0;
    }

    case 'scan': {
      if (!opts.positional.length) return fail(opts, write, 'scan needs a path');
      const scan = await collect(opts.positional);
      group(scan);
      reportScan(scan, report);
      report.scan = scan.toDict();
      if (!scan.groups.length) {
        report.note('\nsame   none — no two probed functions share an outcome vector');
      }
      return finish(report, config, write, opts, ['scan']);
    }

    case 'pair': {
      if (opts.positional.length !== 2) return fail(opts, write, 'pair needs two refs');
      const probes = [];
      for (const ref of opts.positional) {
        // eslint-disable-next-line no-await-in-loop
        const found = await probeRef(ref);
        if (found.unresolved) return fail(opts, write, found.unresolved);
        if (found.unprobed) {
          // A function this tool may not execute is a `look`, not a failed run.
          report.look(`${found.display} — ${found.unprobed}`, found.display);
          return finish(report, config, write, opts);
        }
        probes.push([found.display, found.entry]);
      }
      const [[refA, a], [refB, b]] = probes;
      const [verdict, detail] = compare(
        a.vector, b.vector, ladderKey(a.arity), ladderKey(b.arity), ladder(a.arity),
      );
      const pair = `${refA}  vs  ${refB}`;
      if (verdict === 'same') report.finding(`same answer: ${pair}`, refA, detail);
      else if (verdict === 'differs') report.ok(`differs: ${pair} — ${detail}`, refA);
      else report.look(`${pair} — ${detail}`, refA);
      return finish(report, config, write, opts);
    }

    case 'search': {
      if (!opts.into.length && !opts.against.length) {
        return fail(opts, write, 'search needs --in DIR or --against BUNDLE');
      }
      const bad = queryFlags(opts);
      if (bad) return fail(opts, write, bad);
      // THE FAR SIDE IS RESOLVED BEFORE ANYTHING IS PROBED. A bundle this half cannot
      // read is exit 2, and finding that out AFTER a tree of subprocesses have run
      // wastes the run and buries the reason under a census nobody was going to use.
      let document = null;
      if (opts.against.length) {
        const far = otherSide(opts.against, opts.withCmd);
        if (far.unresolved) return fail(opts, write, far.unresolved);
        document = far.document;
        if (document.language === 'javascript') {
          return fail(opts, write,
            '--against is a javascript bundle and this is the javascript half — '
            + "`--in` searches one language's tree on its own ladder, which is "
            + 'stronger');
        }
      }
      // READ ONCE. Both halves ask about the same function, and stdin cannot be read
      // twice — a second read returns nothing, which would make the cross half report
      // an empty snippet as though the caller had sent one.
      const text = opts.stdin ? readStdin() : null;
      const ask = (cross) => (opts.stdin
        ? probeStdin(text, opts.name, cross)
        : probeRef(opts.positional[0], cross));
      if (opts.into.length) {
        const found = await ask(false);
        if (found.unresolved) return fail(opts, write, found.unresolved);
        await searchNative(found, opts.into, report);
      }
      if (document) {
        const found = await ask(true);
        if (found.unresolved) return fail(opts, write, found.unresolved);
        searchCross(found, document, report);
      }
      return finish(report, config, write, opts);
    }

    default:
      if (opts.asJson) return fail(opts, write, `unknown command ${opts.cmd}`);
      write(`assay: unknown command ${opts.cmd}\n\n${USAGE}`);
      return 2;
  }
}

/**
 * Was this file run as a program, or imported by something else?
 *
 * BOTH SIDES ARE REALPATH'D, and that is the entire point of the function. `npm`
 * installs a `bin` as a SYMLINK: `node_modules/.bin/assay` points at
 * `node_modules/assay-checks/js/src/cli.js`, so `process.argv[1]` is the LINK while
 * `import.meta.url` is its TARGET. Comparing them without resolving made every
 * invocation of the installed command do nothing, print nothing, and exit 0 — the code
 * that means "the tool ran and there is nothing to read". The published CLI reported a
 * clean tree by never having run, which is the exact failure this package exists to
 * report, shipped inside the package that reports it.
 *
 * `path.resolve` was never enough: it makes a path absolute and leaves symlinks alone.
 * Comparing resolved PATHS also drops the hand-built `file://` URL, which mangled any
 * directory containing a space or a `#`.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1])
      === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this file being run as a program.
    return false;
  }
}

if (invokedDirectly()) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

export { jsFiles, Scan };
