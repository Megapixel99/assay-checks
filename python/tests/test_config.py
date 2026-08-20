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

from assay.config import Config, ConfigError, apply_baseline, load  # noqa: E402
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
        self.assertEqual(load(root=root).baseline, ["x"])

    def test_an_exemption_without_a_REASON_is_refused(self):
        """An exemption with no reason cannot be told from an oversight."""
        _root, path = write_config(
            {"runner_exempt": [{"path": "a.py", "property": "sigterm"}]})
        with self.assertRaises(ConfigError) as ctx:
            load(path)
        self.assertIn("reason", str(ctx.exception))

    def test_a_baseline_that_is_not_a_list_of_strings_is_refused(self):
        _root, path = write_config({"baseline": [{"msg": "x"}]})
        with self.assertRaises(ConfigError):
            load(path)

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

    def items(self, *messages):
        return [Item("finding", m) for m in messages]

    def test_an_accepted_finding_stops_failing(self):
        still, stale = apply_baseline(self.items("old problem"), ["old problem"])
        self.assertEqual(still, [])
        self.assertEqual(stale, [])

    def test_a_NEW_finding_still_fails(self):
        still, _stale = apply_baseline(self.items("old", "new"), ["old"])
        self.assertEqual([f.message for f in still], ["new"])

    def test_a_baseline_line_that_no_longer_fires_is_ITSELF_a_finding(self):
        """The second direction. Someone fixed it and left the record claiming
        otherwise, which is how a suppression file becomes a work of fiction."""
        still, stale = apply_baseline(self.items(), ["fixed long ago"])
        self.assertEqual(still, [])
        self.assertEqual(stale, ["fixed long ago"])

    def test_an_empty_baseline_changes_nothing(self):
        still, stale = apply_baseline(self.items("a"), [])
        self.assertEqual(len(still), 1)
        self.assertEqual(stale, [])

    def test_matching_is_on_the_exact_message_not_a_prefix(self):
        """A prefix match would let one accepted line silence a family of findings."""
        still, _stale = apply_baseline(self.items("problem in a.py"), ["problem in"])
        self.assertEqual(len(still), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
