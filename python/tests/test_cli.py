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


class JsonOutput(unittest.TestCase):
    """`--json`: the same Report, in the shape a machine can read.

    ONE SHAPE, ALWAYS. A run that could not start emits the same keys as one that
    finished, because prose on the failure path and JSON everywhere else hands a
    consumer a parse error at exactly the moment the tool could not run — and a sloppy
    consumer reads a parse error as no findings. "Could not run" and "found nothing"
    are opposite situations, and this is where letting the second swallow the first is
    easiest to do by accident.
    """

    KEYS = {"schema", "tool", "version", "language", "command", "root", "error",
            "items", "notes", "baseline", "scan", "exit_code"}

    def payload(self, *argv):
        code, text = run(*argv)
        try:
            data = json.loads(text)
        except ValueError:                                # pragma: no cover
            self.fail("--json printed something that is not JSON: %r" % text[:200])
        return code, data

    def test_every_subcommand_emits_the_SAME_KEYS(self):
        root = tree({"m.py": TWINS})
        for argv in (("--root", root, "runners"), ("--root", root, "anchors"),
                     ("scan", root), ("pair", os.path.join(root, "m.py") + "::a",
                                      os.path.join(root, "m.py") + "::b"),
                     ("search", os.path.join(root, "m.py") + "::a", "--in", root)):
            with self.subTest(argv=argv[0]):
                _code, data = self.payload("--json", *argv)
                self.assertEqual(set(data), self.KEYS)

    def test_the_payload_exit_code_IS_the_process_exit_code(self):
        """Agreeing by construction is worth proving: a consumer that trusts the field
        and a script that trusts the code must never be told two different things."""
        root = tree({"m.py": TWINS})
        for argv in (("scan", root), ("scan", tree({"m.py": "def f(n):\n    return n\n"})),
                     ("search", "nope.py::x", "--in", root)):
            with self.subTest(argv=argv):
                code, data = self.payload("--json", *argv)
                self.assertEqual(code, data["exit_code"])

    def test_a_finding_travels_with_its_verdict_rather_than_a_severity(self):
        """Mapping the three verdicts onto somebody else's error/warning/note is the
        collapse the verdict vocabulary exists to prevent."""
        root = tree({"m.py": TWINS})
        code, data = self.payload("--json", "scan", root)
        self.assertEqual(code, 1)
        verdicts = {i["verdict"] for i in data["items"]}
        self.assertIn("finding", verdicts)
        self.assertTrue(all(set(i) == {"verdict", "message", "where", "detail"}
                            for i in data["items"]))

    def test_a_look_is_carried_and_still_exits_0(self):
        root = tree({"m.py": "import time\n\ndef t(n):\n    return time.time() + n\n"})
        code, data = self.payload("--json", "pair", os.path.join(root, "m.py") + "::t",
                                  os.path.join(root, "m.py") + "::t")
        self.assertEqual(code, 0)
        self.assertEqual(data["exit_code"], 0)
        self.assertIn("look", {i["verdict"] for i in data["items"]})

    def test_a_run_that_could_not_start_emits_JSON_and_exits_2(self):
        root = tree({"a.py": "x = 1\n", "assay.json": "{not json"})
        code, data = self.payload("--root", root, "--json", "runners")
        self.assertEqual(code, 2)
        self.assertEqual(data["exit_code"], 2)
        self.assertIn("not valid JSON", data["error"])
        self.assertEqual(data["items"], [])
        self.assertEqual(set(data), self.KEYS)

    def test_no_subcommand_under_json_is_an_error_object_not_the_help_text(self):
        code, data = self.payload("--json")
        self.assertEqual(code, 2)
        self.assertEqual(data["error"], "no subcommand")

    def test_the_census_is_DATA_rather_than_the_printed_equation(self):
        """`probed + not_probed` equals `functions`, and a consumer can check that
        here rather than by parsing our own prose back out of `notes`."""
        code, data = self.payload("--json", "scan", os.path.join(ROOT, "assay"))
        self.assertEqual(code, 0)
        census = data["scan"]
        self.assertEqual(census["probed"] + census["not_probed"], census["functions"])
        # FILES ARE A SEPARATE POPULATION. Adding the two totals together prints a
        # number nobody measured, so they are two counts and not one.
        self.assertIn("files", census)
        self.assertGreater(census["files"], 0)

    def test_a_command_that_ran_no_scan_says_null_rather_than_zero(self):
        """Zero probed functions and no sameness half at all are different claims."""
        _code, data = self.payload("--root", tree({"a.py": "x = 1\n"}), "--json",
                                   "runners")
        self.assertIsNone(data["scan"])

    def test_the_baseline_carries_WHAT_it_could_not_check_for_staleness(self):
        """The caveat travels as data, and it is a LIST rather than a boolean now.

        Completeness stopped being a property of the run when a baseline entry learned
        to name the command that fires it: `performed` says what this run audited, and
        `unchecked` names each entry it could not have seen fire. A consumer reading
        `stale: []` and nothing else would read "nothing is stale", which is a
        different claim from "this run never looked".
        """
        root = tree({"m.py": TWINS, "assay.json": json.dumps(
            {"baseline": ["same answer (arity1/v3): x, y"]})})
        _code, data = self.payload("--root", root, "--json", "scan", root)
        self.assertEqual(data["baseline"]["performed"], ["scan"])
        self.assertEqual(data["baseline"]["stale"], [])
        self.assertEqual([e["line"] for e in data["baseline"]["unchecked"]],
                         ["same answer (arity1/v3): x, y"])
        self.assertIsNone(data["baseline"]["unchecked"][0]["from"])
        _code, complete = self.payload("--root", root, "--json", "all",
                                       "--scan", root)
        self.assertEqual(complete["baseline"]["performed"],
                         ["anchors", "diff", "runners", "scan"])
        self.assertEqual(complete["baseline"]["unchecked"], [])
        self.assertEqual(complete["baseline"]["stale"],
                         ["same answer (arity1/v3): x, y"])

    def test_a_TAGGED_baseline_entry_is_answered_by_one_command_in_JSON_too(self):
        """The per-line rule, in the shape a machine reads. `assay scan` performed the
        audit that fires this line, so it is stale — and nothing is left unchecked."""
        root = tree({"m.py": TWINS, "assay.json": json.dumps({"baseline": [
            {"line": "a scan finding long gone", "reason": "read it",
             "from": "scan"}]})})
        _code, data = self.payload("--root", root, "--json", "scan", root)
        self.assertEqual(data["baseline"]["stale"], ["a scan finding long gone"])
        self.assertEqual(data["baseline"]["unchecked"], [])

    def test_json_prints_JSON_AND_NOTHING_ELSE(self):
        """A prose banner in front of the object is a parse error, and a parse error
        at exactly the wrong moment reads as a clean audit."""
        root = tree({"m.py": TWINS})
        _code, text = run("--json", "scan", root)
        self.assertTrue(text.lstrip().startswith("{"), text[:80])
        json.loads(text)

    def test_json_emits_keys_in_SORTED_ORDER_all_the_way_down(self):
        """`json.dump` is asked to sort and `JSON.stringify` emits insertion order, so
        without this the two halves print the same data as two different documents."""
        _code, text = run("--json", "scan", tree({"m.py": TWINS}))
        data = json.loads(text)
        for obj in (data, data["scan"], data["items"][0]):
            self.assertEqual(list(obj), sorted(obj))

    def test_json_works_on_BOTH_sides_of_the_subcommand(self):
        root = tree({"m.py": TWINS})
        first, _ = self.payload("--json", "scan", root)
        second, _ = self.payload("scan", root, "--json")
        self.assertEqual(first, second)

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


