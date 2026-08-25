#!/usr/bin/env python3
"""Comparing a Python function to a JavaScript one.

Two things have to be true before that means anything, and both are asserted here
rather than assumed:

  1. THE TWO LADDERS HOLD IDENTICAL VALUES, not merely identically-versioned ones.
     One JSON document, carried by both halves, with its digest in the ladder key.
  2. THE OUTCOMES ARE COMPARABLE. `V:False` and `V:false` are two spellings of one
     answer, and the interlingua is where that is decided.

These run the PYTHON half only, and that is on purpose: a suite that needs Node
silently skips when Node is missing, and a skip reports a pass for a check that never
ran. The cross-language behaviour that needs both binaries lives in `test_parity.py`,
which reads the JavaScript as text, and in `js/test/cross.test.js`, which is the other
half's own suite.
"""

import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from assay import cli  # noqa: E402
from assay.sameness import (CROSS_VALUES, PROBE_SCHEMA, compare_cross,  # noqa: E402
                            cross_discriminating, cross_key, cross_ladder,
                            cross_outcome_of, cross_projections, cross_render)


def run(*argv):
    buf = io.StringIO()
    code = cli.main(list(argv), out=buf)
    return code, buf.getvalue()


def tree(files):
    root = tempfile.mkdtemp(prefix="assay-cross-")
    for name, body in files.items():
        with open(os.path.join(root, name), "w", encoding="utf-8") as fh:
            fh.write(body)
    return root


SHOUT = 'def shout(text):\n    return text.upper() + "!"\n'
CONSTANT = "def always(x):\n    return 1\n"
IDENTITY = "def echo(x):\n    return x\n"


class TheInterlingua(unittest.TestCase):
    """`V:False` and `V:false` are two spellings of one answer, not a disagreement."""

    def test_the_two_booleans_and_the_two_absences_render_alike(self):
        self.assertEqual(cross_render(True), "true")
        self.assertEqual(cross_render(False), "false")
        self.assertEqual(cross_render(None), "null")

    def test_an_INTEGRAL_float_is_an_integer(self):
        """JavaScript has one number type, so Python's `2` and `2.0` are one number
        there. Refusing to merge them would make every arithmetic function differ
        across the boundary for a reason internal to one language."""
        self.assertEqual(cross_render(2), cross_render(2.0))
        self.assertEqual(cross_render(3.5), "3.5")
        self.assertEqual(cross_render(-0.5), "-0.5")

    def test_NaN_and_the_infinities_are_spelled_out(self):
        """JSON cannot hold them and `JSON.stringify` turns all three into `null` —
        three different answers reported as one absence."""
        self.assertEqual(cross_render(float("nan")), "NaN")
        self.assertEqual(cross_render(float("inf")), "Infinity")
        self.assertEqual(cross_render(float("-inf")), "-Infinity")

    def test_object_keys_are_SORTED(self):
        """Two implementations differing only in insertion order are not differing."""
        self.assertEqual(cross_render({"b": 1, "a": 2}), cross_render({"a": 2, "b": 1}))

    def test_a_TUPLE_renders_as_an_array(self):
        """JavaScript has no tuple, and a function returning one is answering the
        question an array answers there."""
        self.assertEqual(cross_render((1, 2)), cross_render([1, 2]))

    def test_a_value_the_interlingua_CANNOT_STATE_is_refused_not_approximated(self):
        """Rendering it approximately would be inventing a fact about a value this
        cannot read."""
        self.assertIsNone(cross_render(b"bytes"))
        self.assertIsNone(cross_render({1: "an int key"}))
        self.assertIsNone(cross_render({"nested": b"bytes"}))

    def test_an_unstatable_value_becomes_an_X_outcome(self):
        outcome = cross_outcome_of(lambda x: b"bytes", (1,))
        self.assertTrue(outcome.startswith("X:"), outcome)

    def test_a_RAISE_carries_no_NAME(self):
        """The two languages' error taxonomies diverge — `d['x']` is a KeyError here
        and `undefined` there — so naming them would make every honest pair `differs`.
        Declaring them equal is worse: `same` is the verdict that FAILS, so a wrong
        equality manufactures findings. `compare_cross` masks the rung instead."""
        def boom(_x):
            raise KeyError("nope")

        self.assertEqual(cross_outcome_of(boom, (1,)), "E:*")


