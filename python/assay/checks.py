"""Audit the CHECKS, not the code — could those tests have failed?

Ordinary CI answers *did the tests pass*. Almost nothing answers the question that
sits one level up, and it is the question that hides the most defects:

    could those tests have failed?

A suite that crashed before its first assertion reports no failures. A harness that
counts "the suite did not run" as "the suite caught it" reports a perfect score. A
guard added without anything exercising it is a green build over untested code. Each
of these looks exactly like success, and each has to be found by asking a different
question than the one CI asks.

WHAT THIS DELIBERATELY DOES NOT DO. It does not review code. It cannot tell you an
abstraction is wrong, a name is misleading, or an edge case is unhandled. Pretending
otherwise would make it the kind of instrument it exists to catch: one whose output is
trusted past what it measured.

THE SEVEN PROPERTIES are about MUTATION RUNNERS — harnesses that deliberately break the
code and check that something notices. If you run one, these are the ways it can lie
to you. If you do not, this half has nothing to say about your project and the other
half (`assay.sameness`) still does.

Each detector answers "is the TELL present", never "is this code correct". A
structural search tells you where to look and every hit still has to be read, which is
why a miss is a finding to inspect rather than a verdict handed down.
"""

import ast
import os
import re
import subprocess

from .verdicts import Report

RUNNER_PREFIX = "mutations"
SKIP_DIRS = {"node_modules", "__pycache__", "venv", ".venv", "dist", "build"}


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #

def find_runners(root, prefix=RUNNER_PREFIX):
    """Every `mutations*.py` under root, as paths RELATIVE to root, sorted.

    Discovery is a walk rather than a list, on purpose. A list of harnesses to audit
    is one more table that can go stale, and the harness nobody added to the list is
    exactly the one that has been asleep the longest.
    """
    out = []
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs
                         if not d.startswith(".") and d not in SKIP_DIRS)
        for name in sorted(files):
            if name.startswith(prefix) and name.endswith(".py"):
                out.append(os.path.relpath(os.path.join(base, name), root))
    return sorted(out)


# --------------------------------------------------------------------------- #
# The seven properties
# --------------------------------------------------------------------------- #

def _has(src, *needles):
    return any(n in src for n in needles)


def _assigns(tree, *names):
    """Does the module assign every one of `names` anywhere? (AST, not text.)"""
    seen = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = (node.targets if isinstance(node, ast.Assign)
                       else [node.target])
            for target in targets:
                if isinstance(target, ast.Name):
                    seen.add(target.id)
    return all(n in seen for n in names)


def _requires_named_section(src):
    """The OTHER way to satisfy both partition properties.

    A runner can require the failure to appear in a NAMED section and report WRONG
    when it appears anywhere else. That makes a crashed suite impossible to score as a
    detection without any partition and without parsing the mutant — the property is
    met by a different mechanism rather than missing. Encoding the alternative is what
    keeps a structural detector from punishing a stronger design than the one it knows.
    """
    return "WRONG" in src and _has(src, "wanted", "section")


def _p_evidence(src, tree):
    """Positive proof each suite RAN, not merely that it did not fail.

    No failures reported is indistinguishable from no test executed, so a crashed
    suite reads as a clean baseline and every mutation after it scores as caught.
    """
    return _has(src, "EVIDENCE", "DID NOT RUN", "did not run", "DID_NOT_RUN")


def _p_dead(src, tree):
    """A DID-NOT-RUN entry must not be counted as a detection.

    THE FIRST VERSION OF THIS DETECTOR WAS WRONG, and it is worth knowing before you
    trust the rest. It looked for `detected += bool(...)` as the shape of the defect —
    but the FIXED code reads `detected += bool(real)`, so the detector fired on
    harnesses that had already been repaired. An observable that the broken and the
    correct version both produce is precisely the failure this tool exists to catch,
    arriving inside the tool built to catch it.

    The real tell is whether failures are PARTITIONED before being counted.
    """
    if _assigns(tree, "dead", "real"):
        return True
    return _requires_named_section(src)


def _p_finally(src, tree):
    """The restore lives in a `finally`, so an exception cannot leave code mutated."""
    return "finally:" in src