class SearchThatCouldNotHaveMATCHED(unittest.TestCase):
    """A query the ladder cannot discriminate, which `search` used to call `none`.

    `collect` files every function the ladder cannot tell apart under skipped, so a
    constant query can only fail to find the other constants: the match was never
    possible, and the tree was never really searched. Printing the clean `same none`
    there states the one thing this tool refuses to state — found none, where the
    truth is never looked. `why` already answered this question about the same vector,
    so `search` gives the same answer from the same function.

    THE COST LANDS ON THE BUSIEST PATH. `--stdin` is search before you generate, so
    the person reading that line is about to write the function.
    """

    CONSTANT = "def k(n):\n    return 7\n"
    PROJECTION = "def p(n):\n    return n\n"
    RAISES = "def r(n):\n    return n.no_such_attribute\n"
    TREE = {"m.py": "def only(n):\n    return n * 3 + 1\n"}

    def search(self, snippet):
        return run_stdin(snippet, "search", "--stdin", "--in", tree(self.TREE))

    def test_a_CONSTANT_query_is_a_look_rather_than_a_clean_none(self):
        code, text = self.search(self.CONSTANT)
        self.assertEqual(code, 0, text)
        self.assertIn("not discriminated by the ladder", text)
        self.assertIn("it is a constant", text)
        self.assertNotIn("nothing in the tree matched", text)

    def test_a_PROJECTION_query_is_told_apart_from_a_constant(self):
        """The two need opposite fixes — a wider ladder, or a different function — and
        `search` inherits that split rather than repeating the decision."""
        code, text = self.search(self.PROJECTION)
        self.assertEqual(code, 0, text)
        self.assertIn("a projection", text)
        self.assertNotIn("it is a constant", text)
        self.assertNotIn("nothing in the tree matched", text)

    def test_a_query_that_RAISED_EVERYWHERE_is_not_called_a_constant(self):
        _code, text = self.search(self.RAISES)
        self.assertIn("raised on all", text)
        self.assertNotIn("it is a constant", text)

    def test_it_says_the_tree_was_NOT_searched(self):
        """"We found none" and "we never looked" are different claims. This is the
        second way not to look, and it used to print as the first."""
        _code, text = self.search(self.CONSTANT)
        self.assertIn("the tree was not searched", text)

    def test_a_DISCRIMINATING_query_still_gets_the_clean_none(self):
        """The check must not swallow the result it was added to protect: a real
        search that really found nothing still says so."""
        code, text = self.search("def q(n):\n    return n - 17\n")
        self.assertEqual(code, 0, text)
        self.assertIn("nothing in the tree matched", text)
        self.assertNotIn("not discriminated by the ladder", text)

    def test_a_FILE_NAME_query_gets_the_SAME_answer_as_a_snippet(self):
        """The two ways in differ in where the text came from and nowhere else."""
        root = tree({"m.py": self.CONSTANT})
        code, text = run("search", os.path.join(root, "m.py") + "::k", "--in", root)
        self.assertEqual(code, 0, text)
        self.assertIn("not discriminated by the ladder", text)
        self.assertIn("it is a constant", text)

    def test_search_and_why_give_ONE_answer_for_ONE_function(self):
        """The defect this replaced was the two of them disagreeing: `why` said the
        ladder could not see the function and `search`, on the same vector, printed
        the result that means a clean sweep."""
        root = tree({"m.py": self.PROJECTION})
        ref = os.path.join(root, "m.py") + "::p"
        _c, searched = run("search", ref, "--in", root)
        _w, asked = run("why", ref)
        line = "%s — not discriminated by the ladder" % ref
        self.assertIn(line, searched)
        self.assertIn(line, asked)
        for text in (searched, asked):
            self.assertIn("a projection: everywhere it answered", text)

    def test_the_verdict_IS_a_look_rather_than_an_ok_that_reads_as_clean(self):
        """The whole answer is the verdict. An `ok` carrying the same sentence says
        the tool decided and found nothing wrong, which is the claim it must not make
        — and it would read identically in the prose the eye skims."""
        root = tree({"m.py": self.CONSTANT})
        _code, text = run("--json", "search", os.path.join(root, "m.py") + "::k",
                          "--in", root)
        items = json.loads(text)["items"]
        undiscriminated = [i for i in items
                           if "not discriminated by the ladder" in i["message"]]
        self.assertEqual(len(undiscriminated), 1, items)
        self.assertEqual(undiscriminated[0]["verdict"], "look")

    def test_a_look_here_NEVER_fails_the_run(self):
        for snippet in (self.CONSTANT, self.PROJECTION, self.RAISES):
            code, text = self.search(snippet)
            self.assertEqual(code, 0, text)


