"""assay — one command for two questions ordinary CI does not answer.

    could those checks have failed?      assay runners | anchors | diff | all
    does the tree already answer this?   assay scan | pair | search
    ...does the OTHER language answer it?  assay search REF --against BUNDLE
    why was my function not probed?      assay why FILE::NAME | assay why --stdin
    ...and why did it not CROSS?         assay why FILE::NAME --cross
    ...and does the OTHER half answer it?  assay probe FILE::NAME | assay cross A B
    ...for a whole tree, not one pair?   assay bundle PATHS | assay sweep PATHS
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
import io
import json
import os
import shlex
import subprocess
import sys

from . import __version__
from .anchors import audit_anchors
from .checks import audit_diff, audit_runners, check_exemptions
from .config import (CONFIG_NAMES, ConfigError, apply_baseline, load,
                     write_baseline)
from .sameness import (BUNDLE_SCHEMA, PROBE_SCHEMA, UNSTATEABLE, admit, collect,
                       compare, compare_cross, cross_discriminating, cross_key,
                       cross_ladder, discriminating, discrimination_detail, group,
                       ladder, ladder_key, probe, report_census, report_scan, resolve,
                       resolve_source, resolve_why)
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


def _finish(args, report, config, out, performed=()):
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
    verbose = args.verbose and not args.as_json
    if config.baseline:
        still, stale, unchecked = apply_baseline(report.findings, config.baseline,
                                                 performed)
        accepted = len(report.findings) - len(still)
        report.items = [i for i in report.items if i.verdict != FINDING] + still
        for entry in stale:
            report.finding("baseline line no longer fires (fixed? then delete "
                           "it): %s" % entry.line)
        # THE CAVEAT TRAVELS AS DATA rather than as a sentence a human has to notice.
        # `unchecked` is the caveat: a line this run could not have seen fire, which is
        # a different claim from one it checked and found still firing. There is no
        # `complete` boolean any more because completeness stopped being a property of
        # the RUN — `performed` says what this run audited, and each entry names the
        # command that can answer it.
        report.baseline = {
            "path": config.path, "accepted": accepted, "new": len(still),
            "performed": sorted(performed),
            "stale": [e.line for e in stale],
            "unchecked": [{"line": e.line, "from": e.produced_by} for e in unchecked],
        }
        if verbose:
            out.write("\nBASELINE %s — %s\n"
                      % (config.path,
                         _baseline_summary(accepted, still, stale, unchecked)))
    if args.as_json:
        return render_json(report, out, meta=_meta(args))
    if verbose:
        out.write("\n%s\n" % ("-" * 72))
    return render(report, out, verbose=verbose)


def cmd_runners(args, config, out):
    report = Report()
    audit_runners(args.root, config, report)
    check_exemptions(args.root, config, report)
    return _finish(args, report, config, out, ("runners",))


def cmd_anchors(args, config, out):
    report = Report()
    audit_anchors(args.root, config, report)
    return _finish(args, report, config, out, ("anchors",))


def cmd_diff(args, config, out):
    report = Report()
    audit_diff(args.root, args.base, config, report)
    return _finish(args, report, config, out, ("diff",))


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
        # The census as DATA travels on the SHARED report, because that is the one a
        # renderer sees. A sub-report is only ever a way to attribute findings to the
        # audit that produced them.
        report.scan = scan.to_dict()

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
    return _finish(args, report, config, out, performed)


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
        return _fail(args, out,
                     "accept needs --reason. An acceptance without one cannot be told "
                     "from an oversight,\n       and the baseline is the table that "
                     "accumulates most and rots first.")
    report = Report()
    families, _performed = _audit_everything(args, config, report)
    known = set(config.baseline_lines)
    fired = {i.message for i in report.findings}

    if args.line is not None:
        if args.line in known:
            return _fail(args, out, "already in the baseline: %s" % args.line)
        if args.line in {i.message for i in report.looks}:
            return _fail(
                args, out,
                "that line is a `look`. A `look` never fails the run, so there is "
                "nothing\n       to accept: baselining one writes a record that can "
                "never match and\n       never expire.")
        if args.line not in fired:
            return _fail(
                args, out,
                "nothing in this run printed that line. Accepting it would write an "
                "entry\n       that is stale the moment it lands — paste a `finding` "
                "exactly as it was\n       printed.")
        chosen = [args.line]
    else:
        chosen = [i.message for i in report.findings if i.message not in known]

    # WHAT IT WROTE IS REPORTED AS `ok` ITEMS, and this deliberately does NOT go
    # through `_finish`. `_finish` applies the baseline, and the baseline it would
    # apply is the one loaded BEFORE these lines were written — so every entry already
    # in the file would be measured against a report that holds no findings at all and
    # come back stale. An audit reading its own writing is not an audit.
    written = Report()
    if not chosen:
        written.note("assay: nothing new to accept.")
    else:
        path = config.path or os.path.join(args.root, CONFIG_NAMES[0])
        write_baseline(path, [(line, args.reason, families.get(line))
                              for line in chosen])
        written.note("assay: wrote %d entr%s to %s"
                     % (len(chosen), "y" if len(chosen) == 1 else "ies", path))
        for line in chosen:
            written.ok("[%s] %s" % (families.get(line) or "no from", line))
    if args.as_json:
        return render_json(written, out, meta=_meta(args))
    render(written, out, verbose=args.verbose)
    return 0


def cmd_scan(args, config, out):
    scan = collect(args.paths)
    group(scan)
    report = report_scan(scan)
    report.scan = scan.to_dict()
    if not scan.groups:
        report.note("\nsame   none — no two probed functions share an outcome vector")
    return _finish(args, report, config, out, ("scan",))


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


def _undiscriminated(report, func, vector):
    """Report the `look` that says the ladder could not tell this function apart.

    True when it did, and nothing was decided. ONE PLACE FOR ONE ANSWER, because `why`
    and `search` are asking the same question of the same vector — and the defect this
    replaced was the two of them answering it differently. `search` deduced nothing and
    printed the clean `same none`; `why`, on the identical function, said the ladder
    could not see it. Two deciders that can disagree is the shape of defect this
    package exists to report, and a sentence kept in step by hand is how they get there.
    """
    detail = discrimination_detail(vector, ladder(len(func.params)))
    if detail is None:
        return False
    report.look("%s — not discriminated by the ladder" % func.ref, func.ref, detail)
    return True


def _query(args, out):
    """The function this command is asking about: (Func, None) or (None, exit code).

    Two ways in, and they are not interchangeable. A FILE::NAME names something that
    already exists; `--stdin` takes something that does not exist yet, which is the
    case `search` is named for — SEARCH BEFORE YOU GENERATE cannot mean "first write
    the file".

    `why` TAKES THE SAME TWO, because it is the same question asked one step earlier.
    A snippet is exactly where "why was my function not probed?" is worth asking, and
    answering it only for code already on disk would mean writing the file first in
    order to be told the file was never the problem.

    A FLAG THAT DOES NOT APPLY IS AN ERROR RATHER THAN A NO-OP. `--name` picks one
    definition out of a snippet, so with a FILE::NAME it has nothing to pick and
    accepting it quietly would leave a flag that is documented, parsed and inert.

    `resolve_why` RATHER THAN `resolve`, on both commands. "cannot resolve" collapses
    three answers — no such file, a file that does not parse, a file with no such
    function — into one sentence that sends you to none of the three.
    """
    if args.name is not None and not args.stdin:
        return None, _fail(
            args, out,
            "--name selects a function inside a --stdin snippet; a FILE::NAME "
            "already names one")
    if args.stdin:
        if args.ref:
            return None, _fail(args, out, "--stdin and a FILE::NAME are two "
                                          "different queries; give one")
        query, why = resolve_source(sys.stdin.read(), args.name)
        if query is None:
            return None, _fail(args, out, why)
        return query, None
    if not args.ref:
        return None, _fail(args, out,
                           "%s needs a FILE::NAME or --stdin" % args.cmd)
    query, unresolved = resolve_why(args.ref)
    if query is None:
        return None, _fail(args, out, unresolved)
    return query, None


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

    `--stdin` ASKS IT ABOUT A SNIPPET, the same way `search` does. `search --stdin` is
    the high-traffic path — you ask before you write — and this is the direct form of
    the question that path has to answer on the way.
    """
    func, code = _query(args, out)
    if func is None:
        return code
    report = Report()
    if args.cross:
        _why_cross(func, report)
        return _finish(args, report, config, out)
    vector, refused = probe(func)
    if vector is None:
        report.look("%s — %s" % (func.ref, refused), func.ref,
                    "refused before the ladder, so it is in no bucket and can pair "
                    "with nothing")
        return _finish(args, report, config, out)
    if _undiscriminated(report, func, vector):
        return _finish(args, report, config, out)
    answered, distinct = discriminating(vector, ladder(len(func.params)))
    report.ok("%s — probed on %s: %d of %d rungs answered, %d distinct value(s)"
              % (func.ref, ladder_key(func), answered, len(vector), distinct),
              func.ref)
    return _finish(args, report, config, out)


