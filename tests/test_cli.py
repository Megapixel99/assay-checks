#!/usr/bin/env python3
"""The CLI contract: one exit-code rule across every subcommand.

Scripts depend on the exit code more than on anything printed, so the codes are tested
per subcommand rather than once. `2` must mean "the tool could not run" and never
"the tool found nothing" — collapsing those two is how a broken invocation reads as a
clean audit in CI.
"""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from assay import cli  # noqa: E402

TWINS = ('def a(s):\n'
         '    if not isinstance(s, str):\n        raise TypeError("str")\n'
         '    return s[::-1]\n\n\n'
         'def b(s):\n'
         '    if not isinstance(s, str):\n        raise TypeError("str")\n'
         '    out = ""\n'
         '    for ch in s:\n        out = ch + out\n'
         '    return out\n')


def run(*argv):
    """The CLI in-process. Returns (code, text)."""
    buf = io.StringIO()
    code = cli.main(list(argv), out=buf)
    return code, buf.getvalue()


def tree(files):
    root = tempfile.mkdtemp(prefix="assay-cli-")
    for name, body in files.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
    return root


class FlagPlacement(unittest.TestCase):
    """A global flag must work on BOTH sides of the subcommand name.

    `parents=[...]` copies action REFERENCES, so parsers built from one shared parent
    hold the same objects and anything writing an action's default writes it
    everywhere. That made `-q` before the subcommand parse correctly and then get
    overwritten by the subparser's own default: accepted, documented, and inert.
    """

    def parsed(self, *argv):
        return vars(cli.build_parser().parse_args(list(argv)))

    def test_quiet_before_the_subcommand(self):
        self.assertTrue(self.parsed("-q", "scan", "X")["quiet"])

    def test_quiet_after_the_subcommand(self):
        self.assertTrue(self.parsed("scan", "X", "-q")["quiet"])

    def test_quiet_absent_stays_false(self):
        self.assertFalse(self.parsed("scan", "X")["quiet"])

    def test_root_before_and_after_agree(self):
        self.assertEqual(self.parsed("--root", "R", "scan", "X")["root"], "R")
        self.assertEqual(self.parsed("scan", "X", "--root", "R")["root"], "R")

    def test_root_defaults_to_here(self):
        self.assertEqual(self.parsed("scan", "X")["root"], ".")

    def test_quiet_really_silences_everything_but_findings(self):
        root = tree({"m.py": "def a(n):\n    return n * 2\n"})
        _code, text = run("scan", root, "-q")
        self.assertEqual(text, "")


class ExitCodes(unittest.TestCase):

    def test_no_subcommand_prints_help_and_exits_2(self):
        code, text = run()
        self.assertEqual(code, 2)
        self.assertIn("usage", text.lower())

    def test_scan_exits_1_when_it_finds_a_group(self):
        root = tree({"m.py": TWINS})
        code, text = run("scan", root)
        self.assertEqual(code, 1)
        self.assertIn("same answer", text)

    def test_scan_exits_0_when_it_finds_nothing(self):
        root = tree({"m.py": "def a(n):\n    return n * 2\n"})
        code, text = run("scan", root)
        self.assertEqual(code, 0)
        self.assertIn("no findings", text)

    def test_pair_exits_2_on_a_reference_it_cannot_resolve(self):
        code, text = run("pair", "nope.py::x", "nope.py::y")
        self.assertEqual(code, 2)
        self.assertIn("cannot resolve", text)

    def test_pair_reports_differs_as_an_OK_not_a_finding(self):
        """A witness is the good outcome: it proves the two are different."""
        root = tree({"m.py": "def a(n):\n    return n * 2\n\n\n"
                             "def b(n):\n    return n + 2\n"})
        m = os.path.join(root, "m.py")
        code, text = run("pair", m + "::a", m + "::b")
        self.assertEqual(code, 0)
        self.assertIn("differs", text)

    def test_pair_reports_same_as_a_finding(self):
        root = tree({"m.py": TWINS})
        m = os.path.join(root, "m.py")
        code, _text = run("pair", m + "::a", m + "::b")
        self.assertEqual(code, 1)

    def test_search_finds_what_the_tree_already_answers(self):
        root = tree({"m.py": TWINS})
        code, text = run("search", os.path.join(root, "m.py") + "::a", "--in", root)
        self.assertEqual(code, 1)
        self.assertIn("already answers", text)

    def test_search_that_finds_nothing_exits_0_and_says_so(self):
        root = tree({"m.py": "def only(n):\n    return n * 3 + 1\n"})
        code, text = run("search", os.path.join(root, "m.py") + "::only", "--in", root)
        self.assertEqual(code, 0)
        self.assertIn("none", text)

    def test_search_exits_2_on_an_unresolvable_reference(self):
        code, _text = run("search", "nope.py::x", "--in", ".")
        self.assertEqual(code, 2)

    def test_runners_on_a_project_with_none_exits_0(self):
        code, _text = run("--root", tree({"a.py": "x = 1\n"}), "runners")
        self.assertEqual(code, 0)

    def test_a_broken_config_exits_2_rather_than_auditing_without_it(self):
        """Silently ignoring it would run the audit with none of the judgment the
        file was written to carry."""
        root = tree({"a.py": "x = 1\n", "assay.json": "{not json"})
        code, text = run("--root", root, "runners")
        self.assertEqual(code, 2)
        self.assertIn("not valid JSON", text)


