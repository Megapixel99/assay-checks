#!/usr/bin/env python3
"""The mutation runner's own harness, driven directly.

`mutations_assay.py` is a SUBJECT of `assay runners` and audits itself against the six
properties. These are the pieces of it that a mutation cannot reach, because breaking
them stops the runner rather than a guard it tests.
"""

import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mutations_assay as M  # noqa: E402


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
