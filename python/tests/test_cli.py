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


def run_stdin(text, *argv):
    """The CLI in-process with `text` on stdin. Returns (code, text)."""
    saved = sys.stdin
    sys.stdin = io.StringIO(text)
    try:
        return run(*argv)
    finally:
        sys.stdin = saved


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


class SearchFromStdin(unittest.TestCase):
    """`search` for a function that is not a file yet.

    SEARCH BEFORE YOU GENERATE cannot mean "first write the file", which is what a
    command taking only a FILE::NAME asks for. Everything downstream of resolving the
    query is the same code path, so these tests are about the query: which function it
    picked, and what it does when it cannot pick one.
    """

    def test_a_snippet_the_tree_already_answers_is_a_finding(self):
        root = tree({"m.py": TWINS})
        snippet = ('def c(s):\n'
                   '    if not isinstance(s, str):\n        raise TypeError("str")\n'
                   '    return s[::-1]\n')
        code, text = run_stdin(snippet, "search", "--stdin", "--in", root)
        self.assertEqual(code, 1, text)
        self.assertIn("<stdin>::c", text)

    def test_a_snippet_nothing_answers_exits_0_and_says_so(self):
        root = tree({"m.py": "def only(n):\n    return n * 3 + 1\n"})
        code, text = run_stdin("def q(n):\n    return n - 17\n",
                               "search", "--stdin", "--in", root)
        self.assertEqual(code, 0, text)
        self.assertIn("none", text)

    def test_the_query_is_named_stdin_rather_than_a_path_it_does_not_have(self):
        """It is excluded from its own hits by REFERENCE, and `<stdin>` collides with
        nothing a tree can contain, so that exclusion needs no special case."""
        root = tree({"m.py": TWINS})
        code, text = run_stdin("def c(s):\n    return s[::-1]\n",
                               "search", "--stdin", "--in", root)
        self.assertIn("<stdin>::c", text)
        self.assertNotIn("<stdin>.py", text)

    def test_several_functions_and_no_name_is_a_REFUSAL_not_a_guess(self):
        """Picking one would make the tool answer about code nobody asked about,
        which reads exactly like an answer about the code they did."""
        code, text = run_stdin("def a(x):\n    return x + 1\n\n"
                               "def b(x):\n    return x * 2\n",
                               "search", "--stdin", "--in", ".")
        self.assertEqual(code, 2)
        self.assertIn("a, b", text)

    def test_name_picks_one_out_of_several(self):
        root = tree({"m.py": "def only(n):\n    return n * 3 + 1\n"})
        code, text = run_stdin("def a(x):\n    return x + 1\n\n"
                               "def b(x):\n    return n_o_p_e\n",
                               "search", "--stdin", "--name", "a", "--in", root)
        self.assertEqual(code, 0, text)
        self.assertIn("<stdin>::a", text)

    def test_a_name_that_is_not_in_the_snippet_exits_2(self):
        code, text = run_stdin("def a(x):\n    return x + 1\n",
                               "search", "--stdin", "--name", "zzz", "--in", ".")
        self.assertEqual(code, 2)
        self.assertIn("no function named zzz", text)

    def test_a_snippet_that_does_not_parse_exits_2(self):
        code, text = run_stdin("def a(x: return\n", "search", "--stdin", "--in", ".")
        self.assertEqual(code, 2)
        self.assertIn("does not parse", text)

    def test_a_snippet_with_no_function_exits_2(self):
        code, text = run_stdin("X = 1\n", "search", "--stdin", "--in", ".")
        self.assertEqual(code, 2)
        self.assertIn("no top-level function", text)

    def test_a_snippet_this_tool_may_not_RUN_is_a_look_and_never_exit_2(self):
        """A function that exists and is refused is not a query that could not be
        read. Collapsing those two is how exit 2 starts meaning `found nothing`."""
        code, text = run_stdin("import time\n\ndef t(x):\n    return time.time() + x\n",
                               "search", "--stdin", "--in", ".")
        self.assertEqual(code, 0)
        self.assertIn("the tree was not searched", text)

    def test_stdin_and_a_reference_are_two_queries_and_exit_2(self):
        root = tree({"m.py": TWINS})
        code, text = run_stdin("def c(s):\n    return s\n", "search", "--stdin",
                               os.path.join(root, "m.py") + "::a", "--in", root)
        self.assertEqual(code, 2)
        self.assertIn("two different queries", text)

    def test_neither_stdin_nor_a_reference_exits_2(self):
        code, text = run("search", "--in", ".")
        self.assertEqual(code, 2)
        self.assertIn("FILE::NAME or --stdin", text)

    def test_name_without_stdin_is_an_ERROR_rather_than_ignored(self):
        """A flag that is accepted, documented and inert is the shape of the `-q`
        defect this CLI already carries a docstring about."""
        root = tree({"m.py": TWINS})
        code, text = run("search", "--name", "a", os.path.join(root, "m.py") + "::a",
                         "--in", root)
        self.assertEqual(code, 2)
        self.assertIn("--name", text)


