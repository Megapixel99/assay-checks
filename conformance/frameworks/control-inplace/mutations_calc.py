#!/usr/bin/env python3
"""A mutation harness that satisfies all seven properties, and mutates IN PLACE.

This is the suite's calibration row, and the suite is worth nothing without it.
A table of CLEAN verdicts proves the frameworks are clean only if the probe can
be shown to report DIRTY when the tree really is dirty -- otherwise "nothing
found" and "nothing looked" are the same output, which is the `evidence`
property one level up from the harnesses it audits.

So this harness is deliberately correct. `assay runners` passes it on all seven:
the restore is in a `finally`, SIGTERM is turned into an exception so that
`finally` runs, each suite has to prove it RAN before a failure counts, failures
are partitioned into DEAD and REAL before either is scored, a mutant that does
not compile is skipped rather than scored, nothing is written beside the code
under test, and the tree is hashed before and compared after so that a restore
which ran but did not work is still a failure.

It is nonetheless left mutated by SIGKILL, because no property in that list is
reachable from a signal that runs no code. That is the whole claim, and this
file is the executable form of it.
"""

import hashlib
import os
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "calc", "__init__.py")

# (anchor, replacement). Each anchor must match its target exactly once -- the
# thing `assay anchors` checks, and the reason this table is small enough to read.
MUTATIONS = [
    ("if value < low:", "if value <= low:"),
    ("return hits / total", "return hits * total"),
    ("out = out + v", "out = out - v"),
]


class Terminated(Exception):
    """SIGTERM, raised so that `finally` runs. SIGKILL has no equivalent."""


def _on_sigterm(signum, frame):
    raise Terminated("SIGTERM")


def digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def run_suite():
    """Return (ran, failed). RAN and FAILED are separate questions on purpose."""
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "--no-header", "-p", "no:cacheprovider"],
        cwd=HERE, capture_output=True, text=True,
    )
    out = proc.stdout + proc.stderr
    # EVIDENCE that the suite RAN, rather than the absence of a report of failure:
    # a collection error prints no failures and executes no test, and without this
    # the two are the same observation.
    ran = ("passed" in out) or ("failed" in out)
    return ran, proc.returncode != 0, out


def main():
    signal.signal(signal.SIGTERM, _on_sigterm)

    before = digest(TARGET)
    with open(TARGET, encoding="utf-8") as fh:
        original = fh.read()

    baseline_ran, baseline_failed, out = run_suite()
    if not baseline_ran:
        print("EVIDENCE: baseline suite DID NOT RUN; nothing after this means anything")
        print(out[-2000:])
        return 2
    if baseline_failed:
        print("EVIDENCE: baseline suite RAN and FAILED; the tests are broken, not the code")
        return 2

    dead = 0   # detections: the suite RAN and FAILED for the right reason
    real = 0   # DID-NOT-RUN entries, which are NOT detections
    skipped = 0
    try:
        for anchor, replacement in MUTATIONS:
            if original.count(anchor) != 1:
                print("ANCHOR %r matches %d places, not 1" % (anchor, original.count(anchor)))
                return 2
            mutant = original.replace(anchor, replacement, 1)

            # A mutation that breaks the file syntactically makes every suite fail,
            # which reads as the strongest possible detection from the weakest
            # possible mutation. Parse it first, and score nothing if it does not.
            try:
                compile(mutant, TARGET, "exec")
            except SyntaxError:
                skipped += 1
                print("SKIP  %-24s -> mutant does not parse" % anchor)
                continue

            with open(TARGET, "w", encoding="utf-8") as fh:
                fh.write(mutant)

            ran, failed, _ = run_suite()
            if not ran:
                real += 1
                print("REAL  %-24s -> suite DID NOT RUN (not a detection)" % anchor)
            elif failed:
                dead += 1
                print("DEAD  %-24s -> detected" % anchor)
            else:
                print("ALIVE %-24s -> NOT DETECTED" % anchor)
    finally:
        # The restore cannot be skipped by an exception -- including the one
        # SIGTERM was turned into. It CAN be skipped by SIGKILL, and that is the
        # hole this whole conformance suite exists to measure.
        with open(TARGET, "w", encoding="utf-8") as fh:
            fh.write(original)
        after = digest(TARGET)
        if after != before:
            # A restore that ran is not a restore that worked.
            print("RESTORE FAILED: %s did not come back (%s != %s)"
                  % (TARGET, after[:12], before[:12]))
            return 3

    print("dead=%d real=%d skipped=%d" % (dead, real, skipped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
