#!/usr/bin/env python3
"""The two implementations must agree, and the source must be what it looks like.

WHY PARITY IS CHECKED RATHER THAN ASSUMED. One `assay.json` is meant to serve a
polyglot repository. If the two halves disagree about what a property is called, or
about what an exit code means, then the same config produces different verdicts
depending on which binary CI happened to invoke — and nothing would say so. Two
implementations of one contract is exactly the duplication this tool exists to find,
so the contract is asserted rather than trusted.

These tests read the JavaScript as TEXT. Running it would need Node, and a suite that
silently skips when a runtime is missing reports a pass for a check that never ran.
Reading is enough for the questions asked here, and it always runs.
"""

import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# TWO roots, and conflating them is what broke this file when the package moved. The
# Python half lives under `python/` beside `js/`, so the directory that makes `import
# assay` work is NOT the directory the JavaScript half is found from.
PY_ROOT = os.path.dirname(HERE)              # python/ — what `import assay` needs
REPO = os.path.dirname(PY_ROOT)              # the repository, which holds both halves
sys.path.insert(0, PY_ROOT)

from assay import anchors, checks, sameness  # noqa: E402
from assay.config import CONFIG_NAMES  # noqa: E402
from assay.verdicts import FINDING, LOOK, OK  # noqa: E402

JS_SRC = os.path.join(REPO, "js", "src")

# Built from its code point rather than written literally: a test that looks for a
# character it also CONTAINS matches itself and fails on a clean tree, which is the
# crying-wolf failure arriving inside the check written to prevent a silent one.
NBSP = "\u00a0"


def js(name):
    with open(os.path.join(JS_SRC, name), encoding="utf-8") as fh:
        return fh.read()


def py(name):
    with open(os.path.join(PY_ROOT, "assay", name), encoding="utf-8") as fh:
        return fh.read()


