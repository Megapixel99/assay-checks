#!/usr/bin/env python3
"""Anchor counting: every mutation anchor must match its target exactly once."""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assay.anchors import anchors_of, audit_anchors  # noqa: E402
from assay.config import Config  # noqa: E402


def project(files):
    root = tempfile.mkdtemp(prefix="assay-anchors-")
    for name, body in files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
    return root


TARGET = 'def handle(x):\n    return x + 1\n\n\ndef other(x):\n    return x - 1\n'


class Parsing(unittest.TestCase):

    def runner_path(self, body):
        return os.path.join(project({"mutations_a.py": body}), "mutations_a.py")

    def test_an_assign_table_is_read(self):
        found, _ = anchors_of(self.runner_path(
            'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'))
        self.assertIn("    return x + 1", found)

    def test_an_AUGASSIGN_table_is_read_too(self):
        """`MUTATIONS += [...]` is an AugAssign, not an Assign. Reading only the
        latter silently skips every anchor added in a `+=` block, and the tell is a
        total that does not move when a mutation is added — which nobody watches."""
        found, _ = anchors_of(self.runner_path(
            'MUTATIONS = []\n'
            'MUTATIONS += [("label", "    return x + 1", "    return x - 1")]\n'))
        self.assertIn("    return x + 1", found)

    def test_a_short_LABEL_is_not_mistaken_for_an_anchor(self):
        found, _ = anchors_of(self.runner_path(
            'MUTATIONS = [("lbl", "    return x + 1", "    return x - 1")]\n'))
        self.assertNotIn("lbl", found)

    def test_a_four_element_table_with_a_target_column_still_yields_the_anchor(self):
        found, _ = anchors_of(self.runner_path(
            'MUTATIONS = [("a label here", "target.py", "    return x + 1",'
            ' "    return x - 1")]\n'))
        self.assertIn("    return x + 1", found)

    def test_a_table_under_another_name_is_ignored(self):
        found, _ = anchors_of(self.runner_path(
            'OTHER_LIST = [("label", "    return x + 1", "    return x - 1")]\n'))
        self.assertEqual(found, [])

    def test_reading_a_runner_does_not_IMPORT_it(self):
        """Importing a harness drags in the tool it tests, and one that does work at
        import time can mask its own mutation just by being loaded."""
        marker = os.path.join(tempfile.mkdtemp(), "touched")
        path = self.runner_path(
            "open(%r, 'w').write('x')\n"
            'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'
            % marker)
        anchors_of(path)
        self.assertFalse(os.path.exists(marker))