def _why_cross(func, report):
    """The same question about the SHARED ladder: why is this not in a bundle?

    `sweep` prints `41 functions, 9 probed, 32 not probed` and that is the right shape
    for a tree and the wrong shape for a question. Somebody who expected a PARTICULAR
    function to cross the boundary cannot read `not discriminated by the ladder 8` and
    learn whether theirs is one of the eight — and the cross ladder refuses for a
    reason the native one has no equivalent of, which is the whole reason this flag
    exists rather than a footnote on the native answer.

    A NATIVE `why` CANNOT ANSWER THIS, and answering it as though it could is the
    failure. The two ladders hold different values and refuse different functions: one
    that the native ladder discriminates can be a constant on the shared one, because
    the shared one is the intersection of what the two languages can express. Reporting
    the native verdict for a cross question would be confident and wrong.
    """
    arity = len(func.params)
    rungs = cross_ladder(arity)
    vector, refused = probe(func, mode="cross")
    if vector is None:
        report.look("%s — %s, on the SHARED ladder" % (func.ref, refused), func.ref,
                    "refused before the ladder, so it is in no bundle and can cross "
                    "with nothing")
        return
    # THE INTERLINGUA'S OWN REFUSAL, WHICH THE NATIVE LADDER HAS NO EQUIVALENT OF. An
    # outcome JSON cannot hold is not a value this can compare, and `compare_cross`
    # calls such a pair a `look` rather than pronouncing on it. Naming the rung matters
    # more here than anywhere else: it is a fact about ONE input, and a person can
    # usually see immediately which of their return paths it is.
    unstateable = [i for i, o in enumerate(vector) if o.startswith("X:")]
    if unstateable:
        first = unstateable[0]
        report.look("%s — %s" % (func.ref, UNSTATEABLE), func.ref,
                    "%d of %d rungs answered with one, the first at %s -> %s — the "
                    "interlingua is JSON, so bytes, a set, a Date or a class instance "
                    "cannot be said in it"
                    % (len(unstateable), len(vector),
                       json.dumps(rungs[first], ensure_ascii=False), vector[first]))
        return
    detail = discrimination_detail(vector, rungs, mode="cross")
    if detail is not None:
        report.look("%s — not discriminated by the SHARED ladder" % func.ref,
                    func.ref,
                    "%s; the shared ladder is the intersection of what the two "
                    "languages can express, so it discriminates less than the native "
                    "one" % detail)
        return
    answered, distinct = cross_discriminating(vector, rungs)
    report.ok("%s — probed on %s: %d of %d rungs answered, %d distinct value(s)"
              % (func.ref, cross_key(arity), answered, len(vector), distinct),
              func.ref)


