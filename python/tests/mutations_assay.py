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

This runner is also a SUBJECT of `assay runners` and carries all six properties it
audits for: positive evidence a suite RAN, a dead-vs-real partition before any
counting, restore in a `finally`, SIGTERM turned into an exception (SIGTERM does not
run `finally`), an `ast.parse` guard so a mutation that breaks the file is not scored
as a catch, and no scratch state written into the tree.

    python3 mutations_assay.py              # the whole table
    python3 mutations_assay.py --only same  # substring filter (PARTIAL RUN)
"""

import argparse
import ast
import glob
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


# (label, file, old, new)
MUTATIONS = [
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
            value = asyncio.run(value)""",
     """        if False:
            value = asyncio.run(value)"""),

    # ---- comparison, and the wrong-baseline defect -------------------------- #
    ("sameness: two different ladders are zipped together",
     "sameness.py",
     '''    if a_key != b_key:
        return "look", "not comparable: %s vs %s" % (a_key, b_key)''',
     '''    if False:
        return "look", "not comparable: %s vs %s" % (a_key, b_key)'''),
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
     '''    skip = {os.path.realpath(os.path.join(root, rel)) for rel in runners}''',
     '''    skip = set()'''),
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
                found.append(parts[-2].value)''',
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
                found.append(parts[-2].value)'''),

    # ---- config, read in both directions -------------------------------------- #
    ("config: broken JSON becomes an empty config rather than an error",
     "config.py",
     '''    except ValueError as exc:
        raise ConfigError("%s is not valid JSON (%s)" % (path, exc))''',
     '''    except ValueError:
        return Config()'''),
    ("config: an exemption without a reason is accepted",
     "config.py",
     '''            if not entry.get(field):''',
     '''            if False:'''),
    ("config: a stale baseline line stops being reported",
     "config.py",
     '''    stale = sorted(known - seen)''',
     '''    stale = []'''),
    ("config: the baseline matches on a prefix rather than the exact message",
     "config.py",
     '''    still = [f for f in findings if f.message not in known]''',
     '''    still = [f for f in findings
             if not any(f.message.startswith(k) for k in known)]'''),
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
     '''            out.write("assay: cannot resolve %s\\n" % ref)
            return 2''',
     '''            out.write("assay: cannot resolve %s\\n" % ref)
            return 0'''),
    ("cli: a `differs` verdict is reported as a finding",
     "cli.py",
     '''        report.ok("differs: %s — %s" % (pair, detail), first.ref)''',
     '''        report.finding("differs: %s — %s" % (pair, detail), first.ref)'''),
    ("cli: a PARTIAL run calls a baseline entry stale (cries wolf at itself)",
     "cli.py",
     '''        if complete:
            for line in stale:''',
     '''        if True:
            for line in stale:'''),
    ("cli: `all` stops folding in the sameness half",
     "cli.py",
     '''    scanned = getattr(args, "scan", None)
    if scanned:''',
     '''    scanned = None
    if scanned:'''),
    ("cli: a broken config is ignored rather than exiting 2",
     "cli.py",
     '''    except ConfigError as exc:
        out.write("assay: %s\\n" % exc)
        return 2''',
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
    # ---- a snippet's function is never guessed at ---------------------------- #
    ("js cli: an ambiguous snippet silently picks a function instead of refusing",
     "cli.js",
     """  } else if (roster.length > 1) {""",
     """  } else if (false) {"""),
    ("js cli: a snippet is allowed to import from the tree",
     "cli.js",
     """  if (relativeSpecifiers(text).length) {""",
     """  if (false) {"""),
    # ---- one function object is one function -------------------------------- #
    ("js probe: two names for ONE function object are a pair again (a shipped defect)",
     "probe.js",
     """    if (typeof value !== 'function' || seen.has(value)) return;""",
     """    if (typeof value !== 'function') return;"""),
    ("js probe: a barrel re-export duplicates its helper again (a shipped defect)",
     "probe.js",
     """  const seen = new Set(inherited);""",
     """  const seen = new Set();"""),

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
     """  if (new Set(returned).size < MIN_DISTINCT) return null;""",
     """  if (false) return null;"""),
    ("js sameness: the projection guard stops being consulted",
     "sameness.js",
     """  if (inputs && isProjection(vector, inputs)) return null;""",
     """  if (false) return null;"""),
    ("js sameness: two different ladders are zipped together",
     "sameness.js",
     """  if (aKey !== bKey) return ['look', `not comparable: ${aKey} vs ${bKey}`];""",
     """  if (false) return ['look', `not comparable: ${aKey} vs ${bKey}`];"""),

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

    # ---- a hang costs the function that hung, not the file --------------------- #
    ("js probe: the child answers once at the end, so a kill loses everything",
     "probe.js",
     """  for (const [name, fn] of found) {
    // eslint-disable-next-line no-await-in-loop
    say({ entry: await probeFunction(fn, name, request.ladders) });
  }""",
     """  const all = [];
  for (const [name, fn] of found) {
    // eslint-disable-next-line no-await-in-loop
    all.push(await probeFunction(fn, name, request.ladders));
  }
  for (const entry of all) say({ entry });"""),
    ("js sameness: a function that never answered is dropped rather than reported",
     "sameness.js",
     """      const functions = roster.roster.map((name) => answered.get(name) || {""",
     """      const functions = [...answered.values()].map((e) => e || {"""),

    # ---- coroutines ---------------------------------------------------------- #
    ("js sameness: a promise is read as an object rather than awaited",
     "sameness.js",
     """    if (value && typeof value.then === 'function') {""",
     """    if (false) {"""),
    ("js sameness: a rejection resolves to its error rather than being an outcome",
     "sameness.js",
     """      value = await Promise.race([value, new Promise((_resolve, reject) => {""",
     """      value = await Promise.race([value.catch((e) => e), new Promise((_resolve, reject) => {"""),

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

    # ---- the config is judgment, and it is validated -------------------------- #
    ("js config: an exemption without a REASON is accepted",
     "config.js",
     """      if (!entry[field]) {""",
     """      if (false) {"""),

    # ---- the baseline, and the cry-wolf failure ------------------------------- #
    ("js cli: a PARTIAL run calls a baseline entry stale (cries wolf at itself)",
     "cli.js",
     """    const [still] = applyBaseline(report.findings, config.baseline);
    const accepted = report.findings.length - still.length;
    report.items = report.items.filter((i) => i.verdict !== FINDING).concat(still);""",
     """    const [still, stale] = applyBaseline(report.findings, config.baseline);
    const accepted = report.findings.length - still.length;
    report.items = report.items.filter((i) => i.verdict !== FINDING).concat(still);
    for (const line of stale) report.finding(`no longer fires: ${line}`);"""),
]


SUITE_TIMEOUT = 1800


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
                              timeout=SUITE_TIMEOUT)
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
    for name in files:
        with open(target(name), encoding="utf-8") as fh:
            originals[name] = fh.read()

    def restore():
        for name, text in originals.items():
            with open(target(name), "w", encoding="utf-8") as fh:
                fh.write(text)

    # SIGTERM does not run `finally`, so a killed runner would leave the tree mutated
    # and work would proceed on top of deliberately broken code.
    def _bail(signum, _frame):
        raise KeyboardInterrupt("signal %d" % signum)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _bail)

    try:
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
        return 0 if detected == len(table) else 1
    finally:
        restore()


if __name__ == "__main__":
    sys.exit(main())
