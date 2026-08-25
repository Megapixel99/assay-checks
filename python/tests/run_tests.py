#!/usr/bin/env python3
"""Every Python suite, one command, one summary.

Prints its own count. A runner that reports only pass/fail cannot be told from a
runner that discovered no tests, and those are opposite situations.

ONE PROCESS PER TestCase CLASS, because this suite is almost entirely WAITING. A probe
is a child process per function, so the wall clock is spawn latency rather than work,
and the cores sat idle through all of it: 25.4s serial against 9.8s across four. That
multiplies — `mutations_assay.py` runs this whole suite once per mutation, a hundred
and four times, so the serial version spent about half an hour of every CI run
blocking on `fork`.

THE OUTPUT CONTRACT IS UNCHANGED, and it is not decoration. `mutations_assay.py` reads
this suite's stdout to decide whether it RAN — `^\\d+ tests, ` is the evidence — and
reads failures off lines starting `FAIL:` or `ERROR:`. A parallel runner that printed a
summary per worker would look, to that reader, like a suite that never ran, and every
mutation would score DID NOT RUN. So the counts are aggregated and printed ONCE, in the
same shape, and the failures are printed in class order rather than completion order so
two runs of the same tree read the same.
"""

import os
import sys
import unittest
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)


def suite():
    return unittest.defaultTestLoader.discover(HERE, pattern="test_*.py")


def classes(tests, out=None):
    """Every TestCase class discovery found, as loadable names, in a stable order."""
    out = {} if out is None else out
    for test in tests:
        if isinstance(test, unittest.TestSuite):
            classes(test, out)
            continue
        cls = type(test)
        out.setdefault("%s.%s" % (cls.__module__, cls.__name__), 0)
        out["%s.%s" % (cls.__module__, cls.__name__)] += 1
    return out


def _prepare():
    """Workers are spawned on macOS, so they start without this module's path work."""
    sys.path.insert(0, ROOT)
    sys.path.insert(0, HERE)


def run_class(name):
    """(ran, failures, errors) for one class. Tracebacks come back as text.

    A class that will not even LOAD is an error rather than an exception that takes the
    pool down with it: losing the other thirty-seven classes to report one of them
    would turn a failure into a suite that did not run.
    """
    import io as _io                                          # noqa: PLC0415

    try:
        tests = unittest.defaultTestLoader.loadTestsFromName(name)
    except Exception as exc:                                  # noqa: BLE001
        return 0, [], [("%s (could not load)" % name, str(exc))]
    buf = _io.StringIO()
    result = unittest.TextTestRunner(stream=buf, verbosity=0).run(tests)
    return (result.testsRun,
            [(str(t), tb) for t, tb in result.failures],
            [(str(t), tb) for t, tb in result.errors])


def main():
    found = classes(suite())
    count = sum(found.values())
    if count == 0:
        print("NO TESTS DISCOVERED — that is a failure, not a pass")
        return 2

    names = sorted(found, key=lambda n: (-found[n], n))
    workers = min(len(names), (os.cpu_count() or 1))
    with ProcessPoolExecutor(max_workers=workers, initializer=_prepare) as pool:
        done = dict(zip(names, pool.map(run_class, names)))

    ran = sum(done[n][0] for n in names)
    failures = [f for n in sorted(names) for f in done[n][1]]
    errors = [e for n in sorted(names) for e in done[n][2]]
    for label, items in (("FAIL", failures), ("ERROR", errors)):
        for name, tb in items:
            print("%s: %s\n%s" % (label, name, tb))

    # THE DISCOVERED COUNT AND THE COUNT THAT RAN ARE COMPARED, not assumed equal. A
    # worker that died between loading and reporting would otherwise subtract tests
    # from the total silently, and a suite that quietly got smaller is the exact shape
    # of defect this package exists to report.
    if ran != count:
        print("ERROR: discovery found %d tests and %d ran — %d never reported"
              % (count, ran, count - ran))
        errors = errors + [("incomplete run", "")]

    print("\n%d tests, %d failures, %d errors" % (count, len(failures), len(errors)))
    return 0 if not failures and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