# The suffix decides which half a reference belongs to. Inferred rather than declared,
# because a flag naming both a file and a language can disagree with itself and the
# suffix is the fact.
LANGUAGE_OF = {".py": "python", ".js": "javascript", ".mjs": "javascript",
               ".cjs": "javascript"}


def language_of(ref):
    """'python' | 'javascript' | None, from a FILE::NAME reference's suffix."""
    path = ref.rpartition("::")[0] or ref
    return LANGUAGE_OF.get(os.path.splitext(path)[1])


def cmd_probe(args, config, out):
    """One function's CROSS vector, as JSON on stdout. The thing `cross` compares.

    THE TWO HALVES DO NOT INVOKE EACH OTHER, and that is deliberate rather than lazy.
    `pip install assay-checks` gives you the Python half and `npm install` gives you
    the JavaScript one; neither can assume the other is on the machine, and a command
    that shells out to a binary that may not exist fails in a way that reads like the
    code being wrong. So one half writes a record and the other reads it:

        assay probe src/slug.js::slugify > slug.json      # the JavaScript binary
        assay cross src/format.py::humanize slug.json     # the Python one

    `assay cross --with CMD` will run that first step for you when both are installed.

    IT WRITES JSON ON STDOUT, so redirecting it is the point. A refusal is a record
    with `look` instead of `vector` rather than an error: the reference resolved and
    the tool ran, so this is not exit 2 — and a consumer gets one shape either way.
    """
    func, unresolved = resolve_why(args.ref)
    if func is None:
        # ONE SHAPE, ALWAYS, AND `--json` IS NOT WHAT DECIDES IT. This command's output
        # IS JSON — there is no prose form to switch away from — so a reference that
        # names nothing emits the same record with `error` where `vector` would be,
        # and exits 2. A consumer never has to ask which of two shapes it received,
        # and `2` still means the tool could not run.
        record = {"assay_probe": PROBE_SCHEMA, "ref": args.ref, "language": "python",
                  "error": unresolved}
        json.dump(record, out, indent=2, sort_keys=True, ensure_ascii=False)
        out.write("\n")
        return 2
    arity = len(func.params)
    record = {"assay_probe": PROBE_SCHEMA, "ref": func.ref, "language": "python",
              "arity": arity, "error": None}
    vector, refused = probe(func, mode="cross")
    if vector is None:
        record["look"] = refused
    else:
        record["ladder"] = cross_key(arity)
        record["vector"] = vector
    json.dump(record, out, indent=2, sort_keys=True, ensure_ascii=False)
    out.write("\n")
    return 0