class ConfigWiring(unittest.TestCase):

    def test_a_baseline_entry_turns_a_finding_into_a_pass(self):
        root = tree({"m.py": TWINS})
        code, _text = run("scan", root)
        self.assertEqual(code, 1)
        _c, text = run("scan", root, "-q")
        message = [l for l in text.splitlines() if "same answer" in l][0]
        message = message.split("finding  ", 1)[1]

        cfg = tree({"assay.json": json.dumps({"baseline": [message]})})
        code, text = run("--root", cfg, "scan", root)
        self.assertEqual(code, 0, text)
        self.assertIn("1 accepted", text)

    def test_a_baseline_entry_that_no_longer_fires_FAILS_on_a_COMPLETE_run(self):
        """The second direction: someone fixed it and left the record claiming
        otherwise, which is how a suppression file becomes a work of fiction."""
        cfg = tree({"assay.json": json.dumps({"baseline": ["a finding long gone"]}),
                    "m.py": "def a(n):\n    return n * 2\n"})
        code, text = run("--root", cfg, "all", "--base", "HEAD")
        self.assertEqual(code, 1)
        self.assertIn("no longer fires", text)

    def test_a_PARTIAL_run_does_not_call_a_baseline_entry_stale(self):
        """The flaw this rule exists for, caught on the tool's own repository.

        `runners` cannot produce a finding that only `diff` reports, so checking
        staleness there flags every `diff` line as fixed — the audit reporting a
        problem with its own config, on a clean tree, on every run. A check that
        cries wolf at itself is the one nobody keeps.
        """
        cfg = tree({"assay.json": json.dumps({"baseline": ["a diff-only finding"]}),
                    "a.py": "x = 1\n"})
        code, text = run("--root", cfg, "runners")
        self.assertEqual(code, 0, text)
        self.assertNotIn("no longer fires", text)
        self.assertIn("staleness needs", text)

    def test_all_folds_in_the_sameness_half_when_asked(self):
        """Without `--scan` a `same answer` line in the baseline would be called
        stale by a run that never scanned anything."""
        root = tree({"m.py": TWINS})
        code, text = run("--root", root, "all", "--base", "HEAD", "--scan", root)
        self.assertEqual(code, 1)
        self.assertIn("same answer", text)

    def test_the_config_is_found_in_root_without_being_named(self):
        root = tree({"assay.json": json.dumps({"baseline": ["nothing"]}),
                     "a.py": "x = 1\n"})
        _code, text = run("--root", root, "runners")
        self.assertIn("assay.json", text)


class AsASubprocess(unittest.TestCase):
    """The installed entry point, exercised the way a user would."""

    def cli(self, *argv, cwd=None):
        proc = subprocess.run([sys.executable, "-m", "assay"] + list(argv),
                              capture_output=True, text=True, cwd=cwd or ROOT,
                              timeout=180)
        return proc.returncode, proc.stdout + proc.stderr

    def test_it_runs_as_a_module(self):
        code, text = self.cli("--version")
        self.assertEqual(code, 0)
        self.assertIn("assay", text)

    def test_it_runs_from_an_UNRELATED_cwd(self):
        """A tool that only works from its own directory is a tool nobody can wire
        into CI."""
        root = tree({"m.py": TWINS})
        env = dict(os.environ, PYTHONPATH=ROOT)
        proc = subprocess.run([sys.executable, "-m", "assay", "scan", root],
                              capture_output=True, text=True,
                              cwd=tempfile.mkdtemp(), env=env, timeout=180)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)

    def test_the_probe_worker_runs_as_a_plain_file_path(self):
        """The parent invokes it by path so it need not know whether the package is
        installed or merely on sys.path."""
        payload = {"preamble": "", "source": "def f(n):\n    return n * 2\n",
                   "name": "f", "inputs": ["(1,)", "(2,)"], "per_input": 1}
        worker = os.path.join(ROOT, "assay", "worker.py")
        proc = subprocess.run([sys.executable, worker], input=json.dumps(payload),
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["outcomes"], ["V:2", "V:4"])


class ItRunsOnItself(unittest.TestCase):

    def test_the_package_holds_no_two_functions_that_answer_the_same_question(self):
        """Merging two tools is exactly when duplication arrives, so the combined
        package is scanned by its own scanner."""
        code, text = run("scan", os.path.join(ROOT, "assay"))
        self.assertEqual(code, 0, text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
