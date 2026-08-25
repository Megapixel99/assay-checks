"""assay — one command for two questions ordinary CI does not answer.

    could those checks have failed?      assay runners | anchors | diff | all
    does the tree already answer this?   assay scan | pair | search

Both halves ask about work that ALREADY PASSES ITS TESTS, which is why neither is a
linter and neither is a test runner. A green suite tells you the code did what the
suite asked; it tells you nothing about whether the suite could have objected, and
nothing about whether the code needed to be written at all.

EXIT CODES, identical for every subcommand, because scripts depend on them more than
on anything printed:

    0   the tool ran and there is nothing to read
    1   at least one FINDING
    2   the tool could not run

`look` items never affect the exit code. That is the whole reason they exist as a
separate verdict: a check that reports things a person then has to dismiss stops being
read, and an unread check occupies the place where a working one would go.
"""

import argparse
import os
import sys

from . import __version__
from .anchors import audit_anchors
from .checks import audit_diff, audit_runners, check_exemptions
from .config import ConfigError, apply_baseline, load
from .sameness import (collect, compare, group, ladder, ladder_key, probe,
                       report_scan, resolve)
from .verdicts import FINDING, Report, render, render_json


def _meta(args):
    """What a machine reading this output needs in order to know whose it is.

    `language` is here because a polyglot repository runs both halves over one root,
    and a consumer merging two reports has no other way to tell which produced which.
    """
    return {"version": __version__, "language": "python",
            "command": getattr(args, "cmd", None), "root": getattr(args, "root", None)}


def _fail(args, out, message):
    """Exit 2, in whichever shape the caller asked for. Always returns 2.

    UNDER `--json` A BROKEN INVOCATION STILL EMITS JSON. Prose on the failure path and
    JSON everywhere else gives a consumer a parse error exactly when the tool could not
    run, and a sloppy consumer reads that as no findings. "Could not run" and "found
    nothing" are opposite situations; this is the one place where letting the second
    swallow the first is easiest to do by accident.
    """
    if getattr(args, "as_json", False):
        return render_json(None, out, meta=_meta(args), error=message)
    out.write("assay: %s\n" % message)
    return 2


def _finish(args, report, config, out, complete=False):
    """Apply the baseline, render, and return the exit code.

    STALE DETECTION NEEDS A COMPLETE RUN, and getting this wrong made the tool cry
    wolf at itself. A baseline line records a finding you have read and accepted; it
    goes stale when it stops firing. But `assay runners` cannot produce a finding that
    only `diff` reports, so checking staleness there flags every `diff` line as fixed —
    the audit reporting a problem with its own config, on a clean tree, every run.

    So a line that does not fire is only called stale when the run performed EVERY
    audit that can produce one, which is `assay all`. Every command still suppresses
    accepted findings, because that direction is safe from any command: a line that
    fires is a line that fires.
    """
    verbose = args.verbose and not args.as_json
    if config.baseline:
        still, stale = apply_baseline(report.findings, config.baseline)
        accepted = len(report.findings) - len(still)
        report.items = [i for i in report.items if i.verdict != FINDING] + still
        if complete:
            for line in stale:
                report.finding("baseline line no longer fires (fixed? then delete "
                               "it): %s" % line)
        # THE CAVEAT TRAVELS AS DATA rather than as a sentence a human has to notice.
        # A partial run reports no stale lines and one that checked reports none it
        # found, and those are different claims; `complete` is what tells them apart.
        report.baseline = {
            "path": config.path, "accepted": accepted, "new": len(still),
            "complete": complete, "stale": list(stale) if complete else [],
            "incomplete_because": None if complete else "staleness needs `assay all`",
        }
        if verbose:
            out.write("\nBASELINE %s — %d accepted, %d new, %s\n"
                      % (config.path, accepted, len(still),
                         "%d stale" % len(stale) if complete
                         else "staleness needs `assay all`"))
    if args.as_json:
        return render_json(report, out, meta=_meta(args))
    if verbose:
        out.write("\n%s\n" % ("-" * 72))
    return render(report, out, verbose=verbose)


def cmd_runners(args, config, out):
    report = Report()
    audit_runners(args.root, config, report)
    check_exemptions(args.root, config, report)
    return _finish(args, report, config, out)


def cmd_anchors(args, config, out):
    report = Report()
    audit_anchors(args.root, config, report)
    return _finish(args, report, config, out)


def cmd_diff(args, config, out):
    report = Report()
    audit_diff(args.root, args.base, config, report)
    return _finish(args, report, config, out)


def cmd_all(args, config, out):
    """Every audit in one run — and the only command that can call a baseline stale.

    `--scan PATH` folds the sameness half in. Without it `all` covers the check half
    only, so a baseline holding `same answer` lines would report them stale; the
    completeness flag therefore tracks whether a scan actually ran.
    """
    report = Report()
    audit_runners(args.root, config, report)
    check_exemptions(args.root, config, report)
    audit_anchors(args.root, config, report)
    audit_diff(args.root, args.base, config, report)
    scanned = getattr(args, "scan", None)
    if scanned:
        scan = collect(scanned)
        group(scan)
        report_scan(scan, report)
        report.scan = scan.to_dict()
    return _finish(args, report, config, out, complete=True)


def cmd_scan(args, config, out):
    scan = collect(args.paths)
    group(scan)
    report = report_scan(scan)
    report.scan = scan.to_dict()
    if not scan.groups:
        report.note("\nsame   none — no two probed functions share an outcome vector")
    return _finish(args, report, config, out)


