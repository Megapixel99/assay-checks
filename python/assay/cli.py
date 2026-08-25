"""assay — one command for two questions ordinary CI does not answer.

    could those checks have failed?      assay runners | anchors | diff | all
    does the tree already answer this?   assay scan | pair | search
    why was my function not probed?      assay why FILE::NAME
    I have read this one and accept it   assay accept --reason "..." [LINE]

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
from .config import (CONFIG_NAMES, ConfigError, apply_baseline, load,
                     write_baseline)
from .sameness import (collect, compare, discriminating, discrimination_detail,
                       group, ladder, ladder_key, probe, report_scan, resolve,
                       resolve_source, resolve_why)
from .verdicts import FINDING, Report, render


def _baseline_summary(accepted, still, stale, unchecked):
    """The counts, and never a number that reads as a claim nobody checked.

    `0 stale` from a run that could not have seen those lines fire reads as "nothing
    is stale", which is a different claim from "this run never looked". So the entries
    nobody could check are counted apart from the ones that were, and the reason each
    was skipped is named — the same rule the census follows for functions it refused.
    """
    parts = ["%d accepted" % accepted, "%d new" % len(still), "%d stale" % len(stale)]
    if unchecked:
        why = {}
        for entry in unchecked:
            key = entry.produced_by or "no `from`, so it needs `assay all`"
            why[key] = why.get(key, 0) + 1
        parts.append("%d NOT checked for staleness (%s)"
                     % (len(unchecked),
                        "; ".join("%s: %d" % kv for kv in sorted(why.items()))))
    return ", ".join(parts)


def _finish(report, config, out, verbose=True, performed=()):
    """Apply the baseline, render, and return the exit code.

    STALENESS IS PER LINE, and getting it wrong in either direction is a defect this
    tool shipped. `assay runners` cannot produce a finding that only `diff` reports, so
    checking staleness there once flagged every `diff` line as fixed — the audit
    reporting a problem with its own config, on a clean tree, every run. The first fix
    was to check staleness only from `assay all`: correct, and blunt enough that every
    line in every other run went unchecked and the run printed a disclaimer where a
    number belongs.

    `performed` is what this run actually audited, so a baseline entry that names the
    command firing it can be answered by that command alone. Everything else is counted
    as NOT CHECKED rather than silently treated as fresh.

    Suppression is unconditional, because that direction is safe from any run: a line
    that fires is a line that fires.
    """
    if config.baseline:
        still, stale, unchecked = apply_baseline(report.findings, config.baseline,
                                                 performed)
        accepted = len(report.findings) - len(still)
        report.items = [i for i in report.items if i.verdict != FINDING] + still
        for entry in stale:
            report.finding("baseline line no longer fires (fixed? then delete "
                           "it): %s" % entry.line)
        if verbose:
            out.write("\nBASELINE %s — %s\n"
                      % (config.path,
                         _baseline_summary(accepted, still, stale, unchecked)))
    if verbose:
        out.write("\n%s\n" % ("-" * 72))
    return render(report, out, verbose=verbose)


def cmd_runners(args, config, out):
    report = Report()
    audit_runners(args.root, config, report)
    check_exemptions(args.root, config, report)
    return _finish(report, config, out, args.verbose, ("runners",))


def cmd_anchors(args, config, out):
    report = Report()
    audit_anchors(args.root, config, report)
    return _finish(report, config, out, args.verbose, ("anchors",))


def cmd_diff(args, config, out):
    report = Report()
    audit_diff(args.root, args.base, config, report)
    return _finish(report, config, out, args.verbose, ("diff",))


def _audit_everything(args, config, report):
    """Every audit, folded into `report`. Returns ({message: family}, performed).

    ONE PLACE KNOWS WHAT A COMPLETE RUN IS, and `assay accept` is why it has to be
    one. `all` needs the list to say whether it may call a line stale; `accept` needs
    it to write `from` on the entries it adds. Two lists that had to agree about what
    "every audit" means would be the exact duplication this package exists to find,
    and the way they would disagree is silent: `accept` would tag a line with a
    command `all` no longer performs, and that line could then never be called stale.

    `--scan PATH` folds the sameness half in. WITHOUT IT THE RUN DID NOT PERFORM THAT
    HALF, and saying otherwise is how a `same answer` line gets called stale on a
    clean tree — so `scan` joins the performed set only when a scan actually ran.
    """
    families, performed = {}, []

    def perform(name, audit):
        # A SEPARATE REPORT PER AUDIT, so a finding can be attributed to the audit that
        # produced it. Reading it back off the shared report afterwards would mean
        # guessing from the message text, which is a parser of our own output.
        sub = Report()
        audit(sub)
        for item in sub.findings:
            # FIRST WINS, and nothing here can currently produce the same message from
            # two audits — so there is deliberately no mutation for this line. A
            # mutation nothing can catch is a table entry claiming a guard is covered
            # when nothing breaks it on purpose, which is the defect this runner
            # exists to report.
            families.setdefault(item.message, name)
        report.extend(sub)
        performed.append(name)

    def runners(rep):
        audit_runners(args.root, config, rep)
        check_exemptions(args.root, config, rep)

    def scan_half(rep):
        scan = collect(args.scan)
        group(scan)
        report_scan(scan, rep)

    perform("runners", runners)
    perform("anchors", lambda rep: audit_anchors(args.root, config, rep))
    perform("diff", lambda rep: audit_diff(args.root, args.base, config, rep))
    if getattr(args, "scan", None):
        perform("scan", scan_half)
    return families, performed


def cmd_all(args, config, out):
    """Every audit in one run — and, with `--scan`, the complete one."""
    report = Report()
    _families, performed = _audit_everything(args, config, report)
    return _finish(report, config, out, args.verbose, performed)


def cmd_accept(args, config, out):
    """Write a finding into the baseline, and refuse to write anything else.

    THE 0.2.2 CHANGELOG RECORDS SHIPPING A CONFIG EXAMPLE THAT BASELINED A `look`.
    A `look` never fails the run, so a line holding one can never be suppressed and
    can never expire: it is a record of nothing, indistinguishable from a record of
    something already fixed. That was fixed by editing the example — and an example is
    fixed once per copy of it, while a command that cannot make the mistake is fixed
    once. This refuses.

    IT ACCEPTS ONLY WHAT IT JUST SAW FIRE, for the same reason. A line that does not
    fire is stale the moment it is written, so the file would arrive already claiming
    something untrue. Nothing here is typed by hand either: the entry is the finding's
    exact text, taken from the run, which is what makes whole-line matching safe.

    A partial run is fine here and that is not a loophole. Accepting is the direction
    that is safe from any command — a line that fires is a line that fires — and the
    `from` written beside it is the audit that produced it, so the check that fires it
    is the one that can later call it stale.
    """
    if not args.reason:
        out.write("assay: accept needs --reason. An acceptance without one cannot be "
                  "told from an oversight,\n       and the baseline is the table that "
                  "accumulates most and rots first.\n")
        return 2
    report = Report()
    families, _performed = _audit_everything(args, config, report)
    known = set(config.baseline_lines)
    fired = {i.message for i in report.findings}

    if args.line is not None:
        if args.line in known:
            out.write("assay: already in the baseline: %s\n" % args.line)
            return 2
        if args.line in {i.message for i in report.looks}:
            out.write(
                "assay: that line is a `look`. A `look` never fails the run, so there "
                "is nothing\n       to accept: baselining one writes a record that can "
                "never match and\n       never expire.\n")
            return 2
        if args.line not in fired:
            out.write(
                "assay: nothing in this run printed that line. Accepting it would "
                "write an entry\n       that is stale the moment it lands — paste a "
                "`finding` exactly as it was\n       printed.\n")
            return 2
        chosen = [args.line]
    else:
        chosen = [i.message for i in report.findings if i.message not in known]

    if not chosen:
        out.write("assay: nothing new to accept.\n")
        return 0
    path = config.path or os.path.join(args.root, CONFIG_NAMES[0])
    write_baseline(path, [(line, args.reason, families.get(line))
                          for line in chosen])
    out.write("assay: wrote %d entr%s to %s\n"
              % (len(chosen), "y" if len(chosen) == 1 else "ies", path))
    for line in chosen:
        out.write("  + [%s] %s\n" % (families.get(line) or "no from", line))
    return 0


def cmd_scan(args, config, out):
    scan = collect(args.paths)
    group(scan)
    report = report_scan(scan)
    if not scan.groups:
        report.note("\nsame   none — no two probed functions share an outcome vector")
    return _finish(report, config, out, args.verbose, ("scan",))


def cmd_pair(args, config, out):
    report = Report()
    funcs = []
    for ref in (args.a, args.b):
        func = resolve(ref)
        if func is None:
            out.write("assay: cannot resolve %s\n" % ref)
            return 2
        funcs.append(func)
    first, second = funcs
    vectors = []
    for func in funcs:
        vector, why = probe(func)
        if vector is None:
            report.look("%s — %s" % (func.ref, why), func.ref)
            return _finish(report, config, out, args.verbose)
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
    return _finish(report, config, out, args.verbose)


def cmd_why(args, config, out):
    """The census, for one name: which gate refused THIS function.

    `assay scan` prints refusal reasons with counts, which is the right shape for a
    tree and the wrong shape for a question. Somebody who expected a particular
    function to be probed cannot read `no arguments 274` and learn whether theirs is
    one of the 274, and guessing which of eight gates rejected it is exactly the work
    the census was supposed to save them.

    IT NEVER PRODUCES A FINDING. This command decides nothing about the code; it
    reports what the tool did and why it did it. A refusal is a `look` and a probe is
    an `ok` — and an `ok` here is printed rather than left silent for the same reason
    every other one is, because "it was probed" and "nothing looked at it" are
    different claims and only one of them is evidence.
    """
    func, unresolved = resolve_why(args.ref)
    if func is None:
        out.write("assay: %s\n" % unresolved)
        return 2
    report = Report()
    vector, refused = probe(func)
    if vector is None:
        report.look("%s — %s" % (func.ref, refused), func.ref,
                    "refused before the ladder, so it is in no bucket and can pair "
                    "with nothing")
        return _finish(report, config, out, args.verbose)
    inputs = ladder(len(func.params))
    detail = discrimination_detail(vector, inputs)
    if detail is not None:
        report.look("%s — not discriminated by the ladder" % func.ref, func.ref, detail)
        return _finish(report, config, out, args.verbose)
    answered, distinct = discriminating(vector, inputs)
    report.ok("%s — probed on %s: %d of %d rungs answered, %d distinct value(s)"
              % (func.ref, ladder_key(func), answered, len(vector), distinct),
              func.ref)
    return _finish(report, config, out, args.verbose)


def _query(args, out):
    """The function `search` is asking about: (Func, None) or (None, exit code).

    Two ways in, and they are not interchangeable. A FILE::NAME names something that
    already exists; `--stdin` takes something that does not exist yet, which is the
    case the command is named for — SEARCH BEFORE YOU GENERATE cannot mean "first
    write the file".

    A FLAG THAT DOES NOT APPLY IS AN ERROR RATHER THAN A NO-OP. `--name` picks one
    definition out of a snippet, so with a FILE::NAME it has nothing to pick and
    accepting it quietly would leave a flag that is documented, parsed and inert.
    """
    if args.name is not None and not args.stdin:
        out.write("assay: --name selects a function inside a --stdin snippet; a "
                  "FILE::NAME already names one\n")
        return None, 2
    if args.stdin:
        if args.ref:
            out.write("assay: --stdin and a FILE::NAME are two different queries; "
                      "give one\n")
            return None, 2
        query, why = resolve_source(sys.stdin.read(), args.name)
        if query is None:
            out.write("assay: %s\n" % why)
            return None, 2
        return query, None
    if not args.ref:
        out.write("assay: search needs a FILE::NAME or --stdin\n")
        return None, 2
    query = resolve(args.ref)
    if query is None:
        out.write("assay: cannot resolve %s\n" % args.ref)
        return None, 2
    return query, None


def cmd_search(args, config, out):
    query, code = _query(args, out)
    if query is None:
        return code
    report = Report()
    vector, why = probe(query)
    if vector is None:
        report.look("%s — %s" % (query.ref, why), query.ref)
        report.note("       the tree was not searched, because this function could "
                    "not be probed")
        return _finish(report, config, out, args.verbose)
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
    return _finish(report, config, out, args.verbose)


COMMANDS = {
    "why": cmd_why,
    "accept": cmd_accept,
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
                   help="audit mutation runners against seven properties")
    sub.add_parser("anchors", parents=[_common()],
                   help="every mutation anchor matches exactly once")

    for name, helptext in (
            ("diff", "does this change carry the checks it needs?"),
            ("all", "runners + anchors + diff"),
            ("accept", "write a finding into the baseline, with a reason")):
        p = sub.add_parser(name, parents=[_common()], help=helptext)
        p.add_argument("--base", default="origin/main",
                       help="ref to diff against (default origin/main)")
        if name in ("all", "accept"):
            p.add_argument("--scan", nargs="+",
                           help="also run the sameness half over these paths")
        if name == "accept":
            p.add_argument("line", nargs="?", metavar="LINE",
                           help="one finding's exact text (default: every new one)")
            p.add_argument("--reason", default=None,
                           help="why you accepted it — required, and not decorative")

    p = sub.add_parser("scan", parents=[_common()],
                       help="discover functions that answer the same question")
    p.add_argument("paths", nargs="+")

    p = sub.add_parser("pair", parents=[_common()],
                       help="compare two named functions")
    p.add_argument("a", metavar="FILE::NAME")
    p.add_argument("b", metavar="FILE::NAME")

    p = sub.add_parser("why", parents=[_common()],
                       help="which gate refused this function, or that it was probed")
    p.add_argument("ref", metavar="FILE::NAME")

    p = sub.add_parser("search", parents=[_common()],
                       help="does the tree already answer this?")
    p.add_argument("ref", metavar="FILE::NAME", nargs="?")
    p.add_argument("--in", dest="into", nargs="+", required=True)
    p.add_argument("--stdin", action="store_true",
                   help="read the function from stdin, before it is a file")
    p.add_argument("--name", default=None,
                   help="which function in a --stdin snippet to ask about")
    return ap


def main(argv=None, out=None):
    out = out or sys.stdout
    ap = build_parser()
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help(out)
        return 2
    args.verbose = not args.quiet
    args.root = os.path.abspath(args.root)
    try:
        config = load(args.config, args.root)
    except ConfigError as exc:
        out.write("assay: %s\n" % exc)
        return 2
    return COMMANDS[args.cmd](args, config, out)


if __name__ == "__main__":
    sys.exit(main())