class WhyFromStdin(unittest.TestCase):
    """`assay why --stdin` — the same question, about code that is not a file yet.

    `search --stdin` has to answer it on the way, so asking it directly should not
    require inventing a file: writing the file first in order to be told the file was
    never the problem is the shape `--stdin` exists to avoid.
    """

    def test_a_snippet_gets_the_same_answer_as_the_file_it_will_become(self):
        source = "def constant(x):\n    return 1\n"
        root = tree({"m.py": source})
        _c, from_file = run("why", os.path.join(root, "m.py") + "::constant")
        _s, from_stdin = run_stdin(source, "why", "--stdin")
        for text in (from_file, from_stdin):
            self.assertIn("not discriminated by the ladder", text)
            self.assertIn("it is a constant", text)
        self.assertIn("<stdin>::constant", from_stdin)

    def test_a_PROBED_snippet_says_so_rather_than_staying_silent(self):
        code, text = run_stdin("def double(x):\n    return x + x\n", "why", "--stdin")
        self.assertEqual(code, 0, text)
        self.assertIn("probed on arity1/", text)

    def test_a_GATE_that_refused_a_snippet_is_named(self):
        code, text = run_stdin("import os\n\ndef f(x):\n    return os.getcwd() + x\n",
                               "why", "--stdin")
        self.assertEqual(code, 0, text)
        self.assertIn("touches os", text)

    def test_name_picks_one_function_out_of_a_snippet(self):
        code, text = run_stdin("def a(x):\n    return x + 1\n\n\n"
                               "def b(x):\n    return x * 2\n",
                               "why", "--stdin", "--name", "b")
        self.assertEqual(code, 0, text)
        self.assertIn("<stdin>::b", text)
        self.assertNotIn("<stdin>::a", text)

    def test_an_AMBIGUOUS_snippet_is_refused_rather_than_guessed(self):
        code, text = run_stdin("def a(x):\n    return x + 1\n\n\n"
                               "def b(x):\n    return x * 2\n", "why", "--stdin")
        self.assertEqual(code, 2)
        self.assertIn("name one with --name", text)

    def test_neither_stdin_nor_a_reference_exits_2_and_names_BOTH_ways_in(self):
        code, text = run("why")
        self.assertEqual(code, 2)
        self.assertIn("why needs a FILE::NAME or --stdin", text)

    def test_stdin_and_a_reference_are_two_queries_and_exit_2(self):
        code, text = run_stdin("def a(x):\n    return x\n", "why", "--stdin",
                               "m.py::a")
        self.assertEqual(code, 2)
        self.assertIn("two different queries", text)

    def test_name_without_stdin_is_an_ERROR_rather_than_ignored(self):
        """A flag that is accepted, documented and inert is the defect this CLI
        already carries two docstrings about."""
        code, text = run("why", "--name", "a", "m.py::a")
        self.assertEqual(code, 2)
        self.assertIn("--name selects a function inside a --stdin snippet", text)


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