def _p_sigterm(src, tree):
    """SIGTERM turned into an exception, because SIGTERM does not run `finally`.

    This is the one people are surprised by. A `finally` block protects you from
    exceptions and from nothing else, so a harness that takes a plain `kill` or a CI
    cancel mid-run leaves every mutation it had applied sitting in your working tree.
    Work then proceeds on top of deliberately broken code, and nothing says so.

    SIGKILL IS NOT IN THIS PROPERTY'S REACH, and that belongs here rather than in
    whichever tree discovers it. SIGKILL cannot be caught, blocked or handled: no
    handler runs, no `finally` runs, and nothing this check could look for would have
    helped. THE ORDINARY WAY TO BE SIGKILLED IS A TIMEOUT rather than an impatient
    person — `subprocess.run(..., timeout=...)` kills the child outright, and so does
    the kill step of a CI runner that has waited long enough. A harness satisfying all
    seven properties, invoked under a timeout it then exceeds, leaves the tree mutated
    exactly as though it carried none of them.

    SO THE REMEDY FOR THAT CASE IS NOT IN THE HARNESS AND CANNOT BE. It belongs to
    whatever INVOKED the harness, which has to check that the tree came back rather
    than trust that the harness was given the chance to put it back. `restore-verified`
    is the same argument one level down — a restore that ran is not a restore that
    worked — and this is a restore that never ran at all.
    """
    return "SIGTERM" in src


def _p_parses(src, tree):
    """A mutated source is parsed before it is run, OR a crash cannot score.

    Otherwise a mutation that breaks the file syntactically makes every suite fail,
    and the harness records a detection for entirely the wrong reason — the strongest
    possible score from the weakest possible mutation.
    """
    return _has(src, "ast.parse", "compile(") or _requires_named_section(src)


def _p_no_tree_writes(src, tree):
    """No scratch state written beside the code under test.

    Restoring the file you EDITED is not the invariant; leaving no scratch state in
    the working tree is. A harness that restores its target and lets the suite it runs
    write results into a tracked file leaves the tree looking clean while a committed
    artifact records the behaviour of deliberately broken code.
    """
    return not re.search(r"os\.path\.join\(\s*HERE\s*,\s*[\"'][^\"']+\.(json|tsv|db|"
                         r"jsonl|txt)[\"']", src)


# THE TELLS ARE NAMED CONSTANTS because both halves must accept the same harness. A
# `.py` harness is audited by this half and a `.js` one by the other, so a tell present
# in one list and absent from the other means a correct harness passes in one language
# and is a finding in the other — one config, two verdicts, which is the drift
# `test_parity.py` exists to stop. Both spellings of the failure name are here for the
# same reason: `restore_failed` is what a Python harness writes and `restoreFailed` is
# what a JavaScript one writes, and neither is wrong.
DIGEST_TELLS = ("hexdigest", ".digest(", "sha256", "sha1", "sha512", "md5",
                "createHash")
RESTORE_FAILURE_TELLS = ("RESTORE FAILED", "NOT RESTORED", "restore_failed",
                         "restoreFailed", "did not come back")


def _p_restore_verified(src, tree):
    """The tree CAME BACK — proved, rather than assumed because the restore ran.

    `restore-in-finally` proves the restore PATH EXECUTES. It does not prove the file
    on disk is the file that was there before, and the gap is not theoretical: a
    harness that restores from a buffer it read after mutating, that writes the text
    back in a different encoding, or that saved one of the two files it touches,
    satisfies all six of the properties above and still leaves the tree wrong. Every
    suite after that one runs against code nobody wrote, and the score it prints is a
    score for something else.

    THE TELL IS A DIGEST TAKEN BEFORE AND COMPARED AFTER, plus a name for the failure
    when the two disagree. Neither half alone is the check: a digest nothing compares
    is arithmetic, and a message nothing computes is a string. It is the same
    RAN / FAILED / RIGHT-FAILURE collapse the other six are instances of, one level
    out — "the restore ran" and "the restore worked" are different claims.
    """
    digested = _has(src, *DIGEST_TELLS)
    return digested and _has(src, *RESTORE_FAILURE_TELLS)