def _read_record(path):
    """An `assay probe` record from a file, or (None, why).

    THE SCHEMA IS CHECKED. A record from a version that meant something else by
    `vector` would be compared anyway, and comparing a new answer against the wrong
    earlier answer is precisely the defect a difference checker exists to catch.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError) as exc:
        return None, "cannot read %s as an `assay probe` record (%s)" % (path, exc)
    if not isinstance(record, dict) or "assay_probe" not in record:
        return None, "%s is not an `assay probe` record" % path
    if record["assay_probe"] != PROBE_SCHEMA:
        return None, ("%s was written by schema %r and this is schema %d — the two do "
                      "not mean the same thing by `vector`"
                      % (path, record["assay_probe"], PROBE_SCHEMA))
    return record, None


def _cross_side(ref, with_cmd):
    """One side of a cross comparison: (record, None) or (None, why).

    THREE WAYS IN, and the third exists because the first two are not always enough.
    A `.json` path is a record somebody already produced. A `.py` reference is probed
    here. A reference in the OTHER language needs the other binary, and `--with CMD`
    is how you say where it is — without it this refuses and says exactly what to run,
    rather than guessing at a command name that is `assay` for both packages.
    """
    if ref.endswith(".json") and os.path.exists(ref):
        return _read_record(ref)
    language = language_of(ref)
    if language == "python":
        # PROBED THROUGH THE COMMAND, not around it. `cmd_probe` is what decides what a
        # record is, and a second path to the same record is a second answer to one
        # question. It emits one shape on both paths, so the failure is read out of the
        # record rather than out of prose that would have to be parsed back.
        buf = io.StringIO()
        code = cmd_probe(argparse.Namespace(ref=ref, as_json=False), None, buf)
        record = json.loads(buf.getvalue())
        if code != 0:
            return None, record.get("error") or "cannot probe %s" % ref
        return record, None
    if language is None:
        return None, ("%s names no language this understands — a reference is "
                      "FILE::NAME and the suffix says which half" % ref)
    if not with_cmd:
        return None, ("%s is a JavaScript reference and this is the Python half.\n"
                      "       Run `assay probe %s > side.json` with the JavaScript "
                      "binary and pass\n       side.json here, or give --with CMD so "
                      "this can run it for you." % (ref, ref))
    command = shlex.split(with_cmd) + ["probe", ref]
    try:
        proc = subprocess.run(command, capture_output=True, text=True,
                              timeout=CROSS_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, "--with %r could not run (%s)" % (with_cmd, exc)
    if proc.returncode != 0:
        tail = (proc.stderr.strip().splitlines()
                or proc.stdout.strip().splitlines() or ["silent"])[-1][:90]
        return None, "--with %r exited %d (%s)" % (with_cmd, proc.returncode, tail)
    try:
        record = json.loads(proc.stdout)
    except ValueError:
        return None, ("--with %r did not print an `assay probe` record" % with_cmd)
    if record.get("assay_probe") != PROBE_SCHEMA:
        return None, ("--with %r wrote schema %r and this is schema %d"
                      % (with_cmd, record.get("assay_probe"), PROBE_SCHEMA))
    return record, None


def cmd_cross(args, config, out):
    """Does a Python function answer the same question as a JavaScript one?

    A validator reimplemented in a Django backend and a Node frontend is the highest-
    value duplication a polyglot repository has, and it is exactly what nobody writes a
    differential test for — because writing one means agreeing, by hand, on what
    `False` and `false` have in common. That agreement is `cross_render`, and the
    ladder both sides walk is one JSON document rather than two lists somebody keeps in
    step.

    THE VERDICTS MEAN WHAT THEY MEAN EVERYWHERE ELSE HERE. `differs` is proof and is
    an `ok`. `same` is the absence of proof and is a FINDING, because two
    implementations that no input told apart is something a person has to read. `look`
    is anything this cannot settle — a refused probe, a ladder mismatch, or an outcome
    the interlingua cannot state.
    """
    report = Report()
    sides = []
    for ref in (args.a, args.b):
        record, why = _cross_side(ref, args.with_cmd)
        if record is None:
            return _fail(args, out, why)
        sides.append(record)
    first, second = sides
    pair = "%s [%s]  vs  %s [%s]" % (first["ref"], first["language"],
                                     second["ref"], second["language"])
    for side in sides:
        if "look" in side:
            report.look("%s — %s could not be probed: %s"
                        % (pair, side["ref"], side["look"]), first["ref"])
            return _finish(args, report, config, out)
    if first["language"] == second["language"]:
        report.look("%s — both sides are %s; `pair` compares two functions of one "
                    "language on its own ladder, which is stronger"
                    % (pair, first["language"]), first["ref"])
        return _finish(args, report, config, out)
    rungs = cross_ladder(first["arity"])
    verdict, detail = compare_cross(first["vector"], second["vector"],
                                    first["ladder"], second["ladder"], rungs)
    if verdict == "same":
        report.finding("same answer across languages (%s): %s"
                       % (first["ladder"], pair), first["ref"],
                       "no input in the shared ladder told them apart — READ them; "
                       "only a person decides whether the duplication is a defect")
    elif verdict == "differs":
        report.ok("differs: %s — %s" % (pair, detail), first["ref"])
    else:
        report.look("%s — %s" % (pair, detail), first["ref"])
    return _finish(args, report, config, out)


def _search_native(args, query, report):
    """The one-language half of `search`: this tree, on this language's own ladder."""
    vector, why = probe(query)
    if vector is None:
        report.look("%s — %s" % (query.ref, why), query.ref)
        report.note("       the tree was not searched, because this function could "
                    "not be probed")
        return
    if _undiscriminated(report, query, vector):
        report.note("       the tree was not searched: the census excludes every "
                    "function this ladder cannot tell apart, so a match was never "
                    "possible")
        return
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