class Accept(unittest.TestCase):
    """`assay accept` — the command that writes the baseline line for you.

    THE 0.2.2 CHANGELOG RECORDS SHIPPING A CONFIG EXAMPLE THAT BASELINED A `look`. A
    look never fails the run, so the line could never be suppressed and could never
    expire: a record of nothing, indistinguishable from a record of something already
    fixed. That was fixed by editing the example, and an example is fixed once per copy
    of it. These drive the command that cannot make the mistake at all.
    """

    RUNNER = 'MUTATIONS = [("label", "    return x + 1", "    return x - 1")]\n'
    UNREADABLE = 'MUTATIONS = [("a label", "b", "c", "d", "e", "f")]\n'
    SIGTERM = ("mutations_x.py: no `sigterm` (SIGTERM does not run `finally`; "
               "a kill leaves the tree broken)")

    def project(self, body=None, config=None):
        files = {"mutations_x.py": body if body is not None else self.RUNNER}
        if config is not None:
            files["assay.json"] = json.dumps(config)
        return tree(files)

    def written(self, root):
        with open(os.path.join(root, "assay.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def test_it_REFUSES_without_a_reason(self):
        """The same rule an exemption follows. An acceptance without one cannot be
        told from an oversight, and this is the table that rots fastest."""
        root = self.project()
        code, text = run("--root", root, "accept", "--base", "HEAD")
        self.assertEqual(code, 2)
        self.assertIn("--reason", text)
        self.assertFalse(os.path.exists(os.path.join(root, "assay.json")))

    def test_it_writes_the_LINE_the_REASON_and_what_FIRES_it(self):
        root = self.project()
        code, text = run("--root", root, "accept", self.SIGTERM,
                         "--reason", "a tempdir, so a kill leaves nothing mutated",
                         "--base", "HEAD")
        self.assertEqual(code, 0, text)
        self.assertEqual(self.written(root)["baseline"], [{
            "line": self.SIGTERM,
            "reason": "a tempdir, so a kill leaves nothing mutated",
            "from": "runners"}])

    def test_what_it_wrote_is_then_SUPPRESSED_by_the_audit_that_fires_it(self):
        """The round trip is the point: the entry is the finding's exact text, taken
        from the run rather than typed, which is what makes whole-line matching safe."""
        root = self.project()
        run("--root", root, "accept", self.SIGTERM, "--reason", "r", "--base", "HEAD")
        _code, text = run("--root", root, "runners")
        self.assertIn("1 accepted", text)
        self.assertNotIn(self.SIGTERM, text.split("FINDINGS")[-1])

    def test_it_REFUSES_a_look(self):
        """A `look` never fails the run, so there is nothing to accept — and a
        baselined look is a record that can never match and never expire."""
        root = self.project(self.UNREADABLE)
        _c, anchors_text = run("--root", root, "anchors")
        look = [l.split("look     ", 1)[1].strip()
                for l in anchors_text.splitlines() if "  look     " in l][0]
        code, text = run("--root", root, "accept", look, "--reason", "r",
                         "--base", "HEAD")
        self.assertEqual(code, 2)
        self.assertIn("`look` never fails the run", text)
        self.assertFalse(os.path.exists(os.path.join(root, "assay.json")))

    def test_it_REFUSES_a_line_nothing_printed(self):
        """Accepting a line that does not fire writes an entry that is stale the
        moment it lands, and the file then arrives already claiming something untrue."""
        root = self.project()
        code, text = run("--root", root, "accept", "a finding I invented",
                         "--reason", "r", "--base", "HEAD")
        self.assertEqual(code, 2)
        self.assertIn("stale the moment it lands", text)

    def test_it_REFUSES_a_line_already_accepted(self):
        root = self.project(config={"baseline": [
            {"line": self.SIGTERM, "reason": "read it", "from": "runners"}]})
        code, text = run("--root", root, "accept", self.SIGTERM, "--reason", "r",
                         "--base", "HEAD")
        self.assertEqual(code, 2)
        self.assertIn("already in the baseline", text)

    def test_with_no_LINE_it_accepts_every_NEW_finding(self):
        root = self.project()
        code, _text = run("--root", root, "accept", "--reason", "adopting this",
                          "--base", "HEAD")
        self.assertEqual(code, 0)
        lines = [e["line"] for e in self.written(root)["baseline"]]
        self.assertIn(self.SIGTERM, lines)
        self.assertTrue(all(e["reason"] == "adopting this"
                            for e in self.written(root)["baseline"]))

    def test_it_leaves_every_OTHER_key_and_every_existing_entry_alone(self):
        """Rewriting somebody's file into a shape they did not ask for is not the job
        of a command asked to add one line."""
        root = self.project(config={
            "runner_exempt": [{"path": "other.py", "reason": "elsewhere"}],
            "baseline": ["a line pasted straight out of a run"]})
        run("--root", root, "accept", self.SIGTERM, "--reason", "r", "--base", "HEAD")
        raw = self.written(root)
        self.assertEqual(raw["runner_exempt"],
                         [{"path": "other.py", "reason": "elsewhere"}])
        self.assertEqual(raw["baseline"][0], "a line pasted straight out of a run")
        self.assertEqual(raw["baseline"][1]["line"], self.SIGTERM)

    def test_nothing_new_is_not_an_error(self):
        root = self.project(config={"baseline": []})
        run("--root", root, "accept", "--reason", "r", "--base", "HEAD")
        code, text = run("--root", root, "accept", "--reason", "r", "--base", "HEAD")
        self.assertEqual(code, 0)
        self.assertIn("nothing new to accept", text)


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