class TheSharedLadder(unittest.TestCase):

    def test_the_ladder_is_ONE_JSON_DOCUMENT_parsed_by_each_half(self):
        """Not two lists kept in step by hand. The values are identical by
        construction, and `test_parity.py` compares the two texts."""
        self.assertIn("½", CROSS_VALUES)
        self.assertIn("", CROSS_VALUES)
        self.assertIn(None, CROSS_VALUES)
        self.assertIn([], CROSS_VALUES)
        self.assertIn({}, CROSS_VALUES)

    def test_the_KEY_carries_a_DIGEST_of_the_rungs(self):
        """`arity1/v3` says two vectors came from ladders with the same NAME. The whole
        hazard across languages is two lists that were meant to hold the same values
        and quietly stopped, and a name cannot see that."""
        key = cross_key(1)
        self.assertTrue(key.startswith("cross1/v3/"), key)
        self.assertEqual(len(key.rsplit("/", 1)[1]), 12)
        self.assertNotEqual(cross_key(1), cross_key(2))

    def test_every_rung_is_expressible_in_the_interlingua(self):
        """A ladder holding a value the renderer cannot state would make every
        comparison a `look` for a reason that is the tool's own."""
        for args in cross_ladder(2):
            for value in args:
                self.assertIsNotNone(cross_render(value), repr(value))

    def test_the_rungs_are_DEDUPLICATED_and_deterministic(self):
        first = cross_ladder(2)
        self.assertEqual(first, cross_ladder(2))
        seen = {json.dumps(a, sort_keys=True) for a in first}
        self.assertEqual(len(seen), len(first))


class Comparing(unittest.TestCase):

    def vector(self, *outcomes):
        return list(outcomes)

    def test_a_rung_where_BOTH_raised_is_MASKED(self):
        """Two refusals that may have nothing to do with each other. Counting it as
        agreement would let two functions that share only their type errors be reported
        as one function."""
        # The answered rungs are deliberately NOT the identity: `V:1` and `V:2` for
        # inputs 1 and 2 is a projection, and the vacuity guard would refuse the pair
        # for that instead — which is the guard working, and not what this is about.
        rungs = [[0], [1], [2]]
        verdict, _detail = compare_cross(["E:*", "V:10", "V:20"],
                                         ["E:*", "V:10", "V:20"],
                                         "k", "k", rungs)
        self.assertEqual(verdict, "same")

    def test_a_rung_where_ONE_raised_is_a_WITNESS(self):
        """The most interesting one there is: one implementation has a case the other
        does not."""
        rungs = [[0], [1], [2]]
        verdict, detail = compare_cross(["E:*", "V:10", "V:20"],
                                        ["V:0", "V:10", "V:20"],
                                        "k", "k", rungs)
        self.assertEqual(verdict, "differs")
        self.assertIn("E:* vs V:0", detail)

    def test_two_vectors_from_DIFFERENT_ladders_are_refused(self):
        verdict, detail = compare_cross(["V:1"], ["V:1"], "cross1/v3/aaa",
                                        "cross1/v3/bbb", [[0]])
        self.assertEqual(verdict, "look")
        self.assertIn("not comparable", detail)

    def test_an_outcome_the_interlingua_cannot_state_is_a_LOOK(self):
        """A value this cannot read is one it must not pronounce on — neither as
        agreement nor as a witness."""
        rungs = [[0], [1]]
        verdict, detail = compare_cross(["X:bytes", "V:1"], ["V:0", "V:1"],
                                        "k", "k", rungs)
        self.assertEqual(verdict, "look")
        self.assertIn("cannot state", detail)

    def test_a_CONSTANT_is_not_discriminated(self):
        rungs = cross_ladder(1)
        self.assertIsNone(cross_discriminating(["V:1"] * len(rungs), rungs))

    def test_a_PROJECTION_is_not_discriminated(self):
        """Handing the argument back is doing nothing with it, in either language."""
        rungs = cross_ladder(1)
        self.assertIsNone(cross_discriminating(cross_projections(rungs)[0], rungs))

    def test_a_real_function_IS_discriminated(self):
        rungs = cross_ladder(1)
        vector = [cross_outcome_of(lambda t: t * 2, args) for args in rungs]
        self.assertIsNotNone(cross_discriminating(vector, rungs))