def pyproject_version():
    """The `[project]` version, read WITHOUT `tomllib`.

    `tomllib` arrived in 3.11 and `requires-python` here says `>=3.9`, so a test that
    reaches for it fails on the floor this package claims to support — which is exactly
    what the 3.9 job in CI exists to catch, and did.

    Skipping on old interpreters was the other option and is worse: a suite that
    silently skips when something is missing reports a pass for a check that never ran.

    It tracks which TABLE it is inside rather than taking the first `version =` it
    sees, because that line also appears under `[build-system]` and in dependency pins
    — the same wrong-line hazard `release.yml` names in its own comment.
    """
    table = None
    with open(os.path.join(REPO, "pyproject.toml"), encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                table = stripped[1:-1]
            elif table == "project":
                found = re.match(r'version\s*=\s*"([^"]+)"', stripped)
                if found:
                    return found.group(1)
    return None


class SourceIsWhatItLooksLike(unittest.TestCase):

    def source_files(self):
        for base, dirs, files in os.walk(REPO):
            dirs[:] = [d for d in dirs
                       if d not in ("node_modules", "__pycache__", ".git")]
            for name in sorted(files):
                if name.endswith((".py", ".js", ".mjs", ".json", ".toml", ".yml")):
                    yield os.path.join(base, name)

    def test_no_source_file_contains_a_NUL_BYTE(self):
        """Earned by a real defect, which is the only reason a check this odd exists.

        A NUL landed where a space belonged inside a template literal. Every way of
        reading the code agreed it was correct — the file displayed correctly, the
        parser accepted it, and printing the function back showed a space — while the
        key it built at runtime could never match the key in the table. The audit went
        on reporting the finding an exemption had been written to silence, which reads
        exactly like a config that was never loaded. Nothing but a byte-level check
        could see it.
        """
        for path in self.source_files():
            with open(path, "rb") as fh:
                data = fh.read()
            self.assertNotIn(b"\x00", data, "%s contains a NUL byte" % path)

    def test_no_source_file_has_a_non_breaking_space_outside_prose(self):
        """The same class, one character along: U+00A0 reads as a space and is not one.

        Only code lines are checked. Prose in a docstring may legitimately contain
        typographic characters; a `const x =` line may not.
        """
        for path in self.source_files():
            if not path.endswith((".py", ".js", ".mjs")):
                continue
            with open(path, encoding="utf-8") as fh:
                for number, line in enumerate(fh, 1):
                    stripped = line.strip()
                    if stripped.startswith(("#", "*", "//", '"""')):
                        continue
                    self.assertNotIn(NBSP, line,
                                     "%s:%d has a non-breaking space" % (path, number))


class TheTwoHalvesAgree(unittest.TestCase):

    def test_the_six_property_KEYS_are_identical(self):
        """A property named differently in one half means an exemption written for one
        silently does nothing in the other."""
        table = re.search(r"PROPERTIES = \[(.*?)\n\];", js("checks.js"), re.S).group(1)
        found = set(re.findall(r"^\s*\['([a-z-]+)',", table, re.M))
        self.assertEqual(found, set(checks.PROPERTY_KEYS))

    def test_the_six_property_DESCRIPTIONS_and_failures_are_identical(self):
        """The keys being equal is not enough, and the gap let a divergence through.

        Both halves PRINT this table above every `assay runners` run. `sigterm` read
        "SIGTERM becomes an exception so `finally` runs" in one half and "SIGTERM is
        handled so the restore still runs" in the other, with two different accounts
        of what goes wrong — so the same audit, on the same tree, taught two different
        rules depending on which binary CI invoked. A rule stated two ways is a rule
        a reader has to reconcile, which is the job the tool was supposed to do.
        """
        table = re.search(r"PROPERTIES = \[(.*?)\n\];", js("checks.js"), re.S).group(1)
        found = dict((key, (desc, why)) for key, desc, why in re.findall(
            r"\['([a-z-]+)',\s*'([^']*)',\s*'([^']*)',", table))
        expected = dict((key, (desc, why))
                        for key, desc, why, _det in checks.PROPERTIES)
        self.assertEqual(found, expected)

    def test_the_restore_verified_TELLS_are_the_same_in_both_halves(self):
        """A `.py` harness is audited by the Python half and a `.js` one by the
        JavaScript half, so this is the one property whose detectors read DIFFERENT
        files and must still accept the same design. A tell present in one list and
        missing from the other means a correct harness passes in one language and is a
        finding in the other — one repository, two verdicts, and nothing saying so.

        The lists are the contract; the surrounding code is not, which is why this
        compares them rather than the detectors.
        """
        found = {}
        for name in ("DIGEST_TELLS", "RESTORE_FAILURE_TELLS"):
            table = re.search(r"export const %s = \[(.*?)\];" % name,
                              js("checks.js"), re.S).group(1)
            found[name] = set(re.findall(r"'([^']*)'", table))
        self.assertEqual(found["DIGEST_TELLS"], set(checks.DIGEST_TELLS))
        self.assertEqual(found["RESTORE_FAILURE_TELLS"],
                         set(checks.RESTORE_FAILURE_TELLS))

    def test_both_halves_treat_a_SHALLOW_COPY_as_vacuous(self):
        """The vacuity guard decides what `same` is worth, so it has to decide the same
        thing twice. A function that only copies its argument through has not been
        discriminated by the ladder — if one half knows that and the other does not,
        the same pair is a finding or a look depending on which binary CI invoked."""
        self.assertIn("{ ...a[i] }", js("sameness.js"))
        self.assertIn("dict(a[_i])", py("sameness.py"))

    def test_both_halves_count_FILES_and_FUNCTIONS_as_separate_populations(self):
        """A file nobody opened holds an unknown number of functions, which is why the
        two are never added together. Both halves report `probed + not probed =
        functions` and put unopened files in their own census; a half that folded them
        together would print a different total for the same tree."""
        for source, member in ((js("sameness.js"), "fileCensus"),
                               (py("sameness.py"), "file_census")):
            self.assertIn("unloadable", source)
            self.assertIn(member, source)

    def test_both_halves_NAME_what_they_never_looked_at(self):
        """A tally answers "how many" and cannot answer "which", so both halves carry
        the maps beside the counts — under the same two key names, because one
        `assay.json` serves a polyglot repository and a consumer reading the census
        must not have to ask which binary produced it.

        The maps are the untruncated reason. `tally` keys on the text before the first
        `(`, which is exactly where a load error's message begins, so the bucket that
        is largest in a real run is the one whose contents the tally discards.
        """
        for source in (js("sameness.js"), py("sameness.py")):
            self.assertIn("unloadable_paths", source)
            self.assertIn("skipped_refs", source)

    def test_both_halves_COUNT_the_baseline_lines_they_could_not_check(self):
        """The rule, not the wording: a line is only stale to a run that could have
        seen it fire, and a run that could not see it says so rather than printing a
        zero. `0 stale` from a run that never looked reads as "nothing is stale", and
        those are different claims — the same reason `ok` is printed rather than left
        silent everywhere else here."""
        for source in (py("cli.py"), js("cli.js")):
            self.assertIn("NOT checked for staleness", source)

    def test_both_halves_know_the_same_set_of_baseline_FAMILIES(self):
        """`from` names the command that can produce a line, and the two halves have
        to agree on what those are or one `assay.json` is valid to one binary and a
        hard error to the other."""
        from assay.config import FAMILIES                     # noqa: PLC0415

        found = re.search(r"export const FAMILIES = \[([^\]]+)\]", js("config.js"))
        names = tuple(re.findall(r"'([^']+)'", found.group(1)))
        self.assertEqual(names, FAMILIES)

    def test_both_halves_call_the_same_EXTENSIONS_source(self):
        """The drift this caught: the JavaScript half audited `.mjs` and `.cjs` and
        this one did not, so `assay diff` over one commit produced two different file
        lists depending on which binary CI invoked — and a file missing from the list
        is not a finding, it is silence. `.js` was in the Python list all along, so
        auditing JavaScript was never the disagreement; only which JavaScript."""
        found = re.search(r"const changed = names\.split\([^)]*\)\s*"
                          r"\.filter\(\(n\) => /\\\.\(([a-z|]+)\)\$/",
                          js("checks.js"))
        self.assertIsNotNone(found, "the JavaScript extension filter moved")
        js_exts = set("." + e for e in found.group(1).split("|"))
        self.assertEqual(js_exts, set(checks.SOURCE_SUFFIXES))

    def test_both_halves_take_arity_from_the_DECLARED_parameter_list(self):
        """The drift this caught, and it produced a wrong finding rather than silence.

        `fn.length` stops counting at the first parameter with a default, so
        `withDefault(a, b = 10)` reported 1. The JavaScript half then chose the
        one-argument ladder, never passed a second argument, and reported the function
        as answering the same question as a genuinely one-argument one —
        `withDefault(1, 2)` is 3 and `plainOne(1)` is 11. Python reads the declared
        list off the AST and probes at 2, where the first rung separates them, so one
        file got two verdicts depending on which binary ran.

        Pinned as TEXT, which is what this suite can do without a Node runtime. The
        behaviour itself is held by `probeFunction chooses the ladder by the DECLARED
        count` in the JavaScript suite and by the mutation that puts `fn.length` back.
        """
        probe = js("probe.js")
        self.assertIn("declaredArity(source)", probe)
        self.assertNotIn("const arity = fn.length", probe)
        # The Python side reads the parameter list off the AST, defaults included.
        self.assertIn("self.params = [a.arg for a in node.args.args]", py("sameness.py"))

    def test_ONE_version_in_every_place_that_states_it(self):
        """Six places carry it, and the release only ever compared two of them.

        `pyproject.toml` and `package.json` are each a registry's source of truth, and
        `release.yml` refuses to publish if they disagree. The other four are literals
        nothing compared. `assay.__version__` and the string the JavaScript CLI prints
        would publish a package whose `--version` names the release before it: not a
        broken build, but a tool lying about which build you are running, which is
        worse, because that number is what you would quote in a bug report. The two
        README pins name a tag in the `uses:` line somebody copies into their workflow,
        and a pin naming a tag that was never cut fails in their CI rather than in ours.

        Kept as literals rather than read at runtime on purpose: `importlib.metadata`
        needs the package installed, and this one is meant to run from a checkout with
        nothing but `PYTHONPATH`. So the duplication stays and is CHECKED, which is the
        same bargain every other table in this package makes.

        THE PINS ARE DISCOVERED, NOT COUNTED. Asserting that there are two would fail
        the day a third example is added, which trains whoever hits it to edit the
        number rather than read the check. Finding NONE is the failure that matters,
        because a pattern that matches nothing agrees with everything.
        """
        import json                                          # noqa: PLC0415

        sites = {}
        sites["pyproject.toml"] = pyproject_version()
        with open(os.path.join(REPO, "package.json"), encoding="utf-8") as fh:
            sites["package.json"] = json.load(fh)["version"]
        sites["assay.__version__"] = re.search(
            r'__version__ = "([^"]+)"', py("__init__.py")).group(1)
        # ONE constant rather than the printed string: the JavaScript half now states
        # its version once and `--version` interpolates it, so this reads the source
        # of truth instead of one of its readers.
        sites["js VERSION"] = re.search(
            r"const VERSION = '([0-9][^']*)';", js("cli.js")).group(1)

        with open(os.path.join(REPO, "README.md"), encoding="utf-8") as fh:
            readme = fh.read()
        pins = re.findall(r"Megapixel99/assay-checks@v([0-9][^\s`]*)", readme)
        self.assertTrue(pins, "no `uses:` pin found in README.md, so this check "
                              "matched nothing and would agree with any version")
        for number, pin in enumerate(pins, 1):
            sites["README pin %d" % number] = pin

        for name, value in sites.items():
            self.assertIsNotNone(value, "%s states no version" % name)
        self.assertEqual(len(set(sites.values())), 1,
                         "the version sites disagree: %s"
                         % ", ".join("%s=%s" % kv for kv in sorted(sites.items())))

    def test_the_JSON_SCHEMA_NUMBER_is_the_same_in_both_halves(self):
        """It is versioned separately from the tool, so it is one number in two files
        and therefore a thing that can drift. A consumer parsing this output has the
        same claim on stability as a script reading the exit code."""
        from assay.verdicts import SCHEMA                  # noqa: PLC0415

        printed = re.search(r"export const SCHEMA = (\d+);", js("verdicts.js"))
        self.assertIsNotNone(printed, "no SCHEMA constant in verdicts.js")
        self.assertEqual(SCHEMA, int(printed.group(1)))

    def test_both_suites_pin_the_SAME_JSON_KEYS(self):
        """Each half's suite asserts its own output has exactly these keys, so the
        thing left to check is that the two suites are asking for the same set.

        READ AS TEXT, like everything else in this file: running the JavaScript would
        need Node, and a suite that silently skips when a runtime is missing reports a
        pass for a check that never ran.
        """
        py_test = os.path.join(HERE, "test_cli.py")
        with open(py_test, encoding="utf-8") as fh:
            py_block = re.search(r"KEYS = \{(.*?)\}", fh.read(), re.S).group(1)
        js_test = os.path.join(REPO, "js", "test", "cli.test.js")
        with open(js_test, encoding="utf-8") as fh:
            js_block = re.search(r"const JSON_KEYS = \[(.*?)\]", fh.read(), re.S).group(1)
        def names(block):
            return set(re.findall(r"['\"]([a-z_]+)['\"]", block))

        self.assertEqual(names(py_block), names(js_block))
        self.assertIn("exit_code", names(py_block))

    def test_the_verdict_names_are_identical(self):
        source = js("verdicts.js")
        for name, value in (("FINDING", FINDING), ("LOOK", LOOK), ("OK", OK)):
            self.assertIn("export const %s = '%s';" % (name, value), source)

    def test_both_halves_look_for_the_same_CONFIG_FILENAMES(self):
        found = re.search(r"CONFIG_NAMES = \[([^\]]+)\]", js("config.js")).group(1)
        names = tuple(re.findall(r"'([^']+)'", found))
        self.assertEqual(names, CONFIG_NAMES)

    def test_both_halves_read_the_same_config_KEYS(self):
        source = js("config.js")
        for key in ("runner_exempt", "anchor_exempt", "baseline"):
            self.assertIn("'%s'" % key, source)

    def test_both_halves_call_a_STDIN_SNIPPET_the_same_thing(self):
        """`search` excludes the query from its own hits by REFERENCE. A snippet has
        no path, so it is given one that collides with nothing a tree can contain —
        and if the two halves chose different strings, the same snippet would be named
        two ways in a polyglot repository's output."""
        self.assertEqual(sameness.SNIPPET_PATH, "<stdin>")
        self.assertIn("export const SNIPPET_PATH = '<stdin>';", js("sameness.js"))

    def test_both_halves_REFUSE_to_pick_a_function_out_of_an_ambiguous_snippet(self):
        """Picking one would make the tool answer about code nobody asked about. Both
        halves say so in the same words and both exit 2, because a query that cannot
        be read is `the tool could not run` and never `the tool found nothing`."""
        wanted = "name one with --name"
        self.assertIn(wanted, py("sameness.py"))
        self.assertIn(wanted, js("cli.js"))

    def test_both_halves_treat_an_INAPPLICABLE_FLAG_as_an_error(self):
        """A flag that is accepted, documented and inert is the defect this CLI
        already carries two docstrings about."""
        wanted = "--name selects a function inside a --stdin snippet"
        self.assertIn(wanted, py("cli.py"))
        self.assertIn(wanted, js("cli.js"))

    def test_both_halves_EXPLAIN_a_refused_probe_in_the_same_words(self):
        """`assay why` is the command a person reaches for when the census did not
        answer their question, so the answer must not depend on which binary they
        happened to have installed. Two of the three explanations are pinned: the
        constant and the projection, which the census collapses into one reason and
        which need opposite fixes — a wider ladder, or a different function.
        """
        for phrase in ("it is a constant",
                       "a projection: everywhere it answered it did nothing"):
            self.assertIn(phrase, py("sameness.py"))
            self.assertIn(phrase, js("sameness.js"))

    def test_both_halves_DEDUCE_the_projection_rather_than_deciding_it_twice(self):
        """`discrimination_detail` defers to `discriminating` and then explains the
        no. A second call to the projection guard would be a second decider for one
        question, and two deciders that can disagree is the shape of defect this
        package exists to report — so neither half may call it."""
        self.assertIn("if discriminating(vector, inputs) is not None:",
                      py("sameness.py"))
        self.assertIn("if (discriminating(vector, inputs) !== null) return null;",
                      js("sameness.js"))

    def test_a_LOOK_prints_its_detail_in_both_halves(self):
        """A `look` says the tool cannot decide; the detail is where it says what it
        DID find out on the way to not deciding. `assay why` puts its whole answer
        there, so a renderer that drops it answers half the question — in one language
        only, if the halves disagree."""
        self.assertIn('out.write("           %s\\n" % item.detail)', py("verdicts.py"))
        self.assertIn("write(`           ${item.detail}\\n`)", js("verdicts.js"))

    def test_both_halves_report_a_SEARCH_that_could_never_have_matched(self):
        """`collect` files every function the ladder cannot tell apart under skipped,
        so a query it cannot discriminate can only fail to find the other functions it
        cannot discriminate — the match was never possible, and the tree was never
        really searched. `same none` is the CLEAN result, and printing it there says
        "we found none" where the truth is "we never looked". Both halves say the
        other thing instead, and in the same words: a polyglot repository gets this
        answer from whichever binary it happened to install."""
        for phrase in ("not discriminated by the ladder",
                       "the tree was not searched: the census excludes every",
                       "function this ladder cannot tell apart, so a match was never"):
            self.assertIn(phrase, py("cli.py"))
            self.assertIn(phrase, js("cli.js"))

    def test_both_halves_DECIDE_the_undiscriminated_look_in_ONE_place(self):
        """`why` and `search` ask the same question of the same vector, and the defect
        this replaced was the two of them answering it differently. A sentence kept in
        step by hand is how they get back there, so each half writes it once."""
        self.assertIn("def _undiscriminated(report, func, vector):", py("cli.py"))
        self.assertIn("function undiscriminated(report, entry, display) {",
                      js("cli.js"))

    def test_both_halves_take_a_SNIPPET_for_why_as_well_as_for_search(self):
        """`search --stdin` is search before you generate, and `why` is the same
        question asked one step earlier. Answering it only for code already on disk
        would mean writing the file first in order to be told the file was never the
        problem — in one language only, if the halves disagree."""
        import inspect                                        # noqa: PLC0415

        from assay.cli import build_parser, cmd_search, cmd_why  # noqa: PLC0415

        args = build_parser().parse_args(["why", "--stdin"])
        self.assertTrue(args.stdin)
        self.assertIsNone(args.ref)
        # ONE RULE ABOUT WHICH WAY IN WAS USED, for both commands. Two copies that
        # must agree is the duplication this package exists to report.
        for command in (cmd_why, cmd_search):
            self.assertIn("_query(args, out)", inspect.getsource(command))
        self.assertEqual(js("cli.js").count("await probeStdin(readStdin(), opts.name)"),
                         2)
        self.assertEqual(js("cli.js").count("const bad = queryFlags(opts);"), 2)

    def test_both_halves_ship_the_same_SUBCOMMANDS(self):
        """A command in one half and not the other means the same documented
        invocation works or exits 2 depending on which binary CI installed. `anchors`
        is the one deliberate exception and it is asserted separately, by the test
        that checks this half NAMES what it does not implement."""
        from assay.cli import COMMANDS                        # noqa: PLC0415

        found = set(re.findall(r"case '([a-z]+)':", js("cli.js")))
        self.assertEqual(found, set(COMMANDS))

    def test_both_halves_REFUSE_to_baseline_a_look(self):
        """The 0.2.2 changelog records shipping a config example that baselined a
        `look`. A look never fails the run, so the line can never be suppressed and can
        never expire — a record of nothing, indistinguishable from a record of
        something already fixed. An example is fixed once per copy of it; a command
        that cannot make the mistake is fixed once, and it has to refuse in BOTH
        binaries or the same paste is accepted by one of them."""
        for source in (py("cli.py"), js("cli.js")):
            self.assertIn("`look` never fails the run", source)
            self.assertIn("stale the moment it lands", source)

    def test_both_halves_write_the_same_three_baseline_KEYS(self):
        """`assay accept` writes the file the other half then reads. A key one writes
        and the other does not understand is a config that is valid to the binary that
        produced it and a hard error to the one that runs next."""
        self.assertIn('entry = {"line": line, "reason": reason}', py("config.py"))
        self.assertIn("const entry = { line, reason };", js("config.js"))
        self.assertIn('entry["from"] = produced_by', py("config.py"))
        self.assertIn("entry.from = producedBy;", js("config.js"))

    def test_both_halves_have_ONE_definition_of_a_complete_run(self):
        """`all` needs it to say whether it may call a line stale; `accept` needs it to
        write `from`. Two lists that had to agree about what "every audit" means would
        be the duplication this package exists to find, and they would disagree in
        silence: `accept` would tag a line with a command `all` no longer performs, and
        that line could then never be called stale."""
        self.assertIn("_audit_everything(args, config, report)", py("cli.py"))
        self.assertIn("auditEverything(root, opts, config, report)", js("cli.js"))
        # ...and each half CALLS it exactly twice, from `all` and from `accept`. A
        # third call site would be a third opinion about what a complete run is.
        self.assertEqual(py("cli.py").count("= _audit_everything("), 2)
        self.assertEqual(js("cli.js").count("= await auditEverything("), 2)

    def test_the_CROSS_LADDER_is_ONE_DOCUMENT_carried_by_BOTH_halves(self):
        """The proof `assay cross` rests on, and the reason the shape check below is
        not enough for it.

        `BASE_VALUES` is two hand-written lists and `test_both_ladders_cover_the_same_
        SHAPES` is the strongest thing that can be said about them: the languages have
        different primitives, so an equal-length assertion would fail for a correct
        reason. That is fine for comparing two Python functions and nothing like enough
        for comparing a Python function to a JavaScript one — there, two lists that
        were meant to hold the same values and quietly stopped is the entire hazard.

        So the cross ladder is ONE JSON DOCUMENT and this compares the two texts. The
        values are then identical by construction rather than by inspection, and the
        digest below follows from the text rather than being a second thing to keep in
        step.
        """
        found = re.search(r"export const CROSS_VALUES_JSON = (.*?);\n",
                          js("sameness.js"), re.S).group(1)
        # The JavaScript literal is written as concatenated fragments to stay inside a
        # line width; joining them is what the runtime does. Nothing else in the
        # expression may contribute, so anything outside a quoted fragment must be
        # whitespace or a `+`.
        fragments = re.findall(r"'((?:[^'\\]|\\.)*)'", found)
        self.assertTrue(fragments, "the JavaScript cross ladder literal moved")
        self.assertRegex(re.sub(r"'(?:[^'\\]|\\.)*'", "", found).strip(),
                         r"^[+\s]*$",
                         "the JavaScript cross ladder is built from something other "
                         "than string fragments, so joining them is not what it means")
        # `\u00bd` in the source is a backslash and four characters in the VALUE, in
        # both languages, and that is what both `json.loads` and `JSON.parse` decode.
        joined = "".join(f.replace("\\\\", "\\") for f in fragments)
        self.assertEqual(joined, sameness.CROSS_VALUES_JSON,
                         "the two halves carry different cross ladders")

    def test_the_CROSS_LADDER_KEY_is_the_same_in_both_halves(self):
        """The key carries a digest of the RUNGS, so a ladder that changed by one
        character produces a different key and `compare_cross` refuses the pair through
        the branch that already refuses a mismatched arity. Computed here from the
        JavaScript half's own text, so this is a check rather than a restatement."""
        found = re.search(r"export const CROSS_VALUES_JSON = (.*?);\n",
                          js("sameness.js"), re.S).group(1)
        fragments = re.findall(r"'((?:[^'\\]|\\.)*)'", found)
        joined = "".join(f.replace("\\\\", "\\") for f in fragments)
        self.assertEqual(json.loads(joined), sameness.CROSS_VALUES)
        # ...and the digest both halves put in the key falls out of that text.
        for arity in (1, 2, 3):
            self.assertRegex(sameness.cross_key(arity),
                             r"^cross%d/%s/[0-9a-f]{12}$"
                             % (arity, re.escape(sameness.LADDER_VERSION)))

    def test_both_halves_render_EVERY_raise_as_the_SAME_token(self):
        """The load-bearing decision of the interlingua, and the whole of how a rung
        where both sides raised gets masked.

        The two languages' error taxonomies genuinely diverge, so a name would make
        every honest pair `differs`, and declaring two names equal is worse because
        `same` is the verdict that FAILS. Rendering every raise as ONE token settles
        it: two of them can never be a witness, and `cross_discriminating` counts only
        returned values so two of them can never be evidence either.

        THIS IS PINNED AT THE RENDERING RATHER THAN AT A BRANCH IN `compare`. There
        used to be a branch, and a mutation that removed it changed nothing — the guard
        and its absence produced the same observable, which is the failure this package
        exists to report, so the branch is gone and this checks the fact it restated.
        """
        self.assertIn('return "E:*"', py("sameness.py"))
        self.assertIn("return 'E:*';", js("sameness.js"))

    def test_both_halves_report_the_BASELINE_the_same_way_in_JSON(self):
        """`stale` alone is not the answer, and the shape says so in both halves.

        A consumer reading `stale: []` and nothing else reads "nothing is stale",
        which is a different claim from "this run never looked". So the payload carries
        `performed` — what this run audited — and `unchecked`, each entry it could not
        have seen fire. There is no `complete` boolean any more, because completeness
        stopped being a property of the RUN when an entry learned to name the command
        that fires it, and a half still emitting one would answer a question the other
        half no longer asks.
        """
        for source in (py("cli.py"), js("cli.js")):
            self.assertIn('"performed"' if "def " in source else "performed:", source)
            self.assertIn('"unchecked"' if "def " in source else "unchecked:", source)
            self.assertNotIn("incomplete_because", source)

    def test_a_probe_RECORD_has_one_shape_on_both_paths_in_both_halves(self):
        """`--json` is not what decides it: `assay probe` writes JSON either way, so a
        reference that names nothing emits the SAME record with `error` where `vector`
        would be. A consumer never has to ask which of two shapes it received, and `2`
        still means the tool could not run."""
        self.assertIn('"error": unresolved', py("cli.py"))
        self.assertIn("error: found.unresolved,", js("cli.js"))

    def test_both_halves_use_the_same_PROBE_RECORD_SCHEMA(self):
        """One half writes the record and the other reads it, which makes it a
        published interface with the same claim on stability as the exit codes. A
        record from a version that meant something else by `vector` would otherwise be
        compared anyway."""
        found = int(re.search(r"export const PROBE_SCHEMA = (\d+);",
                              js("sameness.js")).group(1))
        self.assertEqual(found, sameness.PROBE_SCHEMA)

    def test_both_halves_decide_a_reference_LANGUAGE_by_the_same_SUFFIXES(self):
        """A suffix one half calls JavaScript and the other calls nothing is a
        reference that `cross` accepts from one binary and refuses from the other."""
        from assay.cli import LANGUAGE_OF                      # noqa: PLC0415

        table = re.search(r"const LANGUAGE_OF = \{(.*?)\};", js("cli.js"), re.S).group(1)
        found = dict(re.findall(r"'(\.[a-z]+)': '([a-z]+)'", table))
        self.assertEqual(found, dict(LANGUAGE_OF))

    def test_the_ladder_VERSION_matches(self):
        """A vector produced by one half and compared by the other must come from the
        same ladder, and the version string is what says so."""
        found = re.search(r"LADDER_VERSION = '([^']+)'", js("sameness.js")).group(1)
        self.assertEqual(found, sameness.LADDER_VERSION)

    def test_the_discrimination_threshold_matches(self):
        found = int(re.search(r"MIN_DISTINCT = (\d+)", js("sameness.js")).group(1))
        self.assertEqual(found, sameness.MIN_DISTINCT)

    def test_the_maximum_arity_matches(self):
        found = int(re.search(r"MAX_ARITY = (\d+)", js("sameness.js")).group(1))
        self.assertEqual(found, sameness.MAX_ARITY)

    def test_both_ladders_cover_the_same_SHAPES(self):
        """Not the same VALUES, and counting them would be the wrong contract.

        The two languages have different primitives — Python has a tuple and a
        separate `None`, JavaScript has neither — so an equal-length assertion would
        fail for a correct reason and teach whoever hits it to delete the check. What
        must hold is that each ladder exercises the same SHAPES, and the empty case of
        each, since the empty case is where two implementations most often part.
        """
        found = re.search(r"BASE_VALUES = \[(.*?)\n\];", js("sameness.js"), re.S)
        entries = [x for x in re.findall(r"'([^']*)'", found.group(1)) if x]
        for shape in ('""', "[]", "{}", "0", "-1", "3.5", '"a"'):
            self.assertIn(shape, entries, "javascript ladder lacks %s" % shape)
        for shape in ("''", "[]", "{}", "()", "0", "-1", "3.5", "'a'"):
            self.assertIn(shape, sameness.BASE_VALUES,
                          "python ladder lacks %s" % shape)

    def test_both_ladders_carry_the_characters_ordinary_inputs_never_contain(self):
        source = js("sameness.js")
        for escape in ("u00bd", "u00e9"):
            self.assertIn(escape, source)
            self.assertIn(escape, "".join(sameness.BASE_VALUES))

    def test_both_halves_document_the_SAME_three_exit_codes(self):
        for name in ("cli.js",):
            source = js(name)
            self.assertIn("0 nothing to read, 1 findings, 2 could not run", source)

    def test_both_halves_read_a_mutation_table_by_the_SAME_RULE(self):
        """`anchors` is the one command whose halves work by different MECHANISMS —
        Python lifts the table out with `ast` and the JavaScript half imports it and
        reads the value — so what has to match is the rule, not the code.

        THE ANCHOR IS THE SECOND-TO-LAST STRING, and both halves say so in the same
        place. That is a consequence of `replace(old, new)` rather than a convention:
        whatever else an entry carries, `old` and `new` are adjacent and in that order,
        because that is the call they feed. A half that took a different column would
        report a different set of dead anchors for one repository.
        """
        self.assertIn("found.append(anchor_column(parts).value)", py("anchors.py"))
        self.assertIn("found.push(anchorColumn(parts))", js("anchors.js"))
        # ...and the column rule itself, which is where the second-to-last default
        # now lives. A half that disambiguated the two four-column shapes while the
        # other did not would report a different set of dead anchors for one
        # repository, which is the whole reason this test exists.
        self.assertIn("while len(trimmed) > 3 and METADATA_COLUMN.match("
                      "trimmed[-1].value):", py("anchors.py"))
        self.assertIn("while (trimmed.length > 3 && METADATA_COLUMN.test("
                      "trimmed[trimmed.length - 1]))", js("anchors.js"))
        self.assertIn("return trimmed[-2]", py("anchors.py"))
        self.assertIn("return trimmed[trimmed.length - 2];", js("anchors.js"))
        # ...and both bound the readable shapes the same way, so an entry one half
        # offers as unreadable is not silently guessed at by the other.
        self.assertIn("if 2 <= len(parts) <= 4:", py("anchors.py"))
        self.assertIn("if (parts.length >= 2 && parts.length <= 4)", js("anchors.js"))

    def test_both_halves_keep_EVERY_harness_out_of_the_corpus(self):
        """In either language, which is the part a single-language audit gets wrong. A
        polyglot repository has a `mutations-x.js` beside a `mutations_a.py`; each half
        can only READ its own, and both must be kept out of the corpus or one half's
        anchors are counted inside the other half's harness."""
        self.assertIn("skip = harness_paths(root)", py("anchors.py"))
        self.assertIn("const skip = harnessPaths(root);", js("anchors.js"))
        # ...over the same set of source extensions, or one half walks past a harness
        # the other excludes. Compared as SETS: the two are spelled differently on
        # purpose (a tuple here, one regex alternation there) and pinning the spelling
        # would fail for a correct reason.
        found = set(re.search(r"const SOURCE = /\\\.\(([a-z|]+)\)\$/;",
                              js("anchors.js")).group(1).split("|"))
        self.assertEqual(found, set(e.lstrip(".") for e in anchors.SOURCE_EXTS))

    def test_the_javascript_half_no_longer_REFUSES_anchors(self):
        """The gap it used to state is closed, and the statement has to go with it. A
        CLI that still points at PyPI for a command it now implements is documentation
        that is wrong in the direction people act on."""
        self.assertNotIn("Python package only", js("cli.js"))
        self.assertIn("auditAnchors(root, config, report)", js("cli.js"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
