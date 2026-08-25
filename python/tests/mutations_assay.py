#!/usr/bin/env python3
"""Mutation runner for assay — do its own suites notice when a guard breaks?

BOTH HALVES, and for a long time only one. This runner could mutate Python only, and
the gap did not show in its score: it printed a full tally while every guard in
`js/src` had nothing breaking it on purpose. A tally over the half you can reach reads
exactly like a tally over the whole thing, which is the shape of defect this package
exists to report — so it was pointed at itself. A mutation names a FILE, the suffix
says which half, and that half's suite is the one that has to go red.

Every mutation makes a guard SILENTLY PERMISSIVE or SILENTLY STRICT rather than loud,
because that is the failure mode that matters in an auditing tool. One whose detectors
quietly stop detecting reports a clean sheet, which is indistinguishable from a project
with no problems — and a clean sheet is what everybody wants to see.

SEVERAL MUTATIONS ARE VERSIONS THIS TOOL ACTUALLY SHIPPED, kept as mutations rather
than as comments so a defect fixed once cannot come back quietly:

  * `discriminating` counting distinct OUTCOMES instead of distinct RETURNS
  * `is_projection` comparing whole vectors instead of the answered positions
  * `changed_files` comparing two path bases without resolving symlinks
  * `guards_per_file` reading only committed history, so uncommitted guards vanish
  * `audit_anchors` letting harnesses into the corpus, so anchors match themselves

This runner is also a SUBJECT of `assay runners` and carries all seven properties it
audits for: positive evidence a suite RAN, a dead-vs-real partition before any
counting, restore in a `finally`, SIGTERM turned into an exception (SIGTERM does not
run `finally`), an `ast.parse` guard so a mutation that breaks the file is not scored
as a catch, no scratch state written into the tree, and a digest taken before the
first write and compared after the last restore — because a restore that RAN is not a
restore that WORKED.

An EIGHTH property, from exp 183, which `assay runners` does not audit for and which
this runner needs anyway — because restoring the SOURCE is not enough on its own. The
modules mutated here are IMPORTED by the Python suite, and a `.pyc` is judged valid by
source SIZE plus mtime-SECONDS. `MIN_DISTINCT = 2` -> `MIN_DISTINCT = 1` below is the
same LENGTH, so the restore leaves an identical size in the same second, CPython's
cache check passes, and the NEXT run executes bytecode compiled from the MUTATED file
— failing on a line that exists in no source file on disk, which reads exactly like a
real defect in the tool rather than an instrument fault. So the suites run with
`PYTHONDONTWRITEBYTECODE=1`, and `__pycache__` beside the mutated package is dropped
before the baseline, before each mutation and inside every restore.

    python3 mutations_assay.py              # the whole table
    python3 mutations_assay.py --only same  # substring filter (PARTIAL RUN)
"""

import argparse
import ast
import glob
import hashlib
import os
import re
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # python/
REPO = os.path.dirname(ROOT)          # the repository, which holds both halves

# --------------------------------------------------------------------------- #
# THE TWO HALVES.
#
# This runner used to be able to mutate Python only, and the gap was not visible in
# its score: it printed `59/59` while every guard in `js/src` had nothing breaking it
# on purpose. A tally over the half you can reach reads exactly like a tally over the
# whole thing, which is the shape of defect this package exists to report.
#
# A mutation names a FILE, and the file's SUFFIX decides which half's suite has to
# notice it. Inferred rather than declared, because an entry naming both a file and a
# language can disagree with itself and the suffix is the fact.
#
# Each half brings its own four answers: where its sources live, how to run its suite,
# how to tell that the suite RAN, and how to read a failure out of what it printed.
# --------------------------------------------------------------------------- #

# A suite has RUN only if its EVIDENCE appears. "No failures" and "no test executed"
# are different things, and conflating them is the first property this tool audits for.
PY_EVIDENCE = re.compile(r"^\d+ tests, ", re.M)
# Node prints `# tests 141` under TAP (18 and 22) and `ℹ tests 141` under the spec
# reporter (24). Either proves the run happened AND discovered something: a count of
# zero is not evidence, it is the silence this check exists to refuse.
JS_EVIDENCE = re.compile(r"^[#\u2139]\s*tests\s+[1-9]", re.M)

# Node 18 and 22 report `not ok 3 - name`; Node 24 reports `✖ name (1.2ms)` and then
# repeats every failure under a `✖ failing tests:` heading. The heading carries no
# duration, so requiring one is what keeps it out of the list.
JS_FAILURE = re.compile(r"^(?:not ok \d+ - (.+)|\u2716 (.+?) \(\d[\d.]*ms\))$", re.M)


def _python_failures(out):
    return [l.strip() for l in out.splitlines()
            if l.startswith(("FAIL:", "ERROR:"))]


def _node_failures(out):
    names = [inline or summary for inline, summary in JS_FAILURE.findall(out)]
    # `dict.fromkeys` rather than a set: Node 24 prints each failure twice and the
    # ORDER is what the score reports, so the first one has to stay first.
    return ["FAIL: %s" % name for name in dict.fromkeys(names)]


def _python_syntax_error(_path, text):
    try:
        ast.parse(text)
    except SyntaxError as exc:
        return str(exc)
    return None


def _node_syntax_error(path, _text):
    """`node --check`, run on the file WHERE IT LIVES.

    Node decides a `.js` file's module format from the nearest `package.json`, so a
    check fed the text from anywhere else parses `export` as CommonJS and calls every
    valid mutant a syntax error — which would score the weakest possible mutation as
    the strongest possible catch, the exact failure this guard exists to prevent.
    """
    proc = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    if proc.returncode == 0:
        return None
    # The LAST line of node's stderr is its version banner, not its complaint. Taking
    # it would report `Node.js v24.11.1` as the reason a mutant does not parse, which
    # is a number reported without saying what produced it.
    for line in proc.stderr.splitlines():
        if re.match(r"^\w*Error: ", line.strip()):
            return line.strip()[:80]
    said = [l for l in proc.stderr.strip().splitlines() if l.strip()]
    return (said[0] if said else "node --check gave no reason")[:80]


LANGUAGES = {
    ".py": {
        "name": "python",
        "sources": os.path.join(ROOT, "assay"),
        "suite": [sys.executable, os.path.join(HERE, "run_tests.py")],
        "evidence": PY_EVIDENCE,
        "failures": _python_failures,
        "syntax_error": _python_syntax_error,
    },
    ".js": {
        "name": "javascript",
        "sources": os.path.join(REPO, "js", "src"),
        "suite": ["node", "--test"] + sorted(
            glob.glob(os.path.join(REPO, "js", "test", "*.test.js"))),
        "evidence": JS_EVIDENCE,
        "failures": _node_failures,
        "syntax_error": _node_syntax_error,
    },
}


def language(name):
    """Which half a mutation targets, decided by the file's suffix."""
    suffix = os.path.splitext(name)[1]
    if suffix not in LANGUAGES:
        raise SystemExit("no language for %r — this runner knows %s"
                         % (name, ", ".join(sorted(LANGUAGES))))
    return LANGUAGES[suffix]


def target(name):
    return os.path.join(language(name)["sources"], name)


def drop_bytecode():
    """Clear cached bytecode beside the Python sources this runner mutates.

    Belt to `PYTHONDONTWRITEBYTECODE`'s braces; see the module docstring. Not a
    per-half answer like the four above, because it is not a question both halves
    have: node compiles nothing to disk, so this is a fact about ONE of them.
    """
    cache = os.path.join(LANGUAGES[".py"]["sources"], "__pycache__")
    if not os.path.isdir(cache):
        return
    for name in os.listdir(cache):
        if name.endswith(".pyc"):
            os.remove(os.path.join(cache, name))


