#!/usr/bin/env python3
"""The harnesses themselves, driven directly.

`mutations_assay.py` is a SUBJECT of `assay runners` and audits itself against the six
properties. These are the pieces of it that a mutation cannot reach, because breaking
them stops the runner rather than a guard it tests. `run_tests.py` is here for the same
reason: it is what RUNS the mutation runner's suites, so a mutation cannot observe it
breaking — a broken runner reports DID NOT RUN for everything, which is refused rather
than scored, and the table would go quiet all at once.
"""

import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mutations_assay as M  # noqa: E402
import run_tests as R  # noqa: E402


class SuiteThatHangs(unittest.TestCase):

    def test_a_hung_suite_is_a_DID_NOT_RUN_and_not_a_detection(self):
        """A mutation can wedge a suite instead of failing it — remove the bound on an
        awaited rung and `node --test`, which carries no timeout of its own, waits
        forever. Letting the timeout propagate ends the whole run and loses every
        mutation after it; counting it as a catch would score the weakest possible
        evidence as the strongest.
        """
        slow = {
            "name": "wedged",
            "suite": [sys.executable, "-c", "import time; time.sleep(30)"],
            "evidence": M.PY_EVIDENCE,
            "failures": M._python_failures,
            "syntax_error": M._python_syntax_error,
        }
        original = M.SUITE_TIMEOUT
        M.SUITE_TIMEOUT = 1
        try:
            ran, failures = M.run_suite(slow)
        finally:
            M.SUITE_TIMEOUT = original
        self.assertFalse(ran)
        self.assertIn("DID NOT RUN", failures[0])
        self.assertIn("hung", failures[0])

    def test_a_suite_that_runs_clean_is_not_mistaken_for_a_hang(self):
        """The other direction, so this cannot pass by refusing everything."""
        clean = {
            "name": "fine",
            "suite": [sys.executable, "-c", "print('3 tests, 0 failures, 0 errors')"],
            "evidence": M.PY_EVIDENCE,
            "failures": M._python_failures,
            "syntax_error": M._python_syntax_error,
        }
        ran, failures = M.run_suite(clean)
        self.assertTrue(ran)
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TheSuiteRunner(unittest.TestCase):
    """`run_tests.py` runs one process per TestCase class. What that must not change."""

    def test_every_discovered_test_belongs_to_exactly_one_class(self):
        """The partition is the whole basis of the count.

        A test discovery finds but `classes()` does not name would never be dispatched
        to a worker, and the summary would report a total the run never covered — a
        suite that quietly got smaller, which is the shape of defect this package
        exists to report rather than commit.
        """
        found = R.classes(R.suite())
        self.assertEqual(sum(found.values()), R.suite().countTestCases())
        self.assertTrue(found, "no classes discovered, so this check matched nothing")

    def test_a_class_that_will_not_LOAD_is_an_error_and_not_an_exception(self):
        """One unloadable class must not take the other thirty-seven down with it.

        Letting it raise inside the pool ends the whole run, and a run that ended is
        reported as DID NOT RUN — which the mutation runner refuses to score. The
        failure would be real and the report would be that there wasn't one.
        """
        ran, failures, errors = R.run_class("tests.no_such_module.NoSuchClass")
        # `loadTestsFromName` does not raise for this: unittest substitutes a synthetic
        # `_FailedTest` that reports the import problem when it is run. Either way what
        # matters here is the same — it comes back as a REPORTED error rather than an
        # exception out of the worker, so the other classes still get their turn.
        self.assertEqual(failures, [])
        self.assertEqual(len(errors), 1)
        self.assertEqual(ran, 1)

    def test_a_class_that_runs_reports_what_it_ran(self):
        """The other direction, so this cannot pass by reporting nothing for everything."""
        ran, failures, errors = R.run_class("test_verdicts.Rendering")
        self.assertGreater(ran, 0)
        self.assertEqual((failures, errors), ([], []))
