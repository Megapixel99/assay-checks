#!/usr/bin/env python3
"""Run the conformance suite: every framework, every probe, one table.

Each framework gets a pinned image and a fresh container per probe, so every
probe starts from the same pristine fixture and no run can be contaminated by
the one before it. The probe itself runs inside the container -- see probe.py
for why the kill is timed on an observation rather than on a stopwatch.

    python3 conformance/run.py                 # everything
    python3 conformance/run.py mutmut stryker  # named frameworks
    python3 conformance/run.py --no-build      # reuse images already built
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMEWORKS = os.path.join(HERE, "frameworks")
FIXTURES = os.path.join(HERE, "fixtures")
RESULTS = os.path.join(HERE, "results")
MARKER = "__PROBE_JSON__"

# The three runs. `baseline` is the control: what an uninterrupted run leaves
# behind. The other two ask the question the seven properties stop short of.
PROBES = [
    ("baseline", "none", "group", "an uninterrupted run, start to finish"),
    ("sigterm-leader", "term", "leader", "SIGTERM to the process we started -- what `timeout` sends"),
    ("sigterm", "term", "group", "SIGTERM to the whole group -- a CI cancel, or Ctrl-C"),
    ("sigkill", "kill", "group", "SIGKILL, which no property in the table can reach"),
]


def load(names):
    out = []
    for entry in sorted(os.listdir(FRAMEWORKS)):
        path = os.path.join(FRAMEWORKS, entry, "framework.json")
        if not os.path.isfile(path):
            continue
        with open(path) as fh:
            spec = json.load(fh)
        spec["dir"] = os.path.join(FRAMEWORKS, entry)
        if not names or spec["name"] in names:
            out.append(spec)
    missing = set(names) - {s["name"] for s in out}
    if missing:
        sys.exit("no such framework: %s" % ", ".join(sorted(missing)))
    return out


def build(spec, quiet):
    """Assemble a context of Dockerfile + fixture + probe, and build."""
    tag = "assay-conformance-%s" % spec["name"]
    ctx = tempfile.mkdtemp(prefix="conformance-ctx-")
    try:
        shutil.copytree(
            os.path.join(FIXTURES, spec["fixture"]), os.path.join(ctx, "fixture")
        )
        shutil.copy(os.path.join(HERE, "probe.py"), ctx)
        shutil.copy(os.path.join(spec["dir"], "Dockerfile"), ctx)
        for extra in spec.get("copy", []):
            shutil.copy(os.path.join(spec["dir"], extra), ctx)
        cmd = ["docker", "build", "-t", tag, ctx]
        if quiet:
            cmd.insert(2, "-q")
        proc = subprocess.run(cmd, capture_output=quiet, text=True)
        if proc.returncode != 0:
            return None, (proc.stderr or "")[-2000:]
        return tag, None
    finally:
        shutil.rmtree(ctx, ignore_errors=True)


def probe(tag, spec, label, sig, target, fallback=0.0):
    # The probe is mounted rather than taken from the image, so --no-build can
    # never run a stale copy of it. The Dockerfile still COPYs it, which keeps
    # each image runnable on its own.
    argv = ["docker", "run", "--rm", "--init",
            "-v", "%s:/probe.py:ro" % os.path.join(HERE, "probe.py")]
    for key, value in sorted(spec.get("env", {}).items()):
        argv += ["-e", "%s=%s" % (key, value)]
    argv += [tag, "python3", "/probe.py",
            "--label", label, "--signal", sig, "--signal-target", target,
            "--deadline", str(spec.get("deadline", 300)),
            "--fallback-after", "%.2f" % fallback]
    for pattern in spec["watch"]:
        argv += ["--watch", pattern]
    argv += ["--"] + spec["command"]

    proc = subprocess.run(argv, capture_output=True, text=True, timeout=1800)
    for line in proc.stdout.splitlines():
        if line.startswith(MARKER):
            return json.loads(line[len(MARKER):])
    return {
        "label": label,
        "error": "the probe produced no report",
        "docker_exit": proc.returncode,
        "output_tail": (proc.stdout + proc.stderr)[-2000:],
    }


def scratch_roots(result):
    """Top-level paths a run added or changed outside the code under test."""
    tree = result.get("tree_after") or {}
    return sorted({p.split("/")[0] for p in tree.get("added", []) + tree.get("modified", [])})


def verdict(result, expected=()):
    """The one line that matters, in the order the failures matter."""
    if "error" in result:
        return "ERROR", result["error"]
    modified = result["source_after"]["modified"]
    deleted = result["source_after"]["deleted"]
    if modified or deleted:
        return "DIRTY", "left mutated: %s%s" % (", ".join(modified + deleted),
                                               _orphan_note(result))
    added = result["tree_after"]["added"]
    other = result["tree_after"]["modified"]
    trigger = (result.get("signal_delivered") or {}).get("reason", "")
    if added or other:
        roots = scratch_roots(result)
        undocumented = [r for r in roots if r not in set(expected)]
        tail = ""
        if undocumented:
            # `no-tree-writes` is about scratch state the framework did not say
            # it would leave. What its own docs promise is a different claim.
            tail = " (undocumented: %s)" % ", ".join(undocumented)
        return "SCRATCH", "clean source, %d path(s) left behind: %s%s%s" % (
            len(added) + len(other), ", ".join(roots), tail,
            _how(trigger) + _orphan_note(result))
    return "CLEAN", "tree identical to pristine" + _how(trigger) + _orphan_note(result)


def _orphan_note(result):
    """A verdict measured only after orphaned processes finished is a weaker claim."""
    if not result.get("orphans_outlived_leader"):
        return ""
    return "  [orphans outlived the leader; group went quiet after %s]" % (
        result.get("group_quiet_after"))


def _how(trigger):
    """Whether the kill landed on a mutant or merely somewhere in the run."""
    if not trigger:
        return ""
    if trigger.startswith("source file observed"):
        return "  [killed ON a live mutant]"
    if trigger.startswith("no in-place"):
        return "  [killed mid-run; source was never mutated on disk]"
    return "  [%s]" % trigger


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*", help="frameworks to run (default: all)")
    ap.add_argument("--no-build", action="store_true", help="reuse images already built")
    ap.add_argument("--quiet-build", action="store_true", help="hide docker build output")
    args = ap.parse_args()

    os.makedirs(RESULTS, exist_ok=True)
    specs = load(args.names)
    report = {}

    for spec in specs:
        name = spec["name"]
        tag = "assay-conformance-%s" % name
        print("\n=== %s %s (%s) ===" % (name, spec["version"], spec["language"]))
        if not args.no_build:
            print("  building %s ..." % tag)
            tag, err = build(spec, args.quiet_build)
            if tag is None:
                print("  BUILD FAILED\n%s" % err)
                report[name] = {"spec": spec, "build_error": err}
                continue

        runs = {}
        fallback = 0.0
        no_evidence = None
        for label, sig, target, blurb in PROBES:
            print("  %-15s %s" % (label, blurb), flush=True)
            try:
                result = probe(tag, spec, label, sig, target, fallback)
            except subprocess.TimeoutExpired:
                result = {"label": label, "error": "docker run exceeded 1800s"}
            if label == "baseline":
                # `evidence` applied to this suite. A framework that crashed
                # before mutating anything leaves a clean tree for the most
                # uninteresting reason there is, and every verdict after it
                # would be a report about a run that never happened.
                pattern = spec.get("evidence") or ""
                if pattern and not re.search(pattern, result.get("output_tail", "")):
                    no_evidence = (
                        "baseline did not prove it mutated anything: no /%s/ in "
                        "its output" % pattern
                    )
                    print("                  !! %s" % no_evidence)
            if label == "baseline" and "wall_seconds" in result:
                # Half of a run that is known to take this long lands the kill
                # mid-run even against a framework that never trips the sharp
                # trigger, so "sandboxed" and "never interrupted" stay distinct.
                fallback = max(0.5, result["wall_seconds"] / 2.0)
            state, detail = verdict(result, spec.get("expected_scratch", []))
            result["scratch_roots"] = scratch_roots(result)
            result["undocumented_scratch"] = [
                r for r in result["scratch_roots"]
                if r not in set(spec.get("expected_scratch", []))
            ]
            result["verdict"] = state
            result["detail"] = detail
            runs[label] = result
            print("                  -> %-7s %s" % (state, detail))
        report[name] = {"spec": {k: v for k, v in spec.items() if k != "dir"},
                        "runs": runs, "no_evidence": no_evidence}

        with open(os.path.join(RESULTS, "%s.json" % name), "w") as fh:
            json.dump(report[name], fh, indent=2, sort_keys=True)

    print("\n" + "=" * 96)
    head = ["framework"] + [l for l, _s, _t, _b in PROBES] + ["mutates in place?"]
    fmt = "%-16s %-9s %-15s %-9s %-9s %s"
    print(fmt % tuple(head))
    print("-" * 96)
    for name, entry in report.items():
        if "runs" not in entry:
            print("%-16s BUILD FAILED" % name)
            continue
        if entry.get("no_evidence"):
            print(fmt % tuple([name] + ["NO-RUN"] * len(PROBES) + [entry["no_evidence"]]))
            continue
        cells = [entry["runs"].get(l, {}).get("verdict", "-") for l, _s, _t, _b in PROBES]
        seen = any(entry["runs"].get(l, {}).get("in_place_mutation_observed")
                   for l, _s, _t, _b in PROBES)
        print(fmt % tuple([name] + cells + ["yes" if seen else "no -- sandboxed"]))
    print("=" * 96)
    write_summary(report)
    print("results written to %s" % os.path.relpath(RESULTS))


def write_summary(report):
    """The same table as markdown, so the README is generated rather than typed."""
    lines = ["| framework | version | " + " | ".join(l for l, _s, _t, _b in PROBES)
             + " | mutates in place? |",
             "|---|---|" + "---|" * (len(PROBES) + 1)]
    for name, entry in sorted(report.items()):
        spec = entry.get("spec", {})
        if entry.get("no_evidence") or "runs" not in entry:
            cells = ["NO-RUN"] * len(PROBES)
            place = entry.get("no_evidence") or entry.get("build_error", "")[:60]
        else:
            cells = [entry["runs"].get(l, {}).get("verdict", "-")
                     for l, _s, _t, _b in PROBES]
            place = ("yes" if any(entry["runs"].get(l, {}).get("in_place_mutation_observed")
                                  for l, _s, _t, _b in PROBES)
                     else "no — sandboxed")
        lines.append("| `%s` | %s | %s | %s |" % (
            name, spec.get("version", "?"), " | ".join("**%s**" % c for c in cells), place))
    path = os.path.join(RESULTS, "SUMMARY.md")
    with open(path, "w") as fh:
        fh.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