# (label, file, old, new)
MUTATIONS = [
    # ---- the JSON report says the same thing the prose one does -------------- #
    ("verdicts: the JSON exit code is computed apart from the Report's",
     "verdicts.py",
     """        "exit_code": 2 if error else report.exit_code(),""",
     """        "exit_code": 2 if error else 0,"""),
    ("verdicts: keys stop being sorted, so the two halves print different documents",
     "verdicts.py",
     """    json.dump(payload, out, indent=2, sort_keys=True, ensure_ascii=False)""",
     """    json.dump(payload, out, indent=2, sort_keys=False, ensure_ascii=False)"""),
    ("verdicts: a run that could not start emits a DIFFERENT SHAPE from one that ran",
     "verdicts.py",
     """    report = report if report is not None else Report()""",
     """    report = report if report is not None else Report()
    if error:
        return 2"""),
    ("cli: --json falls back to prose on the failure path",
     "cli.py",
     """    if getattr(args, "as_json", False):
        return render_json(None, out, meta=_meta(args), error=message)""",
     """    if False:
        return render_json(None, out, meta=_meta(args), error=message)"""),
    ("cli: the JSON baseline hides the lines this run could not check",
     "cli.py",
     '''            "unchecked": [{"line": e.line, "from": e.produced_by} for e in unchecked],''',
     '''            "unchecked": [],'''),
    ("cli: the JSON baseline claims it performed every audit",
     "cli.py",
     '''            "performed": sorted(performed),''',
     '''            "performed": ["runners", "anchors", "diff", "scan"],'''),
    # ---- a snippet's function is never guessed at ---------------------------- #
    ("sameness: an ambiguous snippet silently picks a function instead of refusing",
     "sameness.py",
     """    if len(mod.funcs) > 1:
        return None, ("the snippet defines %d functions (%s) — name one with --name"
                      % (len(mod.funcs), ", ".join(sorted(mod.funcs))))""",
     """    if False:
        return None, ("the snippet defines %d functions (%s) — name one with --name"
                      % (len(mod.funcs), ", ".join(sorted(mod.funcs))))"""),
    ("cli: --name is accepted and inert without --stdin (the shape of a shipped defect)",
     "cli.py",
     """    if args.name is not None and not args.stdin:""",
     """    if False:"""),
    # ---- a search that could never have matched says so --------------------- #
    ("cli: `search` calls a query the ladder cannot discriminate a clean `none` "
     "(a shipped defect)",
     "cli.py",
     """    if _undiscriminated(report, query, vector):""",
     """    if False:"""),
    ("cli: the ladder's own refusal prints as an `ok`, so nothing says the tool "
     "could not decide",
     "cli.py",
     """    report.look("%s — not discriminated by the ladder" % func.ref, func.ref, detail)""",
     """    report.ok("%s — not discriminated by the ladder" % func.ref, func.ref, detail)"""),
    # ---- the vacuous-probe guard ------------------------------------------- #
    ("sameness: a shallow COPY stops counting as vacuous (a shipped defect)",
     "sameness.py",
     """    vacuous = (
        lambda *a, _i=0: a[_i],
        lambda *a, _i=0: dict(a[_i]),
    )""",
     """    vacuous = (
        lambda *a, _i=0: a[_i],
    )"""),
    ("sameness: a file that does not parse vanishes again (a shipped defect)",
     "sameness.py",
     """        out.files += 1
        mod = parse(path)
        if mod is None:
            out.unloadable[path] = "could not parse"
            continue""",
     """        mod = parse(path)
        if mod is None:
            continue
        out.files += 1"""),
    ("sameness: distinct counted over OUTCOMES again (a shipped defect)",
     "sameness.py",
     '''    returned = [o for o in vector if not o.startswith("E:")]
    distinct = len(set(returned))''',
     '''    returned = [o for o in vector if not o.startswith("E:")]
    distinct = len(set(vector))'''),
    ("sameness: the discrimination guard is removed entirely",
     "sameness.py",
     '''    if distinct < MIN_DISTINCT:
        return None''',
     '''    if False:
        return None'''),
    ("sameness: a constant function counts as discriminated",
     "sameness.py",
     "MIN_DISTINCT = 2              # distinct RETURNED values (see `discriminating`)",
     "MIN_DISTINCT = 1              # distinct RETURNED values (see `discriminating`)"),
    ("sameness: the projection guard stops being consulted",
     "sameness.py",
     '''    if inputs and is_projection(vector, inputs):
        return None''',
     '''    if False:
        return None'''),
    ("sameness: is_projection compares whole vectors again (a shipped defect)",
     "sameness.py",
     '''    live = [i for i, o in enumerate(vector) if not o.startswith("E:")]
    if not live:
        return True''',
     '''    live = list(range(len(vector)))
    if not live:
        return True'''),
    ("sameness: is_projection never fires",
     "sameness.py",
     '''        if all(vector[i] == proj[i] for i in live):
            return True''',
     '''        if False:
            return True'''),

    # ---- coroutines ---------------------------------------------------------- #
    ("sameness: an `async def` becomes invisible again, in no count at all",
     "sameness.py",
     """            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):""",
     """            elif isinstance(node, ast.FunctionDef):"""),
    ("sameness: a coroutine is read as an object rather than run",
     "sameness.py",
     """        if inspect.iscoroutine(value):
            value = _await(value)
    except BaseException as exc:                              # noqa: BLE001""",
     """        if False:
            value = _await(value)
    except BaseException as exc:                              # noqa: BLE001"""),

    # ---- the cross-language interlingua -------------------------------------- #
    ("sameness: a raise carries its NAME across the language boundary again",
     "sameness.py",
     '''    except BaseException:                                     # noqa: BLE001
        return "E:*"''',
     '''    except BaseException as exc:                              # noqa: BLE001
        return "E:%s" % type(exc).__name__'''),
    ("sameness: an outcome the interlingua cannot state is COMPARED anyway",
     "sameness.py",
     '''        if x.startswith("X:") or y.startswith("X:"):''',
     '''        if False:'''),
    ("sameness: an unstatable value is rendered approximately rather than refused",
     "sameness.py",
     '''    text = cross_render(value)
    if text is None:
        return "X:%s" % type(value).__name__''',
     '''    text = cross_render(value)
    if text is None:
        text = repr(value)'''),
    ("sameness: an INTEGRAL float stops rendering as an integer",
     "sameness.py",
     '''        if value.is_integer():
            return "%d" % int(value)''',
     '''        if False:
            return "%d" % int(value)'''),
    ("sameness: NaN and the infinities collapse into one absence",
     "sameness.py",
     '''        if value != value:
            return "NaN"''',
     '''        if value != value:
            return "null"'''),
    ("sameness: cross object keys stop being sorted",
     "sameness.py",
     '''        for key in sorted(value, key=repr):''',
     '''        for key in value:'''),
    ("sameness: the CROSS ladder key drops the digest of its rungs",
     "sameness.py",
     '''    return "cross%d/%s/%s" % (arity, LADDER_VERSION, digest)''',
     '''    return "cross%d/%s/%s" % (arity, LADDER_VERSION, "")'''),
    ("sameness: the cross vacuity guard stops consulting the projections",
     "sameness.py",
     '''    for proj in cross_projections(rungs):
        if live and all(vector[i] == proj[i] for i in live):
            return None''',
     '''    for proj in cross_projections(rungs):
        if False:
            return None'''),
    ("cli: `cross` reports a `differs` as a finding",
     "cli.py",
     '''        report.ok("differs: %s — %s" % (pair, detail), first["ref"])''',
     '''        report.finding("differs: %s — %s" % (pair, detail), first["ref"])'''),
    ("cli: `cross` compares a record from ANOTHER schema anyway",
     "cli.py",
     '''    if record["assay_probe"] != PROBE_SCHEMA:''',
     '''    if False:'''),
    ("cli: `cross` compares two functions of ONE language on the cross ladder",
     "cli.py",
     '''    if first["language"] == second["language"]:''',
     '''    if False:'''),
    ("cli: `probe` turns a refused function into exit 2 rather than a record",
     "cli.py",
     '''    if vector is None:
        record["look"] = refused''',
     '''    if vector is None:
        return 2'''),
    ("cli: the probe record stops sorting its keys, so two halves write two documents",
     "cli.py",
     '''    vector, refused = probe(func, mode="cross")
    if vector is None:
        record["look"] = refused
    else:
        record["ladder"] = cross_key(arity)
        record["vector"] = vector
    json.dump(record, out, indent=2, sort_keys=True, ensure_ascii=False)''',
     '''    vector, refused = probe(func, mode="cross")
    if vector is None:
        record["look"] = refused
    else:
        record["ladder"] = cross_key(arity)
        record["vector"] = vector
    json.dump(record, out, indent=2, sort_keys=False, ensure_ascii=False)'''),

    # ---- comparison, and the wrong-baseline defect -------------------------- #
    ("sameness: two different ladders are zipped together",
     "sameness.py",
     '''    if a_key != b_key:
        return "look", "not comparable: %s vs %s" % (a_key, b_key)
    if len(a_vec) != len(b_vec) or len(a_vec) != len(inputs):''',
     '''    if False:
        return "look", "not comparable: %s vs %s" % (a_key, b_key)
    if len(a_vec) != len(b_vec) or len(a_vec) != len(inputs):'''),
    ("sameness: a vector that does not match the ladder is compared anyway",
     "sameness.py",
     '''    if len(a_vec) != len(b_vec) or len(a_vec) != len(inputs):
        return "look", "vector length disagrees with the ladder"''',
     '''    if False:
        return "look", "vector length disagrees with the ladder"'''),
    ("sameness: the witness no longer names the input that produced it",
     "sameness.py",
     '''            return "differs", "%s -> %s vs %s" % (inputs[i], x, y)''',
     '''            return "differs", "they disagree"'''),
    ("sameness: a vacuous agreement is reported as `same`",
     "sameness.py",
     '''    if discriminating(a_vec, inputs) is None:
        return "look", "not discriminated by the ladder"''',
     '''    if False:
        return "look", "not discriminated by the ladder"'''),

    # ---- what may be executed ---------------------------------------------- #
    ("sameness: randomness stops being refused",
     "sameness.py",
     '''os sys subprocess socket shutil urllib requests random time datetime calendar''',
     '''os sys subprocess socket shutil urllib requests datetime calendar'''),
    ("sameness: open() stops being refused",
     "sameness.py",
     '''open input exec eval compile __import__ breakpoint exit quit globals locals vars''',
     '''input exec eval compile __import__ breakpoint exit quit globals locals vars'''),
    ("sameness: a generator is executed",
     "sameness.py",
     '''        if isinstance(sub, (ast.Yield, ast.YieldFrom)):
            return "generator"''',
     '''        if False:
            return "generator"'''),
    ("sameness: a zero-arity function is probed",
     "sameness.py",
     '''    if not func.params:
        return "no arguments (a ladder cannot discriminate)"''',
     '''    if False:
        return "no arguments (a ladder cannot discriminate)"'''),
    ("sameness: an impure sibling helper is carried in anyway",
     "sameness.py",
     '''            why = purity(helper)
            if why:
                return None, "helper %s: %s" % (name, why)''',
     '''            why = None
            if why:
                return None, "helper %s: %s" % (name, why)'''),
    ("sameness: an unresolvable free name no longer stops the probe",
     "sameness.py",
     '''        else:
            return None, "free name %s" % name''',
     '''        else:
            pass'''),

    # ---- outcomes and canonicalisation -------------------------------------- #
    ("sameness: exception MESSAGES are compared, so every pair differs",
     "sameness.py",
     '''        return "E:%s" % type(exc).__name__''',
     '''        return "E:%s:%s" % (type(exc).__name__, exc)'''),
    ("sameness: dicts are no longer order-normalised",
     "sameness.py",
     '''        body = ", ".join("%s: %s" % (canon(k, _depth + 1), canon(v, _depth + 1))
                         for k, v in sorted(value.items(), key=lambda kv: repr(kv[0])))''',
     '''        body = ", ".join("%s: %s" % (canon(k, _depth + 1), canon(v, _depth + 1))
                         for k, v in value.items())'''),
    ("sameness: a long value is truncated rather than hashed",
     "sameness.py",
     '''    if len(text) > REPR_INLINE:
        return "V#%s" % hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()''',
     '''    if len(text) > REPR_INLINE:
        return "V:%s" % text[:REPR_INLINE]'''),
    ("sameness: the empty string leaves the ladder",
     "sameness.py",
     '''    "''", "'a'", "'abc'", "'Hello, World!'", "'ATTACK AT DAWN, at dawn!'",''',
     '''    "'a'", "'abc'", "'Hello, World!'", "'ATTACK AT DAWN, at dawn!'",'''),
    ("sameness: singleton buckets are reported as duplication",
     "sameness.py",
     '''    scan.groups = sorted((sorted(v) for v in buckets.values() if len(v) > 1),''',
     '''    scan.groups = sorted((sorted(v) for v in buckets.values() if len(v) > 0),'''),
    ("sameness: the ladder key is dropped from the bucket, mixing arities",
     "sameness.py",
     '''        buckets.setdefault((scan.keys[ref], tuple(vector)), []).append(ref)''',
     '''        buckets.setdefault(("", tuple(vector)), []).append(ref)'''),

    # ---- `why`: which gate refused THIS function ---------------------------- #
    ("sameness: a PROJECTION is explained as a constant",
     "sameness.py",
     '''    seen = len(set(answered))
    if seen < MIN_DISTINCT:''',
     '''    seen = len(set(answered))
    if True:'''),
    ("sameness: a vector that raised on EVERY rung is explained as a constant",
     "sameness.py",
     '''    if not answered:
        return ("it raised on all %d rungs — the ladder reached its type errors and "
                "never its behaviour" % len(vector))''',
     '''    if False:
        return ("it raised on all %d rungs — the ladder reached its type errors and "
                "never its behaviour" % len(vector))'''),
    ("sameness: `why` explains a function the ladder DID discriminate",
     "sameness.py",
     '''    if discriminating(vector, inputs) is not None:
        return None''',
     '''    if False:
        return None'''),
    ("sameness: `why` stops telling a missing FILE from a missing NAME",
     "sameness.py",
     '''    if not os.path.exists(path):
        return None, "no such file: %s" % path''',
     '''    if not os.path.exists(path):
        return None, "cannot resolve %s" % ref'''),
    ("verdicts: a look's DETAIL stops being printed, so `why` answers half",
     "verdicts.py",
     '''            if item.detail:
                out.write("           %s\\n" % item.detail)''',
     '''            if False:
                out.write("           %s\\n" % item.detail)'''),

    # ---- the six properties ------------------------------------------------- #
    ("checks: the evidence detector is always satisfied",
     "checks.py",
     '''    return _has(src, "EVIDENCE", "DID NOT RUN", "did not run", "DID_NOT_RUN")''',
     '''    return True'''),
    ("checks: dead-vs-real back to a text match that flags CORRECT code",
     "checks.py",
     '''    if _assigns(tree, "dead", "real"):
        return True
    return _requires_named_section(src)''',
     '''    if re.search(r"detected\\s*\\+=\\s*bool\\(", src):
        return False
    return _has(src, "dead", "real")'''),
    ("checks: the sigterm detector is always satisfied",
     "checks.py",
     '''    return "SIGTERM" in src''',
     '''    return True'''),
    ("checks: the restore-in-finally detector is always satisfied",
     "checks.py",
     '''    return "finally:" in src''',
     '''    return True'''),
    ("checks: the parse guard detector is always satisfied",
     "checks.py",
     '''    return _has(src, "ast.parse", "compile(") or _requires_named_section(src)''',
     '''    return True'''),
    ("checks: the restore-verified detector is always satisfied",
     "checks.py",
     '''    digested = _has(src, *DIGEST_TELLS)
    return digested and _has(src, *RESTORE_FAILURE_TELLS)''',
     '''    digested = _has(src, *DIGEST_TELLS)
    return True'''),
    ("checks: a digest NOTHING COMPARES satisfies restore-verified",
     "checks.py",
     '''    return digested and _has(src, *RESTORE_FAILURE_TELLS)''',
     '''    return digested or _has(src, *RESTORE_FAILURE_TELLS)'''),
    ("checks: the named-section alternative no longer counts",
     "checks.py",
     '''    return "WRONG" in src and _has(src, "wanted", "section")''',
     '''    return False'''),
    ("checks: a runner that does not parse is skipped rather than reported",
     "checks.py",
     '''            rep.finding("%s does not parse (%s)" % (rel, exc), rel)
            continue''',
     '''            continue'''),
    ("checks: an exemption is consulted for every property, not the one it names",
     "checks.py",
     '''            if config.exempt_runner(rel, key):
                continue''',
     '''            if config.runner_exempt:
                continue'''),

    # ---- the change audit, and its two path defects -------------------------- #
    ("checks: changed_files stops resolving symlinks (a shipped defect)",
     "checks.py",
     '''        top, real_root = os.path.realpath(top.strip()), os.path.realpath(root)
        changed = [os.path.relpath(os.path.join(top, c), real_root) for c in changed]''',
     '''        top, real_root = top.strip(), root
        changed = [os.path.relpath(os.path.join(top, c), real_root) for c in changed]'''),
    ("checks: guards_per_file reads committed history only (a shipped defect)",
     "checks.py",
     '''    for args in (("diff", "-U0", "%s...HEAD" % base), ("diff", "-U0", "HEAD")):''',
     '''    for args in (("diff", "-U0", "%s...HEAD" % base),):'''),
    ("checks: guards are computed over the whole patch, not per file",
     "checks.py",
     '''            per_file.setdefault(cur, []).append(line)''',
     '''            per_file.setdefault("", []).append(line)'''),
    ("checks: uncommitted work is invisible to changed_files",
     "checks.py",
     '''        if name.endswith(SOURCE_SUFFIXES) and name not in changed:
            changed.append(name)''',
     '''        if False:
            changed.append(name)'''),
    ("checks: a DELETED file is reported as needing a check",
     "checks.py",
     '''        if not os.path.exists(os.path.join(root, name)):
            continue''',
     '''        if False:
            continue'''),
    ("checks: a missing runner becomes a finding rather than a look",
     "checks.py",
     '''            rep.look("%s has NO mutation runner naming it — a missing check is a "
                     "stronger signal than a failing one" % name, name)''',
     '''            rep.finding("%s has NO mutation runner naming it — a missing check is a "
                        "stronger signal than a failing one" % name, name)'''),

    # ---- exemptions, read in both directions --------------------------------- #
    ("checks: a stale exemption stops being a finding",
     "checks.py",
     '''        if not os.path.exists(os.path.join(root, rel)):
            rep.finding("exemption names a runner that no longer exists: %s" % rel, rel)''',
     '''        if False:
            rep.finding("exemption names a runner that no longer exists: %s" % rel, rel)'''),
    ("checks: an exemption for an unknown property stops being a finding",
     "checks.py",
     '''        if key != "*" and key not in PROPERTY_KEYS:''',
     '''        if False:'''),

    # ---- anchors -------------------------------------------------------------- #
    ("anchors: harnesses rejoin the corpus, so anchors match themselves",
     "anchors.py",
     '''    skip = harness_paths(root)''',
     '''    skip = set()'''),
    ("anchors: only THIS language's harnesses leave the corpus",
     "anchors.py",
     '''            if name.startswith("mutations") and name.endswith(SOURCE_EXTS):''',
     '''            if name.startswith("mutations") and name.endswith(".py"):'''),
    ("anchors: an ambiguous anchor stops being a finding",
     "anchors.py",
     '''            elif worst > 1:''',
     '''            elif False:'''),
    ("anchors: `+=` tables are no longer read",
     "anchors.py",
     '''        if isinstance(node, ast.AugAssign):
            names = [node.target.id] if isinstance(node.target, ast.Name) else []''',
     '''        if isinstance(node, ast.AugAssign):
            names = []'''),
    ("anchors: every column is taken as an anchor, so labels are counted too",
     "anchors.py",
     '''            if 2 <= len(parts) <= 4:
                found.append(anchor_column(parts).value)''',
     '''            if 2 <= len(parts) <= 4:
                found.extend(p.value for p in parts[:-1])'''),
    ("anchors: an anchor matching NOTHING goes back to being counted, not reported",
     "anchors.py",
     '''        for anchor in dead:
            rep.finding(''',
     '''        for anchor in []:
            rep.finding('''),
    ("anchors: a table shape it cannot read is guessed at rather than offered",
     "anchors.py",
     '''            elif len(parts) > 4:
                unreadable.append(parts[0].value)''',
     '''            elif len(parts) > 4:
                found.append(anchor_column(parts).value)'''),

    ("anchors: a declared-test column shifts the anchor onto the replacement",
     "anchors.py",
     '''    trimmed = list(parts)
    while len(trimmed) > 3 and METADATA_COLUMN.match(trimmed[-1].value):
        trimmed.pop()
    return trimmed[-2]''',
     '''    return parts[-2]'''),
    ("anchors: the JavaScript half stops disambiguating and the two disagree",
     "anchors.js",
     '''  const trimmed = parts.slice();
  while (trimmed.length > 3 && METADATA_COLUMN.test(trimmed[trimmed.length - 1])) {
    trimmed.pop();
  }
  return trimmed[trimmed.length - 2];''',
     '''  return parts[parts.length - 2];'''),

    # ---- config, read in both directions -------------------------------------- #
    ("config: broken JSON becomes an empty config rather than an error",
     "config.py",
     '''    except ValueError as exc:
        raise ConfigError("%s is not valid JSON (%s)" % (path, exc))''',
     '''    except ValueError:
        return Config()'''),
    ("config: an exemption without a reason is accepted",
     "config.py",
     '''        for field in required:
            if not entry.get(field):''',
     '''        for field in required:
            if False:'''),
    ("config: a baseline entry in OBJECT form needs no reason",
     "config.py",
     '''        for field in ("line", "reason"):
            if not entry.get(field):''',
     '''        for field in ("line",):
            if not entry.get(field):'''),
    ("config: a baseline entry may name a command that cannot produce a finding",
     "config.py",
     '''        if produced_by is not None and produced_by not in FAMILIES:''',
     '''        if False:'''),
    ("config: an object-form baseline entry stops being read at all",
     "config.py",
     '''        if not isinstance(entry, dict):
            raise ConfigError("%s: a 'baseline' entry must be the finding's exact "
                              "text, or an object carrying it as 'line'" % path)''',
     '''        if True:
            raise ConfigError("%s: a 'baseline' entry must be the finding's exact "
                              "text, or an object carrying it as 'line'" % path)'''),
    ("config: a stale baseline line stops being reported",
     "config.py",
     '''        elif entry.produced_by in performed:
            stale.append(entry)''',
     '''        elif entry.produced_by in performed:
            unchecked.append(entry)'''),
    ("config: a line THIS RUN COULD NOT SEE is called stale anyway (cries wolf)",
     "config.py",
     '''        else:
            unchecked.append(entry)''',
     '''        else:
            stale.append(entry)'''),
    ("config: an untagged line is called stale by a PARTIAL run",
     "config.py",
     '''    complete = set(FAMILIES) <= performed''',
     '''    complete = True'''),
    ("config: the baseline matches on a prefix rather than the exact message",
     "config.py",
     '''    still = [f for f in findings if f.message not in known]''',
     '''    still = [f for f in findings
             if not any(f.message.startswith(k) for k in known)]'''),
    ("config: write_baseline drops every OTHER key in the file",
     "config.py",
     '''    raw["baseline"] = baseline''',
     '''    raw = {"baseline": baseline}'''),
    ("config: write_baseline writes a `from` of null rather than none at all",
     "config.py",
     '''        if produced_by:
            entry["from"] = produced_by''',
     '''        entry["from"] = produced_by
        if False:
            entry["from"] = produced_by'''),
    ("cli: accept writes a `look` into the baseline (the 0.2.2 defect, automated)",
     "cli.py",
     '''        if args.line in {i.message for i in report.looks}:''',
     '''        if False:'''),
    ("cli: accept writes a line nothing printed, so the entry is born stale",
     "cli.py",
     '''        if args.line not in fired:''',
     '''        if False:'''),
    ("cli: accept writes an entry with no reason",
     "cli.py",
     '''    if not args.reason:''',
     '''    if False:'''),
    ("config: a named config that is missing is silently ignored",
     "config.py",
     '''    if not os.path.exists(path):
        raise ConfigError("no config at %s" % path)''',
     '''    if not os.path.exists(path):
        return Config()'''),

    # ---- verdicts, the shared contract ----------------------------------------- #
    ("verdicts: a `look` starts failing the run",
     "verdicts.py",
     '''        return 1 if self.findings else 0''',
     '''        return 1 if self.findings or self.looks else 0'''),
    ("verdicts: an unknown verdict is accepted as a fourth category",
     "verdicts.py",
     '''        if verdict not in ORDER:
            raise ValueError("unknown verdict %r" % (verdict,))''',
     '''        if False:
            raise ValueError("unknown verdict %r" % (verdict,))'''),
    ("verdicts: `no findings` stops being printed",
     "verdicts.py",
     '''    elif verbose:
        out.write("\\nno findings.\\n")''',
     '''    elif False:
        out.write("\\nno findings.\\n")'''),
    ("verdicts: findings are suppressed by --quiet",
     "verdicts.py",
     '''    if findings:
        out.write("\\nFINDINGS — %d, each checked rather than guessed:\\n" % len(findings))''',
     '''    if findings and verbose:
        out.write("\\nFINDINGS — %d, each checked rather than guessed:\\n" % len(findings))'''),

    # ---- the CLI contract ------------------------------------------------------ #
    ("cli: a flag after the subcommand overwrites the one before it",
     "cli.py",
     '''    common.add_argument("-q", "--quiet", action="store_true",
                        default=False if defaults else nothing,
                        help="print findings only")''',
     '''    common.add_argument("-q", "--quiet", action="store_true",
                        default=False,
                        help="print findings only")'''),
    ("cli: an unresolvable reference exits 0 rather than 2",
     "cli.py",
     '''    out.write("assay: %s\\n" % message)
    return 2''',
     '''    out.write("assay: %s\\n" % message)
    return 0'''),
    ("cli: a `differs` verdict is reported as a finding",
     "cli.py",
     '''        report.ok("differs: %s — %s" % (pair, detail), first.ref)''',
     '''        report.finding("differs: %s — %s" % (pair, detail), first.ref)'''),
    ("cli: a command claims it performed every audit (cries wolf at itself)",
     "cli.py",
     '''    return _finish(args, report, config, out, ("runners",))''',
     '''    return _finish(args, report, config, out,
                   ("runners", "anchors", "diff", "scan"))'''),
    ("cli: `all` without --scan claims it performed the sameness half",
     "cli.py",
     '''    return families, performed''',
     '''    if "scan" not in performed:
        performed.append("scan")
    return families, performed'''),
    ("cli: the lines nobody could check are counted as `0 stale`",
     "cli.py",
     '''    if unchecked:
        why = {}''',
     '''    if False:
        why = {}'''),
    ("cli: `all` stops folding in the sameness half",
     "cli.py",
     '''    if getattr(args, "scan", None):
        perform("scan", scan_half)''',
     '''    if False:
        perform("scan", scan_half)'''),
    ("cli: a broken config is ignored rather than exiting 2",
     "cli.py",
     '''    except ConfigError as exc:
        return _fail(args, out, str(exc))''',
     '''    except ConfigError:
        from .config import Config
        config = Config()'''),
]