class TheProbeRecord(unittest.TestCase):
    """What `assay probe` writes, and the other half reads."""

    def probe(self, name="shout", body=SHOUT):
        root = tree({"api.py": body})
        code, text = run("probe", os.path.join(root, "api.py") + "::" + name)
        return code, text

    def test_it_writes_a_record_on_STDOUT_with_the_ladder_it_used(self):
        code, text = self.probe()
        self.assertEqual(code, 0)
        record = json.loads(text)
        self.assertEqual(record["assay_probe"], PROBE_SCHEMA)
        self.assertEqual(record["language"], "python")
        self.assertEqual(record["ladder"], cross_key(1))
        self.assertEqual(len(record["vector"]), len(cross_ladder(1)))

    def test_its_KEYS_are_SORTED(self):
        """The JavaScript half sorts too. One record written as two different
        documents is one contract with two implementations, which is the duplication
        this package exists to find."""
        record = json.loads(self.probe()[1])
        self.assertEqual(list(record), sorted(record))

    def test_a_REFUSED_function_is_a_record_with_a_look_not_an_error(self):
        """The reference resolved and the tool ran, so this is not exit 2 — and a
        consumer gets one shape either way."""
        code, text = self.probe("nullary", "def nullary():\n    return 1\n")
        self.assertEqual(code, 0)
        record = json.loads(text)
        self.assertIn("look", record)
        self.assertNotIn("vector", record)

    def test_a_reference_that_names_nothing_is_exit_2_AND_STILL_A_RECORD(self):
        """ONE SHAPE, ALWAYS, and `--json` is not what decides it here: this command's
        output IS JSON, so there is no prose form to switch away from. A consumer never
        has to ask which of two shapes it received, and `2` still means the tool could
        not run — prose on the failure path would hand it a parse error at exactly the
        moment the tool could not run."""
        code, text = run("probe", "nowhere.py::x")
        self.assertEqual(code, 2)
        record = json.loads(text)
        self.assertEqual(record["assay_probe"], PROBE_SCHEMA)
        self.assertIn("no such file", record["error"])
        self.assertNotIn("vector", record)

    def test_a_record_that_SUCCEEDED_carries_a_null_error(self):
        """The same keys on both paths, so `error` is the one a consumer reads."""
        record = json.loads(self.probe()[1])
        self.assertIsNone(record["error"])

    def test_json_changes_NOTHING_about_probe(self):
        """It is already the JSON command. A `--json` that produced a second shape here
        would be the thing `--json` exists to prevent."""
        plain = self.probe()[1]
        root = tree({"api.py": SHOUT})
        _code, flagged = run("--json", "probe",
                             os.path.join(root, "api.py") + "::shout")
        self.assertEqual(json.loads(plain)["vector"], json.loads(flagged)["vector"])