def cmd_pair(args, config, out):
    report = Report()
    funcs = []
    for ref in (args.a, args.b):
        func = resolve(ref)
        if func is None:
            return _fail(args, out, "cannot resolve %s" % ref)
        funcs.append(func)
    first, second = funcs
    vectors = []
    for func in funcs:
        vector, why = probe(func)
        if vector is None:
            report.look("%s — %s" % (func.ref, why), func.ref)
            return _finish(args, report, config, out)
        vectors.append(vector)
    verdict, detail = compare(vectors[0], vectors[1], ladder_key(first),
                              ladder_key(second), ladder(len(first.params)))
    pair = "%s  vs  %s" % (first.ref, second.ref)
    if verdict == "same":
        report.finding("same answer: %s" % pair, first.ref, detail)
    elif verdict == "differs":
        report.ok("differs: %s — %s" % (pair, detail), first.ref)
    else:
        report.look("%s — %s" % (pair, detail), first.ref)
    return _finish(args, report, config, out)


def cmd_search(args, config, out):
    query = resolve(args.ref)
    if query is None:
        return _fail(args, out, "cannot resolve %s" % args.ref)
    report = Report()
    vector, why = probe(query)
    if vector is None:
        report.look("%s — %s" % (query.ref, why), query.ref)
        report.note("       the tree was not searched, because this function could "
                    "not be probed")
        return _finish(args, report, config, out)
    scan = collect(args.into)
    key = ladder_key(query)
    hits = sorted(ref for ref, vec in scan.probed.items()
                  if scan.keys[ref] == key and vec == vector and ref != query.ref)
    if hits:
        report.finding("the tree already answers %s: %s"
                       % (query.ref, ", ".join(hits)), query.ref,
                       "read them before writing a second one")
    else:
        report.note("\nsame   none — nothing in the tree matched %s's outcome vector"
                    % query.ref)
        report.note("       which is not proof that nothing answers it; see Limits")
    report_scan(scan, report)
    report.scan = scan.to_dict()
    return _finish(args, report, config, out)


COMMANDS = {
    "runners": cmd_runners,
    "anchors": cmd_anchors,
    "diff": cmd_diff,
    "all": cmd_all,
    "scan": cmd_scan,
    "pair": cmd_pair,
    "search": cmd_search,
}


def _common(defaults=False):
    """Flags every subcommand accepts, BEFORE or AFTER the subcommand name.

    `assay scan src -q` is how people type it, and a parent-level flag placed after a
    subcommand is an argparse error unless every subparser also declares it.

    A FRESH PARSER PER CALL, and that is not tidiness. `parents=[...]` copies action
    REFERENCES rather than the actions themselves, so every parser built from one
    shared parent holds the same objects — and anything that writes to an action's
    default writes it everywhere at once. With one shared instance, `assay -q scan X`
    parsed `quiet=True` at the top level and the subparser then overwrote it with its
    own default, silently. The flag was accepted, echoed in `--help`, and did nothing.

    On the subparsers the defaults are SUPPRESS, so an absent flag contributes no
    attribute at all and cannot overwrite what the main parser already parsed. Only
    the main parser's copy carries real defaults, which is why the attributes always
    exist by the time `main()` reads them.
    """
    common = argparse.ArgumentParser(add_help=False)
    nothing = argparse.SUPPRESS
    common.add_argument("-q", "--quiet", action="store_true",
                        default=False if defaults else nothing,
                        help="print findings only")
    common.add_argument("--json", action="store_true", dest="as_json",
                        default=False if defaults else nothing,
                        help="one JSON object instead of the prose report")
    common.add_argument("--config", default=None if defaults else nothing,
                        help="path to assay.json (default: found in --root)")
    common.add_argument("--root", default="." if defaults else nothing,
                        help="project root (default: .)")
    return common


def build_parser():
    ap = argparse.ArgumentParser(
        prog="assay",
        description=__doc__.split("\n\n")[0],
        parents=[_common(defaults=True)],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version="assay %s" % __version__)
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("runners", parents=[_common()],
                   help="audit mutation runners against six properties")
    sub.add_parser("anchors", parents=[_common()],
                   help="every mutation anchor matches exactly once")

    for name, helptext in (("diff", "does this change carry the checks it needs?"),
                           ("all", "runners + anchors + diff")):
        p = sub.add_parser(name, parents=[_common()], help=helptext)
        p.add_argument("--base", default="origin/main",
                       help="ref to diff against (default origin/main)")
        if name == "all":
            p.add_argument("--scan", nargs="+",
                           help="also run the sameness half over these paths")

    p = sub.add_parser("scan", parents=[_common()],
                       help="discover functions that answer the same question")
    p.add_argument("paths", nargs="+")

    p = sub.add_parser("pair", parents=[_common()],
                       help="compare two named functions")
    p.add_argument("a", metavar="FILE::NAME")
    p.add_argument("b", metavar="FILE::NAME")

    p = sub.add_parser("search", parents=[_common()],
                       help="does the tree already answer this?")
    p.add_argument("ref", metavar="FILE::NAME")
    p.add_argument("--in", dest="into", nargs="+", required=True)
    return ap


def main(argv=None, out=None):
    out = out or sys.stdout
    ap = build_parser()
    args = ap.parse_args(argv)
    if not args.cmd:
        if args.as_json:
            return _fail(args, out, "no subcommand")
        ap.print_help(out)
        return 2
    args.verbose = not args.quiet
    args.root = os.path.abspath(args.root)
    try:
        config = load(args.config, args.root)
    except ConfigError as exc:
        return _fail(args, out, str(exc))
    return COMMANDS[args.cmd](args, config, out)


if __name__ == "__main__":
    sys.exit(main())