PROPERTIES = [
    ("evidence", "positive proof each suite RAN",
     "no failures reported and no test executed look identical", _p_evidence),
    ("dead-vs-real", "a DID-NOT-RUN is not a detection",
     "counting any failure scores a crash as a catch", _p_dead),
    ("restore-in-finally", "the restore cannot be skipped by an exception",
     "an exception mid-run leaves the target mutated", _p_finally),
    ("sigterm", "SIGTERM becomes an exception so `finally` runs",
     "SIGTERM does not run `finally`; a kill leaves the tree broken", _p_sigterm),
    ("parses-mutant", "a file-breaking mutation is not scored",
     "a syntax error makes every suite fail, which reads as a catch", _p_parses),
    ("no-tree-writes", "no scratch state beside the code under test",
     "a clean target is not a clean tree", _p_no_tree_writes),
    ("restore-verified", "the tree is PROVED to have come back",
     "a restore that ran is not a restore that worked", _p_restore_verified),
]

PROPERTY_KEYS = frozenset(k for k, _d, _w, _f in PROPERTIES)

# The rule the seven collapse into, worth stating on its own because it is the
# generalisation and the seven are instances: A HARNESS MUST BE ABLE TO ANSWER
# SEPARATELY WHETHER THE SUITE RAN, WHETHER IT FAILED, AND WHETHER THE FAILURE WAS THE
# RIGHT ONE. Collapsing any two of those three is how every defect in this family
# happens.
THREE_QUESTIONS = ("a harness must answer separately whether the suite RAN, whether "
                   "it FAILED, and whether the failure was the RIGHT one")


def audit_runners(root, config, report=None):
    """Every mutation runner against the seven properties."""
    rep = report or Report()
    rels = find_runners(root)
    if not rels:
        rep.note("MUTATION RUNNERS — none found under %s.\n"
                 "  Nothing to audit here, which is not the same as nothing wrong.\n"
                 "  If this project has no mutation harness, `assay scan` is the half\n"
                 "  that still applies to it." % root)
        return rep
    rep.note("MUTATION RUNNERS — seven properties, each a way a harness can lie\n")
    for key, desc, why, _det in PROPERTIES:
        rep.note("  %-20s %-46s %s" % (key, desc, why))
    rep.note("\n  the rule they collapse into: %s\n" % THREE_QUESTIONS)

    for rel in rels:
        path = os.path.join(root, rel)
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        try:
            tree = ast.parse(src)
        except SyntaxError as exc:
            rep.finding("%s does not parse (%s)" % (rel, exc), rel)
            continue
        missing = []
        for key, _desc, why, det in PROPERTIES:
            if det(src, tree):
                continue
            if config.exempt_runner(rel, key):
                continue
            missing.append((key, why))
        if missing:
            for key, why in missing:
                rep.finding("%s: no `%s` (%s)" % (rel, key, why), rel)
        else:
            rep.ok(rel, rel)
    for (rel, key), why in sorted(config.runner_exempt.items()):
        rep.note("  exempt   %-46s %s: %s" % (rel, key, why[:60]))
    return rep


def check_exemptions(root, config, report=None):
    """An exemption naming something that no longer exists is a finding.

    The second direction. Without it the file only ever grows.
    """
    rep = report or Report()
    for (rel, key), _why in sorted(config.runner_exempt.items()):
        if not os.path.exists(os.path.join(root, rel)):
            rep.finding("exemption names a runner that no longer exists: %s" % rel, rel)
        if key != "*" and key not in PROPERTY_KEYS:
            rep.finding("exemption names an unknown property: %s (%s)" % (key, rel),
                        rel)
    for rel, _why in sorted(config.anchor_exempt.items()):
        if not os.path.exists(os.path.join(root, rel)):
            rep.finding("anchor exemption names a file that no longer exists: %s" % rel,
                        rel)
    return rep


# --------------------------------------------------------------------------- #
# Auditing a CHANGE
# --------------------------------------------------------------------------- #
FILE_RE = re.compile(r"[\w./-]+\.(?:py|js|mjs|cjs|ts)")
# A line that REFUSES, RETURNS EARLY or RAISES is a guard. A guard with nothing
# exercising it is a fix you cannot prove you made.
GUARD_RE = re.compile(r"^\+\s*(?:if\b.*:|return\s+\d|raise\b|sys\.exit\()")
# Tests named for a LIMITATION go stale the moment the limitation lifts: the day the
# capability arrives, a correct change turns a green check red and the check is what
# looks broken.
LIMIT_RE = re.compile(r"def (test_\w*(?:no_|not_|cannot|unsupported|drops|"
                      r"falls_back|refus|reject)\w*)")