class Crossing(unittest.TestCase):

    def record(self, ref, path):
        _code, text = run("probe", ref)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def js_record(self, root, vector, ladder=None, **extra):
        """A JavaScript-side record, written by hand.

        The other half is not RUN here: a suite that needs Node silently skips when
        Node is missing, and a skip reports a pass for a check that never ran. What is
        under test is the comparison, and a record is a record whoever wrote it.
        """
        path = os.path.join(root, "side.json")
        record = {"assay_probe": PROBE_SCHEMA, "ref": "ui.mjs::yell",
                  "language": "javascript", "arity": 1,
                  "ladder": ladder or cross_key(1), "vector": vector}
        record.update(extra)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        return path

    def python_vector(self, root, body=SHOUT, name="shout"):
        with open(os.path.join(root, "api.py"), "w", encoding="utf-8") as fh:
            fh.write(body)
        ref = os.path.join(root, "api.py") + "::" + name
        _code, text = run("probe", ref)
        return ref, json.loads(text)["vector"]

    def test_two_halves_that_AGREE_are_a_finding(self):
        """`same` is not proof, and it is the verdict that fails: something a person
        has to read."""
        root = tree({})
        ref, vector = self.python_vector(root)
        other = self.js_record(root, vector)
        code, text = run("cross", ref, other)
        self.assertEqual(code, 1, text)
        self.assertIn("same answer across languages", text)

    def test_a_WITNESS_is_an_ok_rather_than_a_finding(self):
        """`differs` is proof, and proof of difference is the good outcome."""
        root = tree({})
        ref, vector = self.python_vector(root)
        changed = list(vector)
        changed[12] = "V:\"different\""
        other = self.js_record(root, changed)
        code, text = run("cross", ref, other)
        self.assertEqual(code, 0, text)
        self.assertIn("differs:", text)

    def test_a_record_from_ANOTHER_SCHEMA_is_refused(self):
        """Comparing a new answer against the wrong earlier answer is precisely the
        defect a difference checker exists to catch."""
        root = tree({})
        ref, vector = self.python_vector(root)
        other = self.js_record(root, vector)
        with open(other, encoding="utf-8") as fh:
            record = json.load(fh)
        record["assay_probe"] = PROBE_SCHEMA + 99
        with open(other, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        code, text = run("cross", ref, other)
        self.assertEqual(code, 2)
        self.assertIn("schema", text)

    def test_a_record_from_ANOTHER_LADDER_is_a_look_not_a_comparison(self):
        root = tree({})
        ref, vector = self.python_vector(root)
        other = self.js_record(root, vector, ladder="cross1/v3/deadbeefcafe")
        code, text = run("cross", ref, other)
        self.assertEqual(code, 0, text)
        self.assertIn("not comparable", text)

    def test_a_side_that_could_not_be_PROBED_is_a_look(self):
        root = tree({})
        ref, vector = self.python_vector(root)
        other = self.js_record(root, vector)
        with open(other, encoding="utf-8") as fh:
            record = json.load(fh)
        record.pop("vector")
        record["look"] = "reads the clock"
        with open(other, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        code, text = run("cross", ref, other)
        self.assertEqual(code, 0, text)
        self.assertIn("could not be probed", text)

    def test_TWO_PYTHON_REFERENCES_are_a_look_pointing_at_pair(self):
        """The cross ladder is a subset of what one language can express. Two functions
        of one language deserve the stronger instrument."""
        root = tree({"api.py": SHOUT + "\n\ndef bellow(text):\n    return text.upper() + '!'\n"})
        a = os.path.join(root, "api.py") + "::shout"
        b = os.path.join(root, "api.py") + "::bellow"
        code, text = run("cross", a, b)
        self.assertEqual(code, 0, text)
        self.assertIn("`pair`", text)

    def test_a_JAVASCRIPT_reference_without_with_says_exactly_what_to_run(self):
        """The two halves do not invoke each other: neither package can assume the
        other is installed, and a command that shells out to a binary that may not
        exist fails in a way that reads like the code being wrong."""
        root = tree({"api.py": SHOUT, "ui.mjs": "export function yell(t) { return t; }\n"})
        code, text = run("cross", os.path.join(root, "api.py") + "::shout",
                         os.path.join(root, "ui.mjs") + "::yell")
        self.assertEqual(code, 2)
        self.assertIn("assay probe", text)
        self.assertIn("--with", text)

    def test_cross_answers_in_JSON_when_asked(self):
        """`cross` builds a Report like every other audit, so it emits the envelope —
        and a refusal emits it too, with `error` set and `items` empty."""
        root = tree({})
        ref, vector = self.python_vector(root)
        other = self.js_record(root, vector)
        _code, text = run("--json", "cross", ref, other)
        data = json.loads(text)
        self.assertIsNone(data["error"])
        self.assertEqual(data["exit_code"], 1)
        self.assertEqual(data["items"][0]["verdict"], "finding")
        _code, refused = run("--json", "cross", ref, "notes.txt::x")
        broken = json.loads(refused)
        self.assertEqual(broken["exit_code"], 2)
        self.assertIn("no language", broken["error"])
        self.assertEqual(broken["items"], [])

    def test_a_reference_in_NO_KNOWN_LANGUAGE_exits_2(self):
        root = tree({"api.py": SHOUT})
        code, text = run("cross", os.path.join(root, "api.py") + "::shout",
                         "notes.txt::something")
        self.assertEqual(code, 2)
        self.assertIn("no language", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
