#!/usr/bin/env python3
"""Mutation runner for assay — does its own suite notice when a guard breaks?

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
import os
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SUITE = [sys.executable, os.path.join(HERE, "run_tests.py")]
# A suite has RUN only if this appears. "No failures" and "no test executed" are
# different things, and conflating them is the first property this tool audits for.
EVIDENCE = "tests, "


def target(name):
    return os.path.join(ROOT, "assay", name)


# (label, file, old, new)
MUTATIONS = [
    # ---- the vacuous-probe guard ------------------------------------------- #
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
     '''        if name.endswith((".py", ".js")) and name not in changed:
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
    ("anchors: a label short enough to be prose is taken as an anchor",
     "anchors.py",
     '''                if len(value) > 12 and ("\\n" in value or " " in value
                                        or "(" in value):''',
     '''                if True:'''),

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


def run_suite():
    """(ran, failures). Positive evidence required, per the property this audits for."""
    proc = subprocess.run(SUITE, capture_output=True, text=True, timeout=1800)
    out = proc.stdout + proc.stderr
    if EVIDENCE not in out:
        return False, ["DID NOT RUN (%s)"
                       % (out.strip().splitlines() or ["silent"])[-1][:80]]
    fails = [l.strip() for l in out.splitlines() if l.startswith(("FAIL:", "ERROR:"))]
    return True, fails


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
        ran, base = run_suite()
        if not ran:
            print("BASELINE DID NOT RUN — refusing to score mutations")
            return 2
        if base:
            print("baseline FAILURES, refusing to score: %s" % base[:2])
            return 2
        print("baseline: clean\n")

        detected = 0
        for label, name, old, new in table:
            original = originals[name]
            if original.count(old) != 1:
                print("%-64s TARGET MISSING (%d matches)"
                      % (label[:64], original.count(old)))
                continue
            mutated = original.replace(old, new, 1)
            # A mutation that breaks the FILE would make the suite fail for the wrong
            # reason and score as a catch — the strongest possible score from the
            # weakest possible mutation.
            try:
                ast.parse(mutated)
            except SyntaxError as exc:
                print("%-64s INVALID MUTATION (does not parse: %s)" % (label[:64], exc))
                continue
            with open(target(name), "w", encoding="utf-8") as fh:
                fh.write(mutated)
            try:
                ran, fails = run_suite()
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
