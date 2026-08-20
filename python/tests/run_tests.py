#!/usr/bin/env python3
"""Every Python suite, one command, one summary.

Prints its own count. A runner that reports only pass/fail cannot be told from a
runner that discovered no tests, and those are opposite situations.
"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))


def suite():
    return unittest.defaultTestLoader.discover(HERE, pattern="test_*.py")


def main():
    tests = suite()
    count = tests.countTestCases()
    if count == 0:
        print("NO TESTS DISCOVERED — that is a failure, not a pass")
        return 2
    result = unittest.TextTestRunner(verbosity=1).run(tests)
    print("\n%d tests, %d failures, %d errors"
          % (count, len(result.failures), len(result.errors)))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