def _search_cross(query, document, report):
    """The other-language half: one function against a bundle the far binary wrote.

    THE SAME THREE REFUSALS, STATED IN THE SAME WORDS, because this is `sweep`'s
    question asked about one function instead of a tree — and `admit` is what both of
    them ask. A query the shared ladder cannot tell apart from a constant can only
    fail to match the other constants, and printing the clean `none` there would say
    "we found none" where the truth is "we never looked". That difference costs the
    most on exactly this path: the person reading it is about to write the function.
    """
    language = document.get("language") or "unknown"
    vector, why = probe(query, mode="cross")
    if vector is None:
        report.look("%s — %s" % (query.ref, why), query.ref)
        report.note("       the %s tree was not searched, because this function "
                    "could not be probed on the shared ladder" % language)
        return
    key, refused = admit(vector, len(query.params), "cross")
    if key is None:
        report.look("%s — %s, on the SHARED ladder" % (query.ref, refused), query.ref,
                    "the shared ladder is the intersection of what the two languages "
                    "can express, so it discriminates less than either native one")
        report.note("       the %s tree was not searched: a match was never possible"
                    % language)
        return
    hits = sorted(record["ref"] for record in document.get("records") or []
                  if record.get("ladder") == key and record.get("vector") == vector)
    if hits:
        report.finding("the %s tree already answers %s: %s"
                       % (language, query.ref, ", ".join(hits)), query.ref,
                       "no input in the shared ladder told them apart — READ them "
                       "before writing a second one")
    else:
        report.note("\nsame   none across languages — nothing in the %s bundle matched "
                    "%s's outcome vector" % (language, query.ref))
    if document.get("census"):
        report_census(document["census"], report, label="[%s]" % language)
    report.other = {"language": language,
                    "records": len(document.get("records") or []),
                    "census": document.get("census")}


