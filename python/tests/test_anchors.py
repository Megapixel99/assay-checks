#!/usr/bin/env python3
"""Anchor counting: every mutation anchor must match its target exactly once."""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assay.anchors import (anchors_of, audit_anchors,  # noqa: E402
                           harness_paths)
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

    def test_a_DECLARED_TEST_column_does_not_shift_the_anchor(self):
        """The third four-column shape: `(label, old, new, expected_test)`.

        A harness that names the check each mutation must redden — so that "something
        failed" and "the check that covers this failed" stay different claims — puts
        that name last. Reading `parts[-2]` there lands on the REPLACEMENT, which
        matches nothing by construction, so every entry in such a table becomes a
        dead-anchor finding on a harness that is perfectly healthy.
        """
        found, _ = anchors_of(self.runner_path(
            'MUTATIONS = [("a label here", "    return x + 1", "    return x - 1",'
            ' "test_handle_adds_one")]\n'))
        self.assertIn("    return x + 1", found)
        self.assertNotIn("    return x - 1", found)

    def test_a_four_column_table_ending_in_CODE_still_reads_the_third(self):
        """The other direction, which is what stops the fix above from being a
        position swap: the target-column shape ends in a replacement, not a name, and
        its anchor is still the third column. This package's own runner is that
        shape, so getting it wrong would be self-inflicted."""
        found, _ = anchors_of(self.runner_path(
            'MUTATIONS = [("a label here", "target.py", "    return x + 1",'
            ' "    return x - 1")]\n'))
        self.assertIn("    return x + 1", found)
        self.assertNotIn("target.py", found)

    def test_a_THREE_column_entry_ending_in_an_identifier_is_left_ALONE(self):
        """Deliberately not disambiguated. `("label", code, "pass")` is an ordinary
        three-column mutation whose replacement happens to be a bare identifier, and
        re-reading it would trade a false finding on one shape for a false finding on
        another. Measured on a real tree: one such entry across 34 harnesses."""
        found, _ = anchors_of(self.runner_path(
            'MUTATIONS = [("label", "    return x + 1", "pass")]\n'))
        self.assertIn("    return x + 1", found)
        self.assertNotIn("label", found)

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

    def test_the_finding_NAMES_THE_FILE_holding_the_copies(self):
        """The finding is about the HARNESS, and the copies are usually somewhere
        else — often a file added since that harness was last touched. A reader given
        only the count starts from the file they already know about and greps the tree
        for the one they do not, which is the whole distance between a finding that
        can be acted on and one that has to be investigated first.
        """
        rep = self.audit({
            "a.py": TARGET,
            "elsewhere.py":
                'def one(x):\n    return x + 1\n\n\ndef two(x):\n    return x + 1\n',
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'})
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("elsewhere.py", rep.findings[0].message)
        # AND NOT the file the reader would have started from. `a.py` holds one copy,
        # so it is innocent and naming it would be worse than naming nothing.
        self.assertNotIn("a.py", rep.findings[0].message.split("(")[1])

    def test_a_TIE_names_the_same_file_every_run(self):
        """Two files equally guilty is one problem, not two. `>` rather than `>=`
        over a sorted walk is what keeps the finding's text stable, and the text is
        what a `baseline` entry matches whole."""
        files = {
            "b_two.py": 'def a(x):\n    return x + 1\n\n\ndef b(x):\n    return x + 1\n',
            "a_two.py": 'def c(x):\n    return x + 1\n\n\ndef d(x):\n    return x + 1\n',
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'}
        first = self.audit(files).findings[0].message
        self.assertIn("a_two.py", first)
        self.assertEqual(first, self.audit(files).findings[0].message)

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
        # HOW MANY FILES WERE SEARCHED. "Matches nothing" and "there was nothing to
        # match it against" are different claims, and a root pointed one directory
        # too deep makes every anchor dead at once. Only the count tells them apart.
        # ONE, not two: the harness is not part of its own corpus, so the only file
        # searched is `a.py`. The count is the corpus rule made visible.
        self.assertIn("in any of 1 file —", rep.findings[0].message)

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

    def test_a_JAVASCRIPT_harness_leaves_the_corpus_too(self):
        """`find_runners` finds the harnesses this half can READ, which is the `.py`
        ones. What has to leave the corpus is all of them.

        A polyglot repository has a `mutations-x.js` beside a `mutations_a.py`, and a
        JavaScript harness left in the corpus is a file full of anchor strings for this
        audit to match its own anchors against — a confident finding about a file the
        Python harness has nothing to do with. Reading and excluding are two different
        questions, and answering both with one walk was the mistake.
        """
        rep = self.audit({
            "a.py": TARGET,
            "mutations_a.py":
                'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n',
            # The JavaScript harness carries the same anchor, as its own literal.
            "mutations-b.js":
                "export const MUTATIONS = [['label', '    return x + 1',"
                " '    return x - 1']];\n"})
        self.assertEqual(rep.exit_code(), 0,
                         [i.message for i in rep.findings])

    def test_harness_paths_finds_BOTH_languages(self):
        root = project({"mutations_a.py": "MUTATIONS = []\n",
                        "mutations-b.js": "export const MUTATIONS = [];\n",
                        "mutations-c.mjs": "export const MUTATIONS = [];\n",
                        "notaharness.js": "export const x = 1;\n"})
        names = {os.path.basename(p) for p in harness_paths(root)}
        self.assertEqual(names, {"mutations_a.py", "mutations-b.js", "mutations-c.mjs"})

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
