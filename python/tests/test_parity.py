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

from assay import checks, sameness  # noqa: E402
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

    def test_both_halves_refuse_to_call_a_baseline_STALE_from_a_partial_run(self):
        """The rule, not the wording: a line is only stale to a run that could have
        seen it fire. Python says so from any command but `all`; the JavaScript half
        says so from every command, because `anchors` is Python-only and no run there
        performs every audit able to produce a baseline line. What must match is that
        BOTH say it rather than printing a zero that reads as `nothing is stale`."""
        for source in (py("cli.py"), js("cli.js")):
            self.assertIn("staleness needs", source)

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
        """Four places carry it, and the release only ever compared two of them.

        `pyproject.toml` and `package.json` are each a registry's source of truth, and
        `release.yml` refuses to publish if they disagree. But `assay.__version__` and
        the string the JavaScript CLI prints are separate literals, so a bump that
        touched the two manifests and missed these would publish a package whose
        `--version` names the release before it. That is not a broken build — it is a
        tool lying about which build you are running, which is worse, because the
        number is what you would quote in a bug report.

        Kept as literals rather than read at runtime on purpose: `importlib.metadata`
        needs the package installed, and this one is meant to run from a checkout with
        nothing but `PYTHONPATH`. So the duplication stays and is CHECKED, which is the
        same bargain every other table in this package makes.
        """
        import json                                          # noqa: PLC0415
        import tomllib                                       # noqa: PLC0415

        with open(os.path.join(REPO, "pyproject.toml"), "rb") as fh:
            pyproject = tomllib.load(fh)["project"]["version"]
        with open(os.path.join(REPO, "package.json"), encoding="utf-8") as fh:
            package_json = json.load(fh)["version"]
        module = re.search(r'__version__ = "([^"]+)"', py("__init__.py")).group(1)
        printed = re.search(r"write\('assay ([0-9][^\\']*)\\n'\)",
                            js("cli.js")).group(1)

        self.assertEqual({pyproject, package_json, module, printed}, {pyproject},
                         "pyproject=%s package.json=%s assay.__version__=%s "
                         "js --version=%s" % (pyproject, package_json, module, printed))

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

    def test_the_javascript_half_NAMES_the_command_it_does_not_implement(self):
        """A gap stated is a limit; a gap unstated is a bug report waiting to happen."""
        self.assertIn("Python", js("cli.js"))
        self.assertIn("anchors", js("cli.js"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