def cmd_search(args, config, out):
    """Does the tree already answer this? — and never `none` when nobody looked.

    THERE ARE TWO WAYS NOT TO SEARCH and only one of them used to be reported. A query
    refused before the ladder is obvious: no vector, nothing to match, and the command
    says so. A query the ladder cannot DISCRIMINATE is the quiet one — it has a vector,
    the matching runs, and it matches nothing, because `collect` files every function
    the ladder cannot tell apart under skipped and a constant can therefore only fail
    to find the other constants. The tool then printed `same none`, which is the clean
    result, for a search that was never capable of a hit.

    So the same check `assay why` applies is applied here, from the same function, and
    a non-discriminating query is a `look`. "We found none" and "we never looked" are
    different claims, and this is the path where the difference costs the most: the
    person reading it is about to write the function.
    """
    if not args.into and not args.against:
        return _fail(args, out, "search needs --in DIR or --against BUNDLE")
    query, code = _query(args, out)
    if query is None:
        return code
    # THE FAR SIDE IS RESOLVED BEFORE ANYTHING IS PROBED. A bundle this half cannot
    # read is exit 2, and finding that out AFTER a tree of subprocesses have run wastes
    # the run and buries the reason under a census the caller was never going to use.
    document = None
    if args.against:
        document, why = _other_side(args.against, args.with_cmd)
        if document is None:
            return _fail(args, out, why)
        if document.get("language") == "python":
            return _fail(args, out,
                         "--against is a python bundle and this is the python half — "
                         "`--in` searches one language's tree on its own ladder, "
                         "which is stronger")
    report = Report()
    if args.into:
        _search_native(args, query, report)
    if document is not None:
        _search_cross(query, document, report)
    return _finish(args, report, config, out)


def _bundle_document(paths):
    """Every function under `paths` as CROSS records, plus the census. One dict.

    THE RECORDS ARE THE SAME SHAPE `assay probe` WRITES, and that is the point of the
    envelope rather than a nicety: a bundle entry lifted out on its own is a record
    `assay cross` already reads, so the two commands cannot come to mean different
    things by `vector` without one of them failing its own schema check.

    A REFUSED FUNCTION IS IN THE CENSUS AND NOT IN `records`. Both facts are carried,
    because a bundle whose `records` list is short and whose census is missing says
    "nothing here answers that" for a tree it never managed to probe — which is the
    one claim this tool exists to refuse to make.
    """
    scan = collect(paths, mode="cross")
    records = []
    for ref in sorted(scan.probed):
        records.append({"assay_probe": PROBE_SCHEMA, "ref": ref, "language": "python",
                        "arity": scan.arity[ref], "ladder": scan.keys[ref],
                        "vector": scan.probed[ref], "error": None})
    return {"assay_bundle": BUNDLE_SCHEMA, "assay_probe": PROBE_SCHEMA,
            "language": "python", "records": records, "census": scan.to_dict(),
            "error": None}


def cmd_bundle(args, config, out):
    """A whole tree's cross vectors, as one JSON document on stdout.

    `assay cross` answers about two functions somebody already suspected. Nobody
    suspects the pair that matters: a validator written once in the API and again in
    the front end, by two people, a year apart, is exactly the duplication no one goes
    looking for. Finding it means probing both trees, and the halves do not invoke each
    other — so one writes a bundle and the other reads it:

        assay bundle js/src > js.json          # the JavaScript binary
        assay sweep python/ --against js.json  # the Python one

    IT WRITES JSON ON STDOUT, so redirecting it is the point, and it emits ONE SHAPE on
    every path — a broken invocation is the same document with `error` set and exit 2.
    A consumer never has to ask which of two shapes it received.
    """
    if not args.paths:
        document = {"assay_bundle": BUNDLE_SCHEMA, "assay_probe": PROBE_SCHEMA,
                    "language": "python", "records": [], "census": None,
                    "error": "bundle needs a path"}
        code = 2
    else:
        document, code = _bundle_document(args.paths), 0
    json.dump(document, out, indent=2, sort_keys=True, ensure_ascii=False)
    out.write("\n")
    return code