# --------------------------------------------------------------------------- #
# THE JAVASCRIPT HALF.
#
# Every entry here is a guard that had NOTHING breaking it on purpose until this
# table existed. Six of them are defects this tool actually shipped and that the
# first real project it was pointed at found — kept as mutations rather than as
# comments, so a defect fixed once cannot come back quietly.
#
# The suite that must go red is `node --test js/test/*.test.js`, not the Python one:
# a Python test cannot observe a JavaScript guard, and scoring a JavaScript mutation
# against a green Python suite would be a tally over a suite that was never going to
# see it.
# --------------------------------------------------------------------------- #

MUTATIONS += [
    # ---- the JSON report says the same thing the prose one does -------------- #
    ("js verdicts: the JSON exit code is computed apart from the Report's",
     "verdicts.js",
     """    exit_code: error ? 2 : built.exitCode(),""",
     """    exit_code: error ? 2 : 0,"""),
    ("js verdicts: keys stop being sorted, so the two halves print different documents",
     "verdicts.js",
     """  for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);""",
     """  for (const key of Object.keys(value)) out[key] = sorted(value[key]);"""),
    ("js cli: the JSON baseline hides the lines this run could not check",
     "cli.js",
     """      unchecked: unchecked.map((e) => ({ line: e.line, from: e.producedBy })),""",
     """      unchecked: [],"""),
    ("js cli: the JSON baseline claims it performed every audit",
     "cli.js",
     """      performed: [...performed].sort(),""",
     """      performed: ['runners', 'anchors', 'diff', 'scan'],"""),
    # ---- a snippet's function is never guessed at ---------------------------- #
    ("js cli: an ambiguous snippet silently picks a function instead of refusing",
     "cli.js",
     """  } else if (roster.length > 1) {""",
     """  } else if (false) {"""),
    ("js cli: a snippet is allowed to import from the tree",
     "cli.js",
     """  if (relativeSpecifiers(text).length) {""",
     """  if (false) {"""),
    # ---- a search that could never have matched says so --------------------- #
    ("js cli: `search` calls a query the ladder cannot discriminate a clean `none` "
     "(a shipped defect)",
     "cli.js",
     """      if (undiscriminated(report, entry, ref)) {""",
     """      if (false) {"""),
    ("js cli: the ladder's own refusal prints as an `ok`, so nothing says the tool "
     "could not decide",
     "cli.js",
     """  report.look(`${display} — not discriminated by the ladder`, display, detail);""",
     """  report.ok(`${display} — not discriminated by the ladder`, display, detail);"""),
    # ---- one function object is one function -------------------------------- #
    ("js probe: two names for ONE function object are a pair again (a shipped defect)",
     "probe.js",
     """    if (typeof value !== 'function' || seen.has(value)) return;""",
     """    if (typeof value !== 'function') return;"""),
    ("js probe: a barrel re-export duplicates its helper again (a shipped defect)",
     "probe.js",
     """  const seen = new Set(inherited);""",
     """  const seen = new Set();"""),

    # ---- the cross-language interlingua -------------------------------------- #
    ("js sameness: a throw carries its NAME across the language boundary again",
     "sameness.js",
     """  } catch {
    return 'E:*';
  } finally {
    clearTimeout(timer);
  }
  const text = crossRender(value);""",
     """  } catch (err) {
    return `E:${(err && err.name) || 'Error'}`;
  } finally {
    clearTimeout(timer);
  }
  const text = crossRender(value);"""),
    ("js sameness: an outcome the interlingua cannot state is COMPARED anyway",
     "sameness.js",
     """    if (x.startsWith('X:') || y.startsWith('X:')) {""",
     """    if (false) {"""),
    ("js sameness: undefined stops being the same absence as null",
     "sameness.js",
     """  if (value === null || value === undefined) return 'null';""",
     """  if (value === null) return 'null';
  if (value === undefined) return 'undefined';"""),
    ("js sameness: NaN and the infinities collapse into one absence",
     "sameness.js",
     """    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    // `-0` is `0` here:""",
     """    if (Number.isNaN(value)) return 'null';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    // `-0` is `0` here:"""),
    ("js sameness: a Map or a Date is flattened rather than refused",
     "sameness.js",
     """  const proto = Object.getPrototypeOf(value);
  if (typeof value !== 'object' || (proto !== Object.prototype && proto !== null)) {
    return null;
  }""",
     """  if (typeof value !== 'object') return null;"""),
    ("js sameness: cross object keys stop being sorted",
     "sameness.js",
     """  for (const key of Object.keys(value).sort()) {
    const rendered = crossRender(value[key], depth + 1);""",
     """  for (const key of Object.keys(value)) {
    const rendered = crossRender(value[key], depth + 1);"""),
    ("js sameness: the CROSS ladder key drops the digest of its rungs",
     "sameness.js",
     """  return `cross${arity}/${LADDER_VERSION}/${digest}`;""",
     """  return `cross${arity}/${LADDER_VERSION}/`;"""),
    ("js sameness: the cross vacuity guard stops consulting the projections",
     "sameness.js",
     """    if (live.length && live.every((i) => vector[i] === proj[i])) return null;""",
     """    if (false) return null;"""),
    ("js cli: `cross` reports a `differs` as a finding",
     "cli.js",
     """        report.ok(`differs: ${pair} — ${detail}`, first.ref);""",
     """        report.finding(`differs: ${pair} — ${detail}`, first.ref);"""),
    ("js cli: `cross` compares a record from ANOTHER schema anyway",
     "cli.js",
     """  if (record.assay_probe !== PROBE_SCHEMA) {
    return {
      unresolved: `${file} was written by schema ${record.assay_probe} and this is `""",
     """  if (false) {
    return {
      unresolved: `${file} was written by schema ${record.assay_probe} and this is `"""),
    ("js cli: `cross` compares two functions of ONE language on the cross ladder",
     "cli.js",
     """      if (first.language === second.language) {""",
     """      if (false) {"""),
    ("js cli: `probe` turns a refused function into exit 2 rather than a record",
     "cli.js",
     """  if (entry.skip) return { record: { ...record, arity: 0, look: entry.skip } };""",
     """  if (entry.skip) return { unresolved: entry.skip };"""),
    ("js cli: the probe record stops sorting its keys, so two halves write two documents",
     "cli.js",
     """        write(`${JSON.stringify(sortedKeys(record), null, 2)}\\n`);""",
     """        write(`${JSON.stringify(record, null, 2)}\\n`);"""),

    # ---- anchors, read by IMPORT rather than by parse ------------------------- #
    ("js anchors: the anchor moves off the second-to-last column",
     "anchors.js",
     """    if (parts.length >= 2 && parts.length <= 4) found.push(anchorColumn(parts));""",
     """    if (parts.length >= 2 && parts.length <= 4) found.push(parts[0]);"""),
    ("js anchors: a table shape it cannot read is guessed at rather than offered",
     "anchors.js",
     """    else if (parts.length > 4) unreadable.push(parts[0]);""",
     """    else if (parts.length > 4) found.push(parts[parts.length - 2]);"""),
    ("js anchors: an anchor matching NOTHING stops being a finding",
     "anchors.js",
     """      if (worst === 0) dead.push(anchor);""",
     """      if (false) dead.push(anchor);"""),
    ("js anchors: an ambiguous anchor stops being a finding",
     "anchors.js",
     """      else if (worst > 1) ambiguous.push([anchor, worst]);""",
     """      else if (false) ambiguous.push([anchor, worst]);"""),
    ("js anchors: ambiguity is counted across files rather than PER file",
     "anchors.js",
     """        if (hits > worst) worst = hits;""",
     """        worst += hits;"""),
    ("js anchors: harnesses rejoin the corpus, so anchors match themselves",
     "anchors.js",
     """  const skip = harnessPaths(root);""",
     """  const skip = new Set();"""),
    ("js anchors: only THIS language's harnesses leave the corpus",
     "anchors.js",
     """      else if (name.startsWith(RUNNER_PREFIX) && SOURCE.test(name)) {""",
     """      else if (name.startsWith(RUNNER_PREFIX) && /\\.(mjs|cjs|js)$/.test(name)) {"""),
    ("js anchors: a harness with no exported table is guessed at rather than offered",
     "anchor-probe.js",
     """  if (!named) { say({ absent: true }); return; }""",
     """  if (!named) { say({ table: [] }); return; }"""),
    ("js anchors: a table that would not import comes back empty rather than as an error",
     "anchor-probe.js",
     """    say({ error: `could not import (${(err && err.message) || err})`.slice(0, 140) });
    return;""",
     """    say({ table: [] });
    return;"""),
    ("js anchors: the table answer shares stdout with whatever the harness printed",
     "anchors.js",
     """    child.stdio[ANSWER_FD].on('data', (d) => { answer += d; });""",
     """    child.stdout.on('data', (d) => { answer += d; });"""),

    # ---- `why`: which gate refused THIS function ------------------------------ #
    ("js sameness: a PROJECTION is explained as a constant",
     "sameness.js",
     """  const seen = new Set(answered).size;
  if (seen < MIN_DISTINCT) {""",
     """  const seen = new Set(answered).size;
  if (true) {"""),
    ("js sameness: a vector that threw on EVERY rung is explained as a constant",
     "sameness.js",
     """  if (!answered.length) {
    return `it threw on all ${vector.length} rungs — the ladder reached its type `
      + 'errors and never its behaviour';
  }""",
     """  if (false) {
    return `it threw on all ${vector.length} rungs — the ladder reached its type `
      + 'errors and never its behaviour';
  }"""),
    ("js sameness: `why` explains a function the ladder DID discriminate",
     "sameness.js",
     """  if (discriminating(vector, inputs) !== null) return null;""",
     """  if (false) return null;"""),
    ("js cli: `why` stops answering at the FILE level for a refused file",
     "cli.js",
     """  const refused = fileRefusal(source);
  if (refused) {
    report.look(""",
     """  const refused = null;
  if (refused) {
    report.look("""),
    ("js verdicts: a look's DETAIL stops being printed, so `why` answers half",
     "verdicts.js",
     """      if (item.detail) write(`           ${item.detail}\\n`);""",
     """      if (false) write(`           ${item.detail}\\n`);"""),

    # ---- the seventh property ------------------------------------------------ #
    ("js checks: the restore-verified detector is always satisfied",
     "checks.js",
     """    (src) => has(src, ...DIGEST_TELLS) && has(src, ...RESTORE_FAILURE_TELLS)],""",
     """    () => true],"""),
    ("js checks: a digest NOTHING COMPARES satisfies restore-verified",
     "checks.js",
     """export const RESTORE_FAILURE_TELLS = ['RESTORE FAILED', 'NOT RESTORED',""",
     """export const RESTORE_FAILURE_TELLS = ['', 'NOT RESTORED',"""),

    # ---- the answer channel -------------------------------------------------- #
    ("js sameness: the probe answer shares stdout again (a shipped defect)",
     "sameness.js",
     """export const ANSWER_FD = 3;""",
     """export const ANSWER_FD = 1;"""),

    # ---- two populations, two counts ----------------------------------------- #
    ("js sameness: a refused FILE is counted as a skipped function (a shipped defect)",
     "sameness.js",
     """      scan.unloadable.set(rel, why);""",
     """      scan.skipped.set(rel, why);"""),

    # ---- gates that must read code, not prose -------------------------------- #
    ("js sameness: the purity gates read prose again (a shipped defect)",
     "sameness.js",
     """    if (!cache.has(scope)) cache.set(scope, stripNonCode(source, scope === CODE));""",
     """    if (!cache.has(scope)) cache.set(scope, source);"""),
    ("js sameness: an unlexable file has its refusal cleared by a guess",
     "sameness.js",
     """    if (text !== null && !pattern.test(text)) continue;""",
     """    if (!pattern.test(text)) continue;"""),

    # ---- the vacuity guards -------------------------------------------------- #
    ("js sameness: a shallow COPY stops counting as vacuous (a shipped defect)",
     "sameness.js",
     """  const vacuous = [
    (i) => (...a) => a[i],
    (i) => (...a) => ({ ...a[i] }),
  ];""",
     """  const vacuous = [
    (i) => (...a) => a[i],
  ];"""),
    ("js sameness: the discrimination threshold stops being consulted",
     "sameness.js",
     """  if (new Set(returned).size < MIN_DISTINCT) return null;
  if (inputs && isProjection(vector, inputs)) return null;""",
     """  if (false) return null;
  if (inputs && isProjection(vector, inputs)) return null;"""),
    ("js sameness: the projection guard stops being consulted",
     "sameness.js",
     """  if (inputs && isProjection(vector, inputs)) return null;""",
     """  if (false) return null;"""),
    ("js sameness: two different ladders are zipped together",
     "sameness.js",
     """  if (aKey !== bKey) return ['look', `not comparable: ${aKey} vs ${bKey}`];
  if (aVec.length !== bVec.length || aVec.length !== inputs.length) {""",
     """  if (false) return ['look', `not comparable: ${aKey} vs ${bKey}`];
  if (aVec.length !== bVec.length || aVec.length !== inputs.length) {"""),

    # ---- the ladder is chosen by the DECLARED parameter list ------------------ #
    ("js probe: arity comes from fn.length again (a shipped defect)",
     "probe.js",
     """  const arity = declaredArity(source);
  if (arity === null) return { name, skip: 'cannot read the parameter list' };""",
     """  const arity = fn.length;
  if (arity === null) return { name, skip: 'cannot read the parameter list' };"""),
    ("js sameness: a default parameter stops counting toward arity",
     "sameness.js",
     """    if (ch === ',' && depth === 0) {
      if (current.trim()) count += 1;
      current = '';
      continue;
    }""",
     """    if (ch === ',' && depth === 0) {
      if (current.trim() && !current.includes('=')) count += 1;
      current = '';
      continue;
    }"""),
    ("js sameness: an unreadable parameter list is guessed at rather than refused",
     "sameness.js",
     """  const text = stripNonCode(source, true);
  if (text === null) return null;""",
     """  const text = stripNonCode(source, true) || source;
  if (text === null) return null;"""),

    # ---- the gate knows every spelling of an import, and the blast is bounded -- #
    ("js sameness: a DYNAMIC import of a core module stops being refused",
     "sameness.js",
     r"""  [new RegExp('\\bimport\\s*\\(\\s*[\'"](?:node:)?(?:' + CORE_MODULES + ')'),
    'reaches a node core module', SPECIFIER],""",
     r"""  [new RegExp('\\bimport\\s*\\(\\s*[\'"]THIS_MATCHES_NOTHING(?:node:)?(?:' + CORE_MODULES + ')'),
    'reaches a node core module', SPECIFIER],"""),
    ("js sameness: the probe child inherits OUR cwd, so a stray write lands in the tree",
     "sameness.js",
     """      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], cwd: tmpdir() });""",
     """      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });"""),

    # ---- a barrel may not launder the gate its own file failed ---------------- #
    ("js probe: a re-exported function is probed though ITS file is refused",
     "probe.js",
     """    const elsewhere = origins.get(fn);
    if (elsewhere) {""",
     """    const elsewhere = origins.get(fn);
    if (false) {"""),
    ("js probe: the origin gate reads the BARREL's bytes instead of the origin's",
     "probe.js",
     """      const refusal = fileRefusal(text);""",
     """      const refusal = fileRefusal(source);"""),
    ("js probe: a refused origin is de-duplicated away, so nothing reports it",
     "probe.js",
     """  for (const [fn, refusal] of origins) if (!refusal) inherited.add(fn);""",
     """  for (const [fn] of origins) inherited.add(fn);"""),

    # ---- a hang costs the function that hung, not the file --------------------- #
    ("js probe: the child answers once at the end, so a kill loses everything",
     "probe.js",
     """  for (const [name, fn] of found) {
    // THE DEFINING FILE'S REFUSAL, CHECKED BEFORE THE FUNCTION IS CALLED. Reaching a
    // function through a barrel must not launder the gate its own file failed; see
    // `dependencyExports`. A `skip` rather than a silent drop, because "we declined to
    // run this" and "there was nothing here" are the two claims this tool exists to
    // keep apart.
    const elsewhere = origins.get(fn);
    if (elsewhere) {
      say({ entry: { name, skip: `defined in a file that ${elsewhere}` } });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    say({
      entry: await probeFunction(fn, name, request.ladders, request.cross === true,
        // A request from an older caller carries no budget; the shared default is
        // then the same number it would have read from this module anyway.
        typeof request.perInput === 'number' ? request.perInput : PER_INPUT_MS),
    });
  }""",
     """  const all = [];
  for (const [name, fn] of found) {
    const elsewhere = origins.get(fn);
    if (elsewhere) {
      all.push({ name, skip: `defined in a file that ${elsewhere}` });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    all.push(await probeFunction(fn, name, request.ladders, request.cross === true,
      typeof request.perInput === 'number' ? request.perInput : PER_INPUT_MS));
  }
  for (const entry of all) say({ entry });"""),
    ("js sameness: a function that never answered is dropped rather than reported",
     "sameness.js",
     """      const functions = roster.roster.map((name) => answered.get(name) || {""",
     """      const functions = [...answered.values()].map((e) => e || {"""),

    # ---- coroutines ---------------------------------------------------------- #
    ("js sameness: a promise is read as an object rather than awaited",
     "sameness.js",
     """    if (value && typeof value.then === 'function') {
      // THE INTERRUPT THAT DOES EXIST.""",
     """    if (false) {
      // THE INTERRUPT THAT DOES EXIST."""),
    ("js sameness: a rejection resolves to its error rather than being an outcome",
     "sameness.js",
     """      value = await Promise.race([value, new Promise((_resolve, reject) => {
        timer = setTimeout(() => {""",
     """      value = await Promise.race([value.catch((e) => e), new Promise((_resolve, reject) => {
        timer = setTimeout(() => {"""),

    # ---- what a pending promise costs ----------------------------------------- #
    ("js sameness: a per-input timeout becomes a VALUE rather than an outcome",
     "sameness.js",
     """          reject(late);""",
     """          _resolve(late);"""),
    ("js probe: the child waits for the event loop to drain again",
     "probe.js",
     """  main().then(
    () => process.exit(0),""",
     """  main().then(
    () => {},"""),

    # ---- the installed command actually runs ---------------------------------- #
    ("js cli: the entry-point check stops resolving symlinks (a shipped defect)",
     "cli.js",
     """    return realpathSync(process.argv[1])
      === realpathSync(fileURLToPath(import.meta.url));""",
     """    return process.argv[1] === fileURLToPath(import.meta.url);"""),

    # ---- the CLI answers for its own version ---------------------------------- #
    ("js cli: `--version` stops answering, so the printed version is unchecked",
     "cli.js",
     """  if (opts.version) {""",
     """  if (false) {"""),

    # ---- the config is judgment, and it is validated -------------------------- #
    ("js config: an exemption without a REASON is accepted",
     "config.js",
     """    for (const field of required) {
      if (!entry[field]) {""",
     """    for (const field of required) {
      if (false) {"""),
    ("js config: a baseline entry in OBJECT form needs no reason",
     "config.js",
     """    for (const field of ['line', 'reason']) {""",
     """    for (const field of ['line']) {"""),
    ("js config: a baseline entry may name a command that cannot produce a finding",
     "config.js",
     """    if (producedBy !== null && !FAMILIES.includes(producedBy)) {""",
     """    if (false) {"""),
    ("js config: an object-form baseline entry stops being read at all",
     "config.js",
     """    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {""",
     """    if (true) {"""),
    ("js config: a stale baseline line stops being reported",
     "config.js",
     """    else if (did.has(entry.producedBy)) stale.push(entry);""",
     """    else if (did.has(entry.producedBy)) unchecked.push(entry);"""),
    ("js config: a line THIS RUN COULD NOT SEE is called stale anyway (cries wolf)",
     "config.js",
     """    else unchecked.push(entry);""",
     """    else stale.push(entry);"""),
    ("js config: an untagged line is called stale by a PARTIAL run",
     "config.js",
     """  const complete = FAMILIES.every((f) => did.has(f));""",
     """  const complete = true;"""),

    # ---- the baseline, and the cry-wolf failure ------------------------------- #
    ("js cli: a command claims it performed every audit (cries wolf at itself)",
     "cli.js",
     """      return finish(report, config, write, opts, ['runners']);""",
     """      return finish(report, config, write, opts,
        ['runners', 'anchors', 'diff', 'scan']);"""),
    ("js cli: `all` without --scan claims it performed the sameness half",
     "cli.js",
     """  return { families, performed };""",
     """  if (!performed.includes('scan')) performed.push('scan');
  return { families, performed };"""),
    ("js cli: `all` stops folding in the sameness half",
     "cli.js",
     """  if (opts.scan.length) {
    await perform('scan', async (rep) => {""",
     """  if (false) {
    await perform('scan', async (rep) => {"""),
    ("js config: writeBaseline drops every OTHER key in the file",
     "config.js",
     """  raw.baseline = baseline;""",
     """  raw = { baseline };"""),
    ("js config: writeBaseline writes a `from` of null rather than none at all",
     "config.js",
     """    if (producedBy) entry.from = producedBy;""",
     """    entry.from = producedBy;"""),
    ("js cli: accept writes a `look` into the baseline (the 0.2.2 defect, automated)",
     "cli.js",
     """        if (report.looks.some((i) => i.message === line)) {""",
     """        if (false) {"""),
    ("js cli: accept writes a line nothing printed, so the entry is born stale",
     "cli.js",
     """        if (!fired.has(line)) {""",
     """        if (false) {"""),
    ("js cli: accept writes an entry with no reason",
     "cli.js",
     """      if (!opts.reason) {""",
     """      if (false) {"""),
    ("js cli: the lines nobody could check are counted as `0 stale`",
     "cli.js",
     """  if (unchecked.length) {
    const why = new Map();""",
     """  if (false) {
    const why = new Map();"""),
]