# The extensions BOTH halves treat as source. `.mjs` and `.cjs` are here because the
# JavaScript half already audited them and this one did not: the same commit, audited
# by the two binaries, produced two different file lists and neither said so. `.js` was
# always in this list, so auditing JavaScript was never the question — only which
# JavaScript. Pinned against the JavaScript half in `test_parity.py`.
SOURCE_SUFFIXES = (".py", ".js", ".mjs", ".cjs")


def _git(root, *args):
    proc = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)
    return proc.returncode, proc.stdout


def target_mentions(src):
    """Every file-like token a harness names, AS WRITTEN — paths kept."""
    return {m.group(0) for m in FILE_RE.finditer(src)}


def targets_mentioned(src):
    """Basenames a harness names, i.e. what it plausibly targets.

    Deliberately a MENTION rather than a resolved path: harness tables reach their
    targets through module constants built with `os.path.join`, and resolving those
    statically is more machinery than the question needs. The failure mode is stated
    rather than hidden — a harness that merely mentions a file counts as covering it,
    so this UNDER-reports missing coverage and never over-reports it. An audit that
    errs should err toward saying less.

    THAT REASONING ONLY COVERS ONE OF THE TWO BRANCHES THIS FEEDS, which is how it
    came to over-report. Under-attributing an owner makes `diff` say `look` — a
    missing check, advisory. OVER-attributing one makes it say `finding` — a failing
    check — about a file the named harness has never touched. The two branches have
    opposite error tolerances and shared one attribution set. `owns()` is the
    stronger test the finding branch needs; this function is unchanged for callers
    that want the loose one.
    """
    return {os.path.basename(t) for t in target_mentions(src)}


def owns(runner_rel, target_rel, mentions):
    """Does RUNNER plausibly target TARGET, rather than merely containing its name?

    A bare basename is not an identifier. It was attributing every generated
    `tax.py` in a corpus of candidate programs to a harness in a different
    experiment whose only mention of the name was inside a quoted markdown fixture
    — a fixture, in a string, about a different file with the same basename.

    Two ways to own a file, and both are about REACH:

      * an explicit PATH mention (`tools/pycomplete/pycomplete.py`), which
        identifies the file wherever the harness lives; or
      * a bare basename AND the file sitting in the harness's own directory or
        below it — the only place a harness that builds paths with `os.path.join`
        on its own `HERE` can reach.

    A harness at the audited ROOT owns only files at the root, not the whole tree:
    "everything below me" is the entire audit when `dirname` is empty, which is the
    over-attribution again with one extra step.
    """
    target = target_rel.replace(os.sep, "/")
    for tok in mentions:
        t = tok.replace(os.sep, "/").lstrip("./")
        if "/" in t and (target == t or target.endswith("/" + t)):
            return True
    if os.path.basename(target) not in {os.path.basename(t) for t in mentions}:
        return False
    rdir = os.path.dirname(runner_rel.replace(os.sep, "/"))
    tdir = os.path.dirname(target)
    return tdir == rdir or (bool(rdir) and tdir.startswith(rdir + "/"))


def changed_files(root, base):
    """(files, error). Paths relative to ROOT, including unstaged work.

    THE PATH BASIS IS THE WHOLE FUNCTION. `git diff --name-only` reports paths
    relative to the GIT TOPLEVEL, while the harness walk yields paths relative to the
    ROOT you audited. When the code lives in a subdirectory those two never match, and
    every comparison between them is silently False — which does not look like a bug,
    it looks like a clean audit.

    BOTH SIDES ARE REALPATH'D FIRST, and that is not belt-and-braces. `show-toplevel`
    resolves symlinks and the root you were handed usually does not, so on any system
    where a parent directory is a symlink — every macOS temp directory, for one — the
    two disagree about a path that names the same file, and the relative path between
    them climbs out of the tree entirely. Same silent-False failure, arriving through
    the filesystem instead of the argument.
    """
    rc, names = _git(root, "diff", "--name-only", "%s...HEAD" % base)
    if rc != 0:
        rc, names = _git(root, "diff", "--name-only", base)
    if rc != 0:
        return [], "cannot diff against %s — is it a valid ref?" % base
    changed = [n for n in names.split() if n.endswith(SOURCE_SUFFIXES)]
    _rc, unstaged = _git(root, "status", "--porcelain")
    for line in unstaged.splitlines():
        name = line[3:].strip()
        if name.endswith(SOURCE_SUFFIXES) and name not in changed:
            changed.append(name)
    rc_top, top = _git(root, "rev-parse", "--show-toplevel")
    if rc_top == 0 and top.strip():
        top, real_root = os.path.realpath(top.strip()), os.path.realpath(root)
        changed = [os.path.relpath(os.path.join(top, c), real_root) for c in changed]
    return changed, None