def _read_bundle(path):
    """An `assay bundle` document from a file, or (None, why).

    THE SCHEMA IS CHECKED, for the reason a record's is: a bundle from a version that
    meant something else by `vector` would be compared anyway, and comparing a new
    answer against the wrong earlier answer is precisely the defect a difference
    checker exists to catch.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            document = json.load(fh)
    except (OSError, ValueError) as exc:
        return None, "cannot read %s as an `assay bundle` document (%s)" % (path, exc)
    if not isinstance(document, dict) or "assay_bundle" not in document:
        return None, "%s is not an `assay bundle` document" % path
    if document["assay_bundle"] != BUNDLE_SCHEMA:
        return None, ("%s was written by bundle schema %r and this is schema %d — the "
                      "two do not mean the same thing by `records`"
                      % (path, document["assay_bundle"], BUNDLE_SCHEMA))
    if document.get("assay_probe") != PROBE_SCHEMA:
        return None, ("%s carries records of schema %r and this is schema %d — the two "
                      "do not mean the same thing by `vector`"
                      % (path, document.get("assay_probe"), PROBE_SCHEMA))
    if document.get("error"):
        return None, "%s is a bundle that could not be built: %s" % (path,
                                                                    document["error"])
    return document, None


def _other_side(against, with_cmd):
    """The other half's bundle: (document, None) or (None, why).

    TWO WAYS IN, and they are the two `cross` already has minus the one that cannot
    apply. A `.json` path is a bundle somebody produced. Anything else is a list of
    paths in the OTHER language, which needs the other binary — and `--with CMD` is
    how you say where it is, rather than guessing at a command name that is `assay`
    for both packages.
    """
    if len(against) == 1 and against[0].endswith(".json") and os.path.exists(against[0]):
        return _read_bundle(against[0])
    if not with_cmd:
        return None, ("--against %s does not name a bundle this half can read.\n"
                      "       Run `assay bundle %s > other.json` with the OTHER "
                      "half's binary and pass\n       other.json here, or give --with "
                      "CMD so this can run it for you."
                      % (" ".join(against), " ".join(against)))
    command = shlex.split(with_cmd) + ["bundle"] + list(against)
    try:
        proc = subprocess.run(command, capture_output=True, text=True,
                              timeout=BUNDLE_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, "--with %r could not run (%s)" % (with_cmd, exc)
    try:
        document = json.loads(proc.stdout)
    except ValueError:
        tail = (proc.stderr.strip().splitlines()
                or proc.stdout.strip().splitlines() or ["silent"])[-1][:90]
        return None, ("--with %r did not print an `assay bundle` document (%s)"
                      % (with_cmd, tail))
    if document.get("assay_bundle") != BUNDLE_SCHEMA:
        return None, ("--with %r wrote bundle schema %r and this is schema %d"
                      % (with_cmd, document.get("assay_bundle"), BUNDLE_SCHEMA))
    # BOTH SCHEMAS, on this path as on the file one. The envelope and the record are
    # versioned apart, so a far binary whose bundle schema happens to match can still
    # mean something else by `vector` — and that is the comparison the check exists to
    # refuse, not the one it exists to allow.
    if document.get("assay_probe") != PROBE_SCHEMA:
        return None, ("--with %r wrote records of schema %r and this is schema %d"
                      % (with_cmd, document.get("assay_probe"), PROBE_SCHEMA))
    if document.get("error"):
        return None, "--with %r could not build a bundle: %s" % (with_cmd,
                                                                 document["error"])
    return document, None


def _cross_buckets(scan, document):
    """(ladder key, vector) -> (my refs, their refs). Sorted, and only shared buckets.

    THE BUCKET IS THE COMPARISON, and it is a legitimate one only because `collect`
    already refused everything `compare_cross` would have refused: a vector holding an
    outcome the interlingua cannot state, and a vector the ladder never told apart from
    a constant. What survives to a bucket is a pair that command would have called
    `same`. If that stops being true, this prints findings the pairwise command
    disagrees with, and the weaker answer is the one on screen.
    """
    buckets = {}
    for ref, vector in scan.probed.items():
        buckets.setdefault((scan.keys[ref], tuple(vector)), ([], []))[0].append(ref)
    for record in document.get("records") or []:
        key = (record.get("ladder"), tuple(record.get("vector") or []))
        if key in buckets:
            buckets[key][1].append(record.get("ref"))
    return sorted(((key, sorted(mine), sorted(theirs))
                   for key, (mine, theirs) in buckets.items() if theirs),
                  key=lambda item: (item[1][0], item[2][0]))


def cmd_sweep(args, config, out):
    """Which functions in THIS tree does the other language already answer?

    `cross` needs the pair named. This needs neither name, which is what makes it the
    command that finds the duplication a polyglot repository actually accumulates: two
    implementations of one rule, one per language, that no differential test covers
    because writing one means agreeing by hand on what `False` and `false` have in
    common.

    BOTH CENSUSES ARE PRINTED, and the other half's is the one that would otherwise
    lie by omission. A function the OTHER binary refused was never compared, and a
    report that says `same none` while staying quiet about the two hundred functions
    the far side never probed is reporting "we never looked" as "we found none" —
    across a boundary where the reader has no way to check.
    """
    if not args.paths:
        return _fail(args, out, "sweep needs a path")
    document, why = _other_side(args.against, args.with_cmd)
    if document is None:
        return _fail(args, out, why)
    if document.get("language") == "python":
        return _fail(args, out,
                     "--against is a python bundle and this is the python half — "
                     "`scan` compares one language's functions on its own ladder, "
                     "which is stronger")
    report = Report()
    scan = collect(args.paths, mode="cross")
    theirs = document.get("language") or "unknown"
    shared = _cross_buckets(scan, document)
    for key, mine, them in shared:
        report.finding(
            "same answer across languages (%s): %s [python]  vs  %s [%s]"
            % (key[0], ", ".join(mine), ", ".join(them), theirs), mine[0],
            "no input in the shared ladder told them apart — READ them; only a "
            "person decides whether the duplication is a defect")
    if not shared:
        report.note("\nsame   none — no function here shares an outcome vector with "
                    "one in the %s bundle" % theirs)
    report_scan(scan, report)
    if document.get("census"):
        report_census(document["census"], report, label="[%s]" % theirs)
    report.scan = scan.to_dict()
    report.other = {"language": theirs, "records": len(document.get("records") or []),
                    "census": document.get("census")}
    return _finish(args, report, config, out)



CROSS_TIMEOUT = 120     # seconds for the OTHER half's `probe`, run through --with
BUNDLE_TIMEOUT = 900    # seconds for the OTHER half's `bundle`: a whole tree, not one

COMMANDS = {
    "why": cmd_why,
    "probe": cmd_probe,
    "cross": cmd_cross,
    "accept": cmd_accept,
    "runners": cmd_runners,
    "anchors": cmd_anchors,
    "diff": cmd_diff,
    "all": cmd_all,
    "scan": cmd_scan,
    "pair": cmd_pair,
    "search": cmd_search,
    "bundle": cmd_bundle,
    "sweep": cmd_sweep,
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
    p.add_argument("ref", metavar="FILE::NAME", nargs="?")
    p.add_argument("--stdin", action="store_true",
                   help="read the function from stdin, before it is a file")
    p.add_argument("--name", default=None,
                   help="which function in a --stdin snippet to ask about")
    p.add_argument("--cross", action="store_true",
                   help="ask about the SHARED ladder — why is this not in a bundle?")

    p = sub.add_parser("probe", parents=[_common()],
                       help="one function's cross-language vector, as JSON on stdout")
    p.add_argument("ref", metavar="FILE::NAME")

    p = sub.add_parser("cross", parents=[_common()],
                       help="compare a Python function to a JavaScript one")
    p.add_argument("a", metavar="FILE::NAME|RECORD.json")
    p.add_argument("b", metavar="FILE::NAME|RECORD.json")
    p.add_argument("--with", dest="with_cmd", default=None, metavar="CMD",
                   help="run CMD `probe REF` for the side this half cannot probe")

    p = sub.add_parser("bundle", parents=[_common()],
                       help="a whole tree's cross vectors, as JSON on stdout")
    p.add_argument("paths", nargs="*")

    p = sub.add_parser("sweep", parents=[_common()],
                       help="which functions here does the OTHER language answer?")
    p.add_argument("paths", nargs="*")
    p.add_argument("--against", nargs="+", required=True,
                   metavar="BUNDLE.json|PATH",
                   help="the other half's bundle, or its paths with --with CMD")
    p.add_argument("--with", dest="with_cmd", default=None, metavar="CMD",
                   help="run CMD `bundle PATHS` for the half this one cannot probe")

    p = sub.add_parser("search", parents=[_common()],
                       help="does the tree already answer this?")
    p.add_argument("ref", metavar="FILE::NAME", nargs="?")
    # NEITHER IS REQUIRED AND ONE OF THEM IS. `--in` alone is the original command;
    # `--against` alone asks only the other language; both ask both. Making `--in`
    # required would have meant naming a tree you did not want searched in order to
    # ask about the one you did.
    p.add_argument("--in", dest="into", nargs="+", default=[])
    p.add_argument("--against", nargs="+", default=[],
                   metavar="BUNDLE.json|PATH",
                   help="the other half's bundle, or its paths with --with CMD")
    p.add_argument("--with", dest="with_cmd", default=None, metavar="CMD",
                   help="run CMD `bundle PATHS` for the half this one cannot probe")
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
