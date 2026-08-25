#!/usr/bin/env python3
"""Config, and the rule that every table is read in BOTH directions.

A table read one way only accumulates entries and never expires them. After a while it
is a list of things somebody once believed rather than a list of things that are true,
and the audit it guards has quietly stopped applying. Every test here that checks a
stale entry is checking that second direction.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assay.config import (Accepted, Config, ConfigError,  # noqa: E402
                         FAMILIES, apply_baseline, load)
from assay.verdicts import Item  # noqa: E402


def write_config(payload, name="assay.json"):
    root = tempfile.mkdtemp(prefix="assay-config-")
    path = os.path.join(root, name)
    with open(path, "w", encoding="utf-8") as fh:
        if isinstance(payload, str):
            fh.write(payload)
        else:
            json.dump(payload, fh)
    return root, path


class Loading(unittest.TestCase):

    def test_an_ABSENT_config_is_an_empty_one_not_an_error(self):
        """The tool must work on a project that has never heard of it."""
        cfg = load(root=tempfile.mkdtemp())
        self.assertEqual(cfg.runner_exempt, {})
        self.assertEqual(cfg.baseline, [])
        self.assertIsNone(cfg.path)

    def test_a_config_named_in_full_that_is_missing_IS_an_error(self):
        """Asking for a specific file and silently getting none hides a typo."""
        with self.assertRaises(ConfigError):
            load(os.path.join(tempfile.mkdtemp(), "nope.json"))

    def test_broken_json_is_a_hard_error_not_a_silent_empty_config(self):
        """Ignoring it would run the audit with none of the judgment the file holds."""
        _root, path = write_config("{not json")
        with self.assertRaises(ConfigError) as ctx:
            load(path)
        self.assertIn("not valid JSON", str(ctx.exception))

    def test_a_dotfile_name_is_found_too(self):
        root, _path = write_config({"baseline": ["x"]}, ".assay.json")
        self.assertEqual(load(root=root).baseline_lines, ["x"])

    def test_an_exemption_without_a_REASON_is_refused(self):
        """An exemption with no reason cannot be told from an oversight."""
        _root, path = write_config(
            {"runner_exempt": [{"path": "a.py", "property": "sigterm"}]})
        with self.assertRaises(ConfigError) as ctx:
            load(path)
        self.assertIn("reason", str(ctx.exception))

    def test_a_baseline_entry_that_is_neither_a_line_nor_an_object_is_refused(self):
        _root, path = write_config({"baseline": [42]})
        with self.assertRaises(ConfigError):
            load(path)

    def test_a_baseline_entry_in_OBJECT_form_carries_a_reason_and_what_fires_it(self):
        """A bare string stays legal — adopting this means pasting lines out of a run,
        and a format that refuses the paste is a format nobody adopts."""
        _root, path = write_config({"baseline": [
            "pasted straight out of a run",
            {"line": "read and accepted", "reason": "the fix is the 0.3 job",
             "from": "anchors"}]})
        cfg = load(path)
        self.assertEqual(cfg.baseline_lines,
                         ["pasted straight out of a run", "read and accepted"])
        self.assertIsNone(cfg.baseline[0].reason)
        self.assertIsNone(cfg.baseline[0].produced_by)
        self.assertEqual(cfg.baseline[1].reason, "the fix is the 0.3 job")
        self.assertEqual(cfg.baseline[1].produced_by, "anchors")

    def test_an_object_form_entry_without_a_REASON_is_refused(self):
        """The same rule an exemption follows, about the table that rots fastest: an
        acceptance without one cannot be told from an oversight."""
        _root, path = write_config({"baseline": [{"line": "a finding"}]})
        with self.assertRaises(ConfigError) as ctx:
            load(path)
        self.assertIn("reason", str(ctx.exception))

    def test_an_object_form_entry_without_a_LINE_is_refused(self):
        _root, path = write_config({"baseline": [{"reason": "because"}]})
        with self.assertRaises(ConfigError) as ctx:
            load(path)
        self.assertIn("line", str(ctx.exception))

    def test_a_from_naming_no_real_command_is_refused(self):
        """Read in both directions, like every other table here. A `from` nothing can
        produce would make the line permanently uncheckable, in silence."""
        _root, path = write_config({"baseline": [
            {"line": "a finding", "reason": "r", "from": "lint"}]})
        with self.assertRaises(ConfigError) as ctx:
            load(path)
        self.assertIn("from", str(ctx.exception))

    def test_a_star_exemption_covers_every_property(self):
        _root, path = write_config(
            {"runner_exempt": [{"path": "a.py", "property": "*", "reason": "r"}]})
        cfg = load(path)
        self.assertEqual(cfg.exempt_runner("a.py", "sigterm"), "r")
        self.assertEqual(cfg.exempt_runner("a.py", "evidence"), "r")

    def test_a_named_exemption_covers_only_that_property(self):
        _root, path = write_config(
            {"runner_exempt": [{"path": "a.py", "property": "sigterm", "reason": "r"}]})
        cfg = load(path)
        self.assertEqual(cfg.exempt_runner("a.py", "sigterm"), "r")
        self.assertIsNone(cfg.exempt_runner("a.py", "evidence"))

    def test_the_property_field_defaults_to_star(self):
        _root, path = write_config(
            {"runner_exempt": [{"path": "a.py", "reason": "r"}]})
        self.assertEqual(load(path).exempt_runner("a.py", "anything"), "r")


class Baseline(unittest.TestCase):

    EVERY = FAMILIES

    def items(self, *messages):
        return [Item("finding", m) for m in messages]

    def accept(self, *lines):
        return [Accepted(line) for line in lines]

    def lines(self, entries):
        return [e.line for e in entries]

    def test_an_accepted_finding_stops_failing(self):
        still, stale, _u = apply_baseline(self.items("old problem"),
                                          self.accept("old problem"), self.EVERY)
        self.assertEqual(still, [])
        self.assertEqual(stale, [])

    def test_a_NEW_finding_still_fails(self):
        still, _stale, _u = apply_baseline(self.items("old", "new"),
                                           self.accept("old"), self.EVERY)
        self.assertEqual([f.message for f in still], ["new"])

    def test_a_baseline_line_that_no_longer_fires_is_ITSELF_a_finding(self):
        """The second direction. Someone fixed it and left the record claiming
        otherwise, which is how a suppression file becomes a work of fiction."""
        still, stale, _u = apply_baseline(self.items(), self.accept("fixed long ago"),
                                          self.EVERY)
        self.assertEqual(still, [])
        self.assertEqual(self.lines(stale), ["fixed long ago"])

    def test_an_empty_baseline_changes_nothing(self):
        still, stale, _u = apply_baseline(self.items("a"), [], self.EVERY)
        self.assertEqual(len(still), 1)
        self.assertEqual(stale, [])

    def test_matching_is_on_the_exact_message_not_a_prefix(self):
        """A prefix match would let one accepted line silence a family of findings."""
        still, _stale, _u = apply_baseline(self.items("problem in a.py"),
                                           self.accept("problem in"), self.EVERY)
        self.assertEqual(len(still), 1)


class StalenessIsPerLine(unittest.TestCase):
    """A line is only stale to a run that could have seen it fire.

    The first fix for the cry-wolf failure was a whole-run flag: correct, and blunt
    enough that every line in every command but `assay all` went unchecked and the run
    printed a disclaimer where a number belongs. An entry that names the command firing
    it can be answered by that command alone.
    """

    def test_an_UNTAGGED_line_needs_a_run_that_performed_everything(self):
        entry = Accepted("some finding", "read it", None)
        _s, stale, unchecked = apply_baseline([], [entry], ("runners",))
        self.assertEqual(stale, [])
        self.assertEqual([e.line for e in unchecked], ["some finding"])
        _s, stale, unchecked = apply_baseline([], [entry], FAMILIES)
        self.assertEqual([e.line for e in stale], ["some finding"])
        self.assertEqual(unchecked, [])

    def test_a_TAGGED_line_is_answered_by_the_one_command_that_fires_it(self):
        entry = Accepted("a runners finding", "read it", "runners")
        _s, stale, unchecked = apply_baseline([], [entry], ("runners",))
        self.assertEqual([e.line for e in stale], ["a runners finding"])
        self.assertEqual(unchecked, [])

    def test_a_line_THIS_RUN_COULD_NOT_SEE_is_never_called_stale(self):
        """The cry-wolf failure itself, and the reason the first fix was blunt."""
        entry = Accepted("an anchors finding", "read it", "anchors")
        _s, stale, unchecked = apply_baseline([], [entry], ("runners", "diff"))
        self.assertEqual(stale, [])
        self.assertEqual([e.line for e in unchecked], ["an anchors finding"])

    def test_a_line_that_FIRED_is_suppressed_whatever_the_run_performed(self):
        """Suppression is safe from any run: a line that fires is a line that fires."""
        entry = Accepted("an anchors finding", "read it", "anchors")
        still, stale, unchecked = apply_baseline(
            [Item("finding", "an anchors finding")], [entry], ())
        self.assertEqual(still, [])
        self.assertEqual(stale, [])
        self.assertEqual(unchecked, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
