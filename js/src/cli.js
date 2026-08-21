#!/usr/bin/env node
/**
 * assay — one command for two questions ordinary CI does not answer.
 *
 *     could those checks have failed?      assay runners | diff | all
 *     does the tree already answer this?   assay scan | pair | search
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
 * `anchors` is Python-only and this CLI says so rather than shipping a weak version.
 * Pulling a mutation table out of source needs a real parser; the Python half has one
 * in its standard library and this package has no dependencies. A regex that reports
 * confident nonsense about which strings are anchors would be worse than the gap.
 */

import path from 'node:path';
import process from 'node:process';

import { auditDiff, auditRunners, checkExemptions } from './checks.js';
import { applyBaseline, ConfigError, load } from './config.js';
import {
  collect, compare, displayPath, group, jsFiles, ladder, ladderKey, probeFile,
  reportScan, Scan,
} from './sameness.js';
import { FINDING, Report, render } from './verdicts.js';

const USAGE = `usage: assay [--root DIR] [--config FILE] [-q] <command>

  runners                     audit mutation runners against six properties
  diff [--base REF]           does this change carry the checks it needs?
  all  [--base REF]           runners + diff
       [--scan PATH...]       ...and the sameness half over these paths
  scan PATH...                discover functions that answer the same question
  pair FILE::NAME FILE::NAME  compare two named functions
  search FILE::NAME --in DIR  does the tree already answer this?

  anchors                     Python only — see \`assay\` on PyPI

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
    cmd: null, positional: [], into: [], scan: [],
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-q' || arg === '--quiet') opts.quiet = true;
    else if (arg === '--root') { i += 1; opts.root = argv[i]; }
    else if (arg === '--config') { i += 1; opts.config = argv[i]; }
    else if (arg === '--base') { i += 1; opts.base = argv[i]; }
    else if (arg === '--in' || arg === '--scan') {
      const target = arg === '--in' ? opts.into : opts.scan;
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
 * STALE DETECTION NEEDS A COMPLETE RUN, and this half can never have one. A baseline
 * line records a finding you have read and accepted, and it goes stale when it stops
 * firing — but `runners` cannot produce a finding that only `diff` reports, so calling
 * a line stale from a partial run marks every other command's lines as fixed. That is
 * the audit reporting a problem with its own config, on a clean tree, on every run,
 * and it was caught on this tool's own repository. The Python half therefore calls a
 * line stale only from `assay all`, the one command that performs every audit able to
 * produce one.
 *
 * `anchors` is Python-only, so NO command here performs them all and this half never
 * calls a line stale. It says so, rather than printing `0 stale` and letting that read
 * as "nothing is stale" — a gap stated is a limit, a gap unstated is a bug report
 * waiting to happen.
 *
 * Suppression still works, from any command, because that direction is safe from a
 * partial run: a line that fires is a line that fires.
 */
function finish(report, config, write, verbose) {
  if (config.baseline.length) {
    const [still] = applyBaseline(report.findings, config.baseline);
    const accepted = report.findings.length - still.length;
    report.items = report.items.filter((i) => i.verdict !== FINDING).concat(still);
    if (verbose) {
      write(`\nBASELINE ${config.path} — ${accepted} accepted, ${still.length} new, `
        + 'staleness needs the Python `assay all` (this half cannot run `anchors`)\n');
    }
  }
  if (verbose) write(`\n${'-'.repeat(72)}\n`);
  return render(report, write, { verbose });
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
async function probeRef(ref) {
  const split = ref.lastIndexOf('::');
  if (split < 0) return { unresolved: `not a FILE::NAME reference: ${ref}` };
  const file = path.resolve(ref.slice(0, split));
  const name = ref.slice(split + 2);
  const display = `${displayPath(file)}::${name}`;
  const result = await probeFile(file);
  if (result.error) return { unresolved: result.error };
  const entry = (result.functions || []).find((f) => f.name === name);
  if (!entry) return { unresolved: `${file} exports no function named ${name}` };
  if (entry.skip) return { display, unprobed: entry.skip };
  return { entry, display };
}

export async function run(argv, write = (s) => process.stdout.write(s)) {
  const opts = parseArgs(argv);
  if (opts.version) { write('assay 0.2.0\n'); return 0; }
  if (opts.help || !opts.cmd) { write(USAGE); return 2; }

  let config;
  try {
    config = load(opts.config, opts.root);
  } catch (err) {
    if (err instanceof ConfigError) { write(`assay: ${err.message}\n`); return 2; }
    throw err;
  }
  const root = path.resolve(opts.root);
  const report = new Report();
  const verbose = !opts.quiet;

  switch (opts.cmd) {
    case 'anchors':
      write('assay: `anchors` is implemented in the Python package only.\n'
        + '       Pulling a mutation table out of source needs a real parser, and a\n'
        + '       regex version would report confident nonsense. Use `pip install\n'
        + '       assay` for that command.\n');
      return 2;

    case 'runners':
      auditRunners(root, config, report);
      checkExemptions(root, config, report);
      return finish(report, config, write, verbose);

    case 'diff':
      auditDiff(root, opts.base, config, report);
      return finish(report, config, write, verbose);

    case 'all': {
      auditRunners(root, config, report);
      checkExemptions(root, config, report);
      auditDiff(root, opts.base, config, report);
      // `--scan PATH` folds the sameness half into the same run and the same report,
      // as it does on the Python side. Without it `all` covers the check half only.
      if (opts.scan.length) {
        const scan = await collect(opts.scan);
        group(scan);
        reportScan(scan, report);
      }
      return finish(report, config, write, verbose);
    }

    case 'scan': {
      if (!opts.positional.length) { write('assay scan needs a path\n'); return 2; }
      const scan = await collect(opts.positional);
      group(scan);
      reportScan(scan, report);
      if (!scan.groups.length) {
        report.note('\nsame   none — no two probed functions share an outcome vector');
      }
      return finish(report, config, write, verbose);
    }

    case 'pair': {
      if (opts.positional.length !== 2) { write('assay pair needs two refs\n'); return 2; }
      const probes = [];
      for (const ref of opts.positional) {
        // eslint-disable-next-line no-await-in-loop
        const found = await probeRef(ref);
        if (found.unresolved) { write(`assay: ${found.unresolved}\n`); return 2; }
        if (found.unprobed) {
          // A function this tool may not execute is a `look`, not a failed run.
          report.look(`${found.display} — ${found.unprobed}`, found.display);
          return finish(report, config, write, verbose);
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
      return finish(report, config, write, verbose);
    }

    case 'search': {
      if (!opts.positional.length) { write('assay search needs a ref\n'); return 2; }
      if (!opts.into.length) { write('assay search needs --in DIR\n'); return 2; }
      const found = await probeRef(opts.positional[0]);
      if (found.unresolved) { write(`assay: ${found.unresolved}\n`); return 2; }
      if (found.unprobed) {
        report.look(`${found.display} — ${found.unprobed}`, found.display);
        report.note('       the tree was not searched, because this function could '
          + 'not be probed');
        return finish(report, config, write, verbose);
      }
      const { entry, display: ref } = found;
      const scan = await collect(opts.into);
      const key = ladderKey(entry.arity);
      const target = entry.vector.join(' ');
      // Excluded by REFERENCE, not by name. Filtering every ref ending in the query's
      // name hides the answer the command exists to find: a second implementation
      // that happens to be called the same thing is still a second implementation.
      const hits = [...scan.probed.entries()]
        .filter(([r, v]) => scan.keys.get(r) === key && v.join(' ') === target
          && r !== ref)
        .map(([r]) => r).sort();
      if (hits.length) {
        report.finding(`the tree already answers ${ref}: ${hits.join(', ')}`, ref,
          'read them before writing a second one');
      } else {
        report.note(`\nsame   none — nothing in the tree matched ${ref}'s outcome vector`);
        report.note('       which is not proof that nothing answers it; see Limits');
      }
      reportScan(scan, report);
      return finish(report, config, write, verbose);
    }

    default:
      write(`assay: unknown command ${opts.cmd}\n\n${USAGE}`);
      return 2;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

export { jsFiles, Scan };
