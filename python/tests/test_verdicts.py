#!/usr/bin/env python3
"""The shared verdict vocabulary. Both halves depend on these rules holding."""

import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assay.verdicts import FINDING, LOOK, OK, Item, Report, render  # noqa: E402


class Verdicts(unittest.TestCase):

    def test_an_unknown_verdict_is_refused_at_construction(self):
        """A typo'd verdict must not become a fourth, silently unhandled category."""
        with self.assertRaises(ValueError):
            Item("probably", "something")

    def test_a_look_NEVER_changes_the_exit_code(self):
        rep = Report().look("could not decide").look("nor this")
        self.assertEqual(rep.exit_code(), 0)

    def test_one_finding_fails(self):
        self.assertEqual(Report().finding("this is wrong").exit_code(), 1)

    def test_ok_items_never_fail(self):
        self.assertEqual(Report().ok("checked and fine").exit_code(), 0)

    def test_findings_survive_being_mixed_with_looks(self):
        rep = Report().look("a").finding("b").ok("c")
        self.assertEqual(rep.exit_code(), 1)
        self.assertEqual(len(rep.findings), 1)
        self.assertEqual(len(rep.looks), 1)
        self.assertEqual(len(rep.oks), 1)

    def test_extend_keeps_both_reports_items_and_notes(self):
        a = Report().finding("a").note("count: 1")
        b = Report().look("b").note("count: 2")
        a.extend(b)
        self.assertEqual(len(a.items), 2)
        self.assertEqual(a.sections, ["count: 1", "count: 2"])


class Rendering(unittest.TestCase):

    def render(self, rep, **kw):
        buf = io.StringIO()
        code = render(rep, buf, **kw)
        return code, buf.getvalue()

    def test_no_findings_says_so_rather_than_printing_nothing(self):
        """Silence and success are different claims, and only one is evidence."""
        code, text = self.render(Report().ok("a thing"))
        self.assertEqual(code, 0)
        self.assertIn("no findings", text)

    def test_looks_are_printed_under_a_heading_that_says_they_do_not_fail(self):
        code, text = self.render(Report().look("cannot decide this"))
        self.assertEqual(code, 0)
        self.assertIn("LOOK", text)
        self.assertIn("never fail", text)

    def test_a_findings_detail_is_printed_below_it(self):
        _code, text = self.render(Report().finding("the thing", detail="because X"))
        self.assertIn("the thing", text)
        self.assertIn("because X", text)

    def test_quiet_still_prints_findings_because_that_is_the_point(self):
        code, text = self.render(Report().finding("the thing").ok("fine"), verbose=False)
        self.assertEqual(code, 1)
        self.assertIn("the thing", text)
        self.assertNotIn("fine", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