class WhyOneFunction(unittest.TestCase):
    """`assay why FILE::NAME` — the census, for one name.

    The census gives aggregate refusal reasons with counts, which is the right shape
    for a tree and the wrong shape for a question: a person who expected a particular
    function to be probed cannot read `no arguments 274` and learn whether theirs is
    one of them. Every case here is a `look` or an `ok` and never a finding — this
    command reports what the tool did, and decides nothing.
    """

    FIXTURE = ('def double(x):\n    return x + x\n\n\n'
               'def constant(x):\n    return 1\n\n\n'
               'def identity(x):\n    return x\n\n\n'
               'def nullary():\n    return 1\n\n\n'
               'def raises_on_everything(x):\n    return x.no_such_attribute\n\n\n'
               'import os\n\n\n'
               'def impure(x):\n    return os.getcwd() + x\n')

    def why(self, name):
        root = tree({"m.py": self.FIXTURE})
        return run("why", os.path.join(root, "m.py") + "::" + name)

    def test_a_PROBED_function_says_so_rather_than_staying_silent(self):
        """"It was probed" and "nothing looked at it" are different claims, and only
        one of them is evidence."""
        code, text = self.why("double")
        self.assertEqual(code, 0)
        self.assertIn("probed on arity1/", text)
        self.assertIn("distinct value", text)

    def test_a_GATE_that_refused_is_named(self):
        code, text = self.why("impure")
        self.assertEqual(code, 0)
        self.assertIn("touches os", text)

    def test_a_ZERO_ARITY_function_gets_the_gate_the_census_counts(self):
        _code, text = self.why("nullary")
        self.assertIn("no arguments", text)

    def test_a_CONSTANT_and_a_PROJECTION_are_told_apart(self):
        """The census collapses both into `not discriminated by the ladder`, which is
        one reason with two very different answers: a constant needs a wider ladder and
        a projection needs a different function."""
        _c, constant = self.why("constant")
        _p, projection = self.why("identity")
        self.assertIn("it is a constant", constant)
        self.assertNotIn("projection", constant)
        self.assertIn("a projection", projection)
        self.assertNotIn("it is a constant", projection)

    def test_a_vector_that_RAISED_EVERYWHERE_is_not_called_a_constant(self):
        """A function the ladder never reached is a different problem from one it
        reached and found constant: the first needs inputs of another shape, the
        second needs a wider ladder. Both are `not discriminated`, and saying which
        is the whole point of this command."""
        _code, text = self.why("raises_on_everything")
        self.assertIn("raised on all", text)
        self.assertNotIn("it is a constant", text)

    def test_it_NEVER_produces_a_finding(self):
        for name in ("double", "constant", "identity", "nullary", "impure",
                     "raises_on_everything"):
            code, _text = self.why(name)
            self.assertEqual(code, 0, name)

    def test_a_missing_FILE_and_a_missing_NAME_are_different_answers(self):
        """`resolve` collapses them because a scan does not care which; this command
        is the one that does. They send you to two different places."""
        code, missing_file = run("why", "nowhere.py::x")
        self.assertEqual(code, 2)
        self.assertIn("no such file", missing_file)
        code, missing_name = self.why("notafunction")
        self.assertEqual(code, 2)
        self.assertIn("no module-level function named", missing_name)
        self.assertIn("double", missing_name)

    def test_a_file_that_does_not_PARSE_says_that_rather_than_cannot_resolve(self):
        root = tree({"broken.py": "def (:\n"})
        code, text = run("why", os.path.join(root, "broken.py") + "::anything")
        self.assertEqual(code, 2)
        self.assertIn("does not parse", text)

    def test_a_reference_with_no_separator_exits_2(self):
        code, text = run("why", "justaname")
        self.assertEqual(code, 2)
        self.assertIn("FILE::NAME", text)


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
        # `--scan` is what makes the run complete: without it the sameness half did not
        # run, so an UNTAGGED line — one that names no command — is still unchecked.
        code, text = run("--root", cfg, "all", "--base", "HEAD", "--scan", cfg)
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
        self.assertIn("NOT checked for staleness", text)
        self.assertIn("needs `assay all`", text)

    def test_SCAN_does_not_claim_it_performed_every_audit_either(self):
        """Driven per COMMAND rather than once: `performed` is a literal at each call
        site, so a command that claims more than it did is a defect one test cannot
        see. The JavaScript half's equivalent was NOT DETECTED until it existed."""
        cfg = tree({"assay.json": json.dumps({"baseline": ["a runners-only finding"]}),
                    "m.py": "def a(n):\n    return n * 2\n"})
        code, text = run("--root", cfg, "scan", cfg)
        self.assertEqual(code, 0, text)
        self.assertNotIn("no longer fires", text)
        self.assertIn("NOT checked for staleness", text)

    def test_a_line_that_NAMES_its_command_is_answered_by_that_command(self):
        """The point of `from`. `assay runners` knows perfectly well whether a
        `runners` finding fired, and needed a whole `assay all` to be allowed to say
        so — which meant a project running the subcommands separately never got the
        second direction at all."""
        cfg = tree({"assay.json": json.dumps({"baseline": [
            {"line": "a runners finding long gone", "reason": "read it",
             "from": "runners"}]}),
            "a.py": "x = 1\n"})
        code, text = run("--root", cfg, "runners")
        self.assertEqual(code, 1, text)
        self.assertIn("no longer fires", text)

    def test_a_line_from_ANOTHER_command_is_counted_rather_than_called_stale(self):
        """The cry-wolf failure, and why the first fix was a whole-run flag. What is
        new is that the lines nobody could check are COUNTED: `0 stale` from a run that
        never looked reads as `nothing is stale`, and those are different claims."""
        cfg = tree({"assay.json": json.dumps({"baseline": [
            {"line": "an anchors finding", "reason": "read it", "from": "anchors"}]}),
            "a.py": "x = 1\n"})
        code, text = run("--root", cfg, "runners")
        self.assertEqual(code, 0, text)
        self.assertNotIn("no longer fires", text)
        self.assertIn("NOT checked for staleness (anchors: 1)", text)

    def test_all_WITHOUT_scan_does_not_claim_it_performed_the_sameness_half(self):
        """`--scan` is what makes `all` complete, and the flag used to say complete
        either way — so a `same answer` line was called stale by a run that never
        scanned anything, on a clean tree."""
        cfg = tree({"assay.json": json.dumps({"baseline": [
            {"line": "same answer (arity1/v3): a.py::x, b.py::y",
             "reason": "read them", "from": "scan"}]}),
            "a.py": "x = 1\n"})
        # The exit code is not asserted: a temp directory is not a git repository, so
        # `diff` reports one of its own findings here and the run fails for a reason
        # that has nothing to do with the baseline.
        _code, text = run("--root", cfg, "all", "--base", "HEAD")
        self.assertNotIn("no longer fires", text)
        self.assertIn("NOT checked for staleness (scan: 1)", text)

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