SUITE_TIMEOUT = 1800

# See the module docstring: a `.pyc` compiled from a mutated module can outlive the
# restore and decide the NEXT run. Handed to both halves because `node` ignores it and
# a second environment to keep in step is a second thing that can fall out of step.
SUITE_ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")


def run_suite(lang):
    """(ran, failures). Positive evidence required, per the property this audits for.

    A SUITE THAT HANGS IS A DID-NOT-RUN, not a crash of this runner. A mutation can
    turn a guard into a wedge rather than a failure — remove the bound on an awaited
    rung and `node --test`, which carries no timeout of its own, waits forever. Letting
    `TimeoutExpired` propagate ends the whole run on the spot, which loses every
    mutation after it AND skips the restore's chance to report; scoring it as a
    detection would be worse still, since a wedged suite is the weakest possible
    evidence and would read as the strongest. It is reported the way every other
    absence of evidence here is.
    """
    try:
        proc = subprocess.run(lang["suite"], capture_output=True, text=True,
                              timeout=SUITE_TIMEOUT, env=SUITE_ENV)
    except subprocess.TimeoutExpired:
        return False, ["DID NOT RUN (the %s suite hung for %ds)"
                       % (lang["name"], SUITE_TIMEOUT)]
    out = proc.stdout + proc.stderr
    if not lang["evidence"].search(out):
        return False, ["DID NOT RUN (%s)"
                       % (out.strip().splitlines() or ["silent"])[-1][:80]]
    return True, lang["failures"](out)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mutations_assay")
    ap.add_argument("--only", default="",
                    help="run only mutations whose label contains this substring")
    args = ap.parse_args(argv)

    # LINE BUFFERED, BECAUSE SILENCE HERE READS AS A HANG. Python switches to an
    # 8KB block buffer the moment stdout is not a terminal, which is every CI log:
    # this run printed nothing for its first 15m49s, then 8190 bytes at once, and a
    # job that shows no output for a quarter of an hour is indistinguishable from a
    # job that never started — the same conflation this whole file is about. One
    # line per mutation is the progress report; it has to leave the process.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:                                    # pragma: no cover
        pass                                                  # Python < 3.7

    table = [m for m in MUTATIONS if args.only.lower() in m[0].lower()]
    if args.only:
        print("PARTIAL RUN — %d of %d mutations match %r; scored against what RAN\n"
              % (len(table), len(MUTATIONS), args.only))
    if not table:
        print("no mutation matches %r" % args.only)
        return 2

    # Keyed by id() so two halves are never collapsed by dict ordering, and sorted by
    # name so the baselines print in a fixed order.
    used = sorted({language(m[1])["name"]: language(m[1]) for m in table}.values(),
                  key=lambda l: l["name"])

    files = sorted({m[1] for m in MUTATIONS})
    originals = {}
    # THE DIGEST IS OF THE BYTES THAT WERE THERE, not of the text they decode to.
    # Hashing the decoded string would agree with itself after a restore that wrote the
    # file back in a different encoding, which is one of the three ways a restore runs
    # and still leaves the tree wrong.
    digests = {}
    for name in files:
        with open(target(name), "rb") as fh:
            raw = fh.read()
        originals[name] = raw.decode("utf-8")
        digests[name] = hashlib.sha256(raw).hexdigest()

    def restore():
        """Put every file back, and then PROVE it came back.

        THE SEVENTH PROPERTY, and it is about this function rather than about the
        `finally` that calls it. `restore-in-finally` proves the restore PATH runs; it
        says nothing about the file on disk. A harness that restores from a buffer read
        after the mutation, or writes the text back in a different encoding, or saves
        one of the two files it touches, satisfies the other six and still leaves work
        proceeding on top of deliberately broken code.

        So the bytes are read back and compared against the digest taken before
        anything was written. A mismatch is announced by name: this is the one failure
        in the run that outlives the run.
        """
        for name, text in originals.items():
            with open(target(name), "w", encoding="utf-8") as fh:
                fh.write(text)
        drop_bytecode()
        wrong = []
        for name in sorted(originals):
            with open(target(name), "rb") as fh:
                if hashlib.sha256(fh.read()).hexdigest() != digests[name]:
                    wrong.append(name)
        if wrong:
            RESTORE_FAILURES.extend(wrong)
            print("RESTORE FAILED — %s did not come back; the tree is LEFT MUTATED "
                  "and every suite after this one scores code nobody wrote"
                  % ", ".join(wrong))
        return wrong

    # SIGTERM does not run `finally`, so a killed runner would leave the tree mutated
    # and work would proceed on top of deliberately broken code.
    def _bail(signum, _frame):
        raise KeyboardInterrupt("signal %d" % signum)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _bail)

    try:
        # BEFORE THE BASELINE, because a `.pyc` left by an earlier run would fail the
        # baseline itself — and this runner then refuses to score anything, pointing
        # at code that is correct in every source file on disk.
        drop_bytecode()
        # A BASELINE PER HALF, and only for the halves this run touches. Scoring a
        # JavaScript mutation against a green Python baseline would be evidence about
        # a suite that was never going to see the mutation — and a `--only` filter
        # that selects one half should not be held up by the other's suite.
        for lang in used:
            ran, base = run_suite(lang)
            if not ran:
                print("BASELINE DID NOT RUN (%s) — refusing to score mutations"
                      % lang["name"])
                return 2
            if base:
                print("baseline FAILURES in %s, refusing to score: %s"
                      % (lang["name"], base[:2]))
                return 2
            print("baseline %s: clean" % lang["name"])
        print()

        detected = 0
        for label, name, old, new in table:
            lang = language(name)
            original = originals[name]
            if original.count(old) != 1:
                print("%-64s TARGET MISSING (%d matches)"
                      % (label[:64], original.count(old)))
                continue
            mutated = original.replace(old, new, 1)
            # THE MUTANT IS WRITTEN BEFORE IT IS CHECKED, which is not an oversight.
            # `node --check` reads module format from the nearest `package.json`, so
            # the only place a `.js` mutant can be parsed honestly is where it lives.
            # The write is therefore inside the same `try` whose `finally` restores —
            # an invalid mutant leaves the tree exactly as clean as a valid one.
            drop_bytecode()
            with open(target(name), "w", encoding="utf-8") as fh:
                fh.write(mutated)
            try:
                # A mutation that breaks the FILE would make the suite fail for the
                # wrong reason and score as a catch — the strongest possible score
                # from the weakest possible mutation.
                why = lang["syntax_error"](target(name), mutated)
                if why:
                    print("%-64s INVALID MUTATION (does not parse: %s)"
                          % (label[:64], why))
                    continue
                ran, fails = run_suite(lang)
            finally:
                restore()
            # The three questions kept separate: did it RUN, did it FAIL, and was the
            # failure the RIGHT one. Collapsing any two is how this family of defects
            # happens.
            dead = [x for x in fails if "DID NOT RUN" in x]
            real = [x for x in fails if x not in dead]
            if dead and not real:
                print("%-64s INVALID MUTATION (%s)" % (label[:64], dead[0][:40]))
                continue
            detected += bool(real)
            print("%-64s %s" % (label[:64],
                                ("CAUGHT  " + real[0][:36]) if real else "NOT DETECTED"))
        print("\n%d/%d mutations detected" % (detected, len(table)))
        # A FAILED RESTORE OUTRANKS THE SCORE. A perfect tally over a tree that did not
        # come back is a tally about a file that is no longer the file, and reporting
        # it as a pass is the exact shape this runner audits for.
        if RESTORE_FAILURES:
            return 2
        return 0 if detected == len(table) else 1
    finally:
        restore()


# Filled in by `restore()` when the bytes it wrote back are not the bytes it saved.
# A module-level list because the LAST restore runs in `main`'s `finally`, after the
# return value above has already been computed — so a failure there has to be folded
# in below or it prints loudly and exits 0.
RESTORE_FAILURES = []


if __name__ == "__main__":
    _code = main()
    sys.exit(2 if RESTORE_FAILURES else _code)