def guards_per_file(root, base):
    """Guard-shaped added lines, PER FILE.

    Computing this once over the whole patch makes a guard added in one file look like
    an unguarded change in every OTHER file in the same commit. Findings must be about
    the file they name.

    TWO PATCHES, UNIONED, because one of them structurally cannot see half the work.
    `base...HEAD` is committed history since the merge base and contains nothing you
    have not committed yet; `HEAD` alone is the working tree. Reading only the first
    means a guard you just wrote is invisible, so the finding can never fire on a dirty
    tree — which is exactly when someone runs this. The file list is gathered the same
    way for the same reason; the two must agree about what "changed" means or the
    comparison between them is meaningless.
    """
    patch = ""
    for args in (("diff", "-U0", "%s...HEAD" % base), ("diff", "-U0", "HEAD")):
        rc, text = _git(root, *args)
        if rc == 0:
            patch += text
    rc_top, top = _git(root, "rev-parse", "--show-toplevel")
    top = os.path.realpath(top.strip()) if rc_top == 0 and top.strip() else ""
    real_root = os.path.realpath(root)
    per_file, cur = {}, None
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            cur = line.rsplit(" b/", 1)[-1] if " b/" in line else None
            if cur and top:
                cur = os.path.relpath(os.path.join(top, cur), real_root)
        elif cur and line.startswith("+") and GUARD_RE.match(line):
            per_file.setdefault(cur, []).append(line)
    return per_file


def audit_diff(root, base, config, report=None):
    """Does this change carry the checks it needs?"""
    rep = report or Report()
    changed, error = changed_files(root, base)
    if error:
        rep.finding(error)
        return rep
    if not changed:
        rep.note("\nCHANGE — no source files changed against %s" % base)
        return rep

    runners = {}
    for rel in find_runners(root):
        with open(os.path.join(root, rel), encoding="utf-8") as fh:
            runners[rel] = fh.read()
    covers = {rel: target_mentions(src) for rel, src in runners.items()}
    per_file = guards_per_file(root, base)

    rep.note("\nCHANGE — %d source file(s) against %s" % (len(changed), base))
    for name in changed:
        base_name = os.path.basename(name)
        if base_name.startswith(RUNNER_PREFIX) or base_name.startswith("test_"):
            continue
        # A DELETED file needs no check, and saying otherwise is the crying-wolf
        # failure at its most annoying: a commit that removes a directory reports one
        # `look` per file removed, all of them advice about code that is gone. Found
        # by a repository converting a subdirectory into a submodule — the diff lists
        # every file as deleted, and the audit had opinions about all of them.
        if not os.path.exists(os.path.join(root, name)):
            continue
        owning = sorted(r for r, t in covers.items() if owns(r, name, t))
        if not owning:
            rep.look("%s has NO mutation runner naming it — a missing check is a "
                     "stronger signal than a failing one" % name, name)
            continue
        grew = any(r in changed for r in owning)
        if per_file.get(name) and not grew:
            rep.finding("%s adds a guard and no runner that names it grew a mutation "
                        "(%s) — a fix with nothing exercising it is a fix you cannot "
                        "prove you made" % (name, ", ".join(owning)), name)
        else:
            rep.ok("%-44s covered by %s" % (name, ", ".join(owning)), name)

    for name in changed:
        path = os.path.join(root, name)
        if not os.path.exists(path) or not name.endswith(".py"):
            continue
        with open(path, encoding="utf-8") as fh:
            stale = LIMIT_RE.findall(fh.read())
        # `covers` holds mentions AS WRITTEN now, so this must project to basenames
        # rather than test membership directly — it was a basename set before
        # `owns()` needed the paths, and leaving it would have silently stopped
        # matching every harness that names its target with a directory.
        if stale and any(os.path.basename(name) in {os.path.basename(x) for x in t}
                         for t in covers.values()):
            rep.look("%s carries %d limitation-shaped test(s) (%s...) — the day that "
                     "limitation lifts, a correct change turns those green checks red"
                     % (name, len(stale), stale[0][:44]), name)
    return rep