class Auditing(unittest.TestCase):

    def audit(self, files, config=None):
        return audit_anchors(project(files), config or Config())

    def test_a_unique_anchor_passes(self):
        rep = self.audit({
            "a.py": TARGET,
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'})
        self.assertEqual(rep.exit_code(), 0)

    def test_an_anchor_matching_TWICE_IN_ONE_FILE_is_a_finding(self):
        """`replace(..., 1)` takes the FIRST, which may not be the one you meant. The
        harness then mutates something nothing asserts and reports NOT DETECTED, which
        reads as "your guard is untested" when the truth is "your mutation tested
        something else"."""
        rep = self.audit({
            "a.py": 'def one(x):\n    return x + 1\n\n\ndef two(x):\n    return x + 1\n',
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'})
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("matches 2 times", rep.findings[0].message)

    def test_the_same_anchor_ONCE_IN_EACH_OF_TWO_FILES_is_not_ambiguous(self):
        """Counting in total rather than per file would make this a finding, and a
        harness that names its target is not confused by it. Crying wolf here is how
        an audit stops being run."""
        rep = self.audit({
            "a.py": TARGET, "b.py": TARGET,
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'})
        self.assertEqual(rep.exit_code(), 0)

    def test_an_anchor_matching_NOTHING_is_a_FINDING(self):
        """The half of the rule that used to be counted and then reported as `ok`.

        An anchor matching nothing means the code moved out from under it: loud if the
        harness checks its target, and SILENTLY INERT if it does not — a guard nobody
        is testing any more, inside a suite that still reports a pass. It was only ever
        a number because the parser could not tell a label from an anchor and would
        have failed on every label. It can now, so it says so.
        """
        rep = self.audit({
            "a.py": TARGET,
            "mutations_a.py":
                'MUTATIONS = [("label", "    nothing like this", "    or this")]\n'})
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("matches NOTHING", rep.findings[0].message)

    def test_a_table_shape_it_cannot_read_is_a_LOOK_not_a_guess(self):
        """A wrong conviction about a table this audit has never seen is worse than
        saying it could not tell, so an entry carrying more strings than either
        documented shape is offered to a person rather than scored."""
        rep = self.audit({
            "a.py": TARGET,
            "mutations_a.py":
                'MUTATIONS = [("label", "t.py", "    return x + 1",'
                ' "    return x - 1", "a trailing note")]\n'})
        self.assertEqual(rep.exit_code(), 0)
        self.assertTrue(any("cannot tell which column" in i.message
                            for i in rep.looks), [i.message for i in rep.looks])

    def test_an_exempt_runner_is_named_rather_than_skipped_silently(self):
        rep = self.audit(
            {"a.py": 'def one(x):\n    return x + 1\n\n\ndef two(x):\n    return x + 1\n',
             "mutations_a.py":
                 'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'},
            Config(anchor_exempt={"mutations_a.py": "anchors into generated source"}))
        self.assertEqual(rep.exit_code(), 0)
        self.assertIn("exempt", "\n".join(rep.sections))

    def test_NO_HARNESS_is_part_of_the_corpus(self):
        """Not just the declaring one — every harness, and the difference is real.

        A harness's source contains its own anchors as literals, so counting them
        there makes every anchor "match twice" and the audit reports problems that are
        all itself. Excluding only the DECLARING harness leaves the other half: one
        harness's REPLACEMENT text routinely appears in another's, so a common
        replacement like a disabled branch matches dozens of times in a sibling and
        produces a confident finding about a file it has nothing to do with.
        """
        rep = self.audit({
            # Four distinct bodies, so every anchor below matches exactly once here
            # and the only thing this test can fail on is the corpus rule.
            "a.py": TARGET + '\n\ndef third(x):\n    return x * 2\n'
                             '\n\ndef fourth(x):\n    return x * 3\n',
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    if False:")]\n',
            # A sibling harness whose own table is full of the same replacement.
            "mutations_b.py":
                'MUTATIONS = [\n'
                '    ("one", "    return x * 2", "    if False:"),\n'
                '    ("two", "    return x * 3", "    if False:"),\n'
                ']\n'})
        self.assertEqual(rep.exit_code(), 0,
                         [i.message for i in rep.findings])

    def test_an_anchor_pointing_only_at_a_HARNESS_counts_as_unmatched(self):
        """The corollary, and the reason the rule is safe: anchors point at the code
        under test, and a harness is not the code under test. An anchor that matches
        nothing outside the harnesses is a guard nobody is testing any more."""
        rep = self.audit({
            "a.py": TARGET,
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n',
            "mutations_b.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'})
        self.assertEqual(rep.exit_code(), 0)
        for item in rep.oks:
            self.assertIn("each matching exactly once", item.message)

    def test_a_runner_that_does_not_parse_is_a_finding(self):
        rep = self.audit({"mutations_a.py": "def broken(:\n"})
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("does not parse", rep.findings[0].message)

    def test_no_runners_is_reported_rather_than_passing_silently(self):
        rep = self.audit({"a.py": TARGET})
        self.assertEqual(rep.exit_code(), 0)
        self.assertIn("no mutation runners", "\n".join(rep.sections))


if __name__ == "__main__":
    unittest.main(verbosity=2)
