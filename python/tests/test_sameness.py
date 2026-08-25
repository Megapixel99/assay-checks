#!/usr/bin/env python3
"""The sameness half. Every test is written by asking what a MUTATION would change.

A test written by asking what the function does passes for the wrong reason far more
often than one written by asking what breaking it would do. The two guards this half
rests on — `discriminating` and the ladder-key check in `compare` — are therefore
driven in BOTH directions, with a positive case that must survive each and a negative
case that must not.
"""

import ast
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assay import sameness as S  # noqa: E402


def write(body, name="m.py"):
    """A throwaway module, never inside this package's own tree."""
    root = tempfile.mkdtemp(prefix="assay-same-")
    path = os.path.join(root, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(body)
    return path


TWINS = '''
def a(s):
    if not isinstance(s, str):
        raise TypeError("str")
    return s[::-1]


def b(s):
    if not isinstance(s, str):
        raise TypeError("str")
    out = ""
    for ch in s:
        out = ch + out
    return out
'''


class Discrimination(unittest.TestCase):
    """Without this guard every one-argument function is everyone else's twin."""

    def test_all_raises_is_not_discriminated(self):
        self.assertIsNone(S.discriminating(["E:TypeError"] * 10))

    def test_a_constant_is_not_discriminated(self):
        # Two returns, ONE distinct value: a constant agrees with every other
        # constant returning the same thing.
        self.assertIsNone(S.discriminating(["V:7"] * 10))

    def test_distinct_is_counted_over_RETURNS_not_over_outcomes(self):
        """One returned value plus one exception is two distinct OUTCOMES, and a
        keyword predicate satisfies exactly that — False for every string in the
        ladder, a raise for everything else, and nothing about its behaviour probed.
        The counting would be rewarding a probe that found only the type errors."""
        self.assertIsNone(S.discriminating(["V:False"] * 5 + ["E:TypeError"] * 5))

    def test_real_behaviour_IS_discriminated(self):
        self.assertIsNotNone(S.discriminating(["V:1", "V:2", "E:TypeError"]))

    def test_the_identity_on_the_ladder_is_not_discriminated(self):
        inputs = S.ladder(1)
        vector = [S.outcome_of(lambda x: x, ast.literal_eval(s)) for s in inputs]
        self.assertIsNotNone(S.discriminating(vector))        # many distinct returns
        self.assertIsNone(S.discriminating(vector, inputs))   # ...but a projection

    def test_a_projection_that_RAISES_elsewhere_is_still_a_projection(self):
        """A transform whose vocabulary the ladder lacks is the identity wherever it
        answers and raises everywhere else. Comparing whole vectors misses it, because
        the two disagree exactly where the function refused to run."""
        path = write("def f(s):\n    return s.replace('zzz', 'yyy')\n")
        func = S.parse(path).funcs["f"]
        vector, why = S.probe(func)
        self.assertIsNone(why, why)
        self.assertTrue(S.is_projection(vector, S.ladder(1)))
        self.assertIsNone(S.discriminating(vector, S.ladder(1)))

    def test_a_function_indistinguishable_from_a_SHALLOW_COPY_is_not_discriminated(self):
        """Returning the argument is the obvious emptiness; COPYING it is the same
        emptiness in another shape. Two unrelated query-param transforms agreed on
        every rung because the ladder holds no key either recognises, so both degraded
        to copying the mapping through and were reported as the same function."""
        path = write("def f(q):\n    return dict(q)\n")
        func = S.parse(path).funcs["f"]
        vector, why = S.probe(func)
        self.assertIsNone(why, why)
        self.assertTrue(S.is_projection(vector, S.ladder(1)))
        self.assertIsNone(S.discriminating(vector, S.ladder(1)))

    def test_a_copy_that_CHANGES_something_is_discriminated(self):
        """The other direction: the guard rejects vacuity, not mapping-returning
        functions."""
        path = write("def f(q):\n    out = dict(q)\n    out['seen'] = True\n    return out\n")
        func = S.parse(path).funcs["f"]
        vector, why = S.probe(func)
        self.assertIsNone(why, why)
        self.assertFalse(S.is_projection(vector, S.ladder(1)))
        self.assertIsNotNone(S.discriminating(vector, S.ladder(1)))

    def test_there_is_ONE_threshold_and_a_second_would_be_unreachable(self):
        """An earlier version carried a minimum returned-count beside the distinct
        count, and no mutation of it could be caught: two distinct returns already
        implies two returns. Two constants answering one question."""
        vector = ["V:1", "V:2"]
        self.assertIsNotNone(S.discriminating(vector))
        self.assertEqual(S.MIN_DISTINCT, 2)


class Comparison(unittest.TestCase):

    def test_two_ladders_are_never_zipped_together(self):
        """Comparing a new answer against the wrong earlier one is THE defect a
        difference checker exists to catch."""
        verdict, detail = S.compare(["V:1"], ["V:1"], "arity1/v2", "arity2/v2", ["(1,)"])
        self.assertEqual(verdict, "look")
        self.assertIn("not comparable", detail)

    def test_a_vector_that_does_not_match_the_ladder_is_a_look(self):
        verdict, _d = S.compare(["V:1", "V:2"], ["V:1", "V:2"], "arity1/v2",
                                "arity1/v2", ["(1,)"])
        self.assertEqual(verdict, "look")

    def test_a_witness_is_reported_with_the_input_that_produced_it(self):
        verdict, detail = S.compare(["V:1", "V:2"], ["V:1", "V:9"], "arity1/v2",
                                    "arity1/v2", ["(1,)", "(2,)"])
        self.assertEqual(verdict, "differs")
        self.assertIn("(2,)", detail)
        self.assertIn("V:9", detail)

    def test_agreement_on_a_vacuous_probe_is_a_look_not_a_same(self):
        verdict, detail = S.compare(["V:7", "V:7"], ["V:7", "V:7"], "arity1/v2",
                                    "arity1/v2", ["(1,)", "(2,)"])
        self.assertEqual(verdict, "look")
        self.assertIn("discriminated", detail)


class OutcomesAndCanon(unittest.TestCase):
    """What counts as "the same answer"."""

    def probe_pair(self, body):
        mod = S.parse(write(body))
        vectors = []
        for name in ("a", "b"):
            vector, why = S.probe(mod.funcs[name])
            self.assertIsNone(why, why)
            vectors.append(vector)
        return S.compare(vectors[0], vectors[1], "arity1/v2", "arity1/v2", S.ladder(1))

    def test_two_correct_twins_raising_DIFFERENT_MESSAGES_are_still_same(self):
        """Exception TYPE is the outcome; the message carries the function's own name.
        Comparing messages would make every pair `differs` and the tool useless, in
        the way that looks most like working correctly."""
        verdict, detail = self.probe_pair(
            "def a(s):\n"
            "    if not isinstance(s, str):\n"
            "        raise TypeError('a() wants a str')\n"
            "    return s.upper()\n\n\n"
            "def b(s):\n"
            "    if not isinstance(s, str):\n"
            "        raise TypeError('b() only accepts text')\n"
            "    return s.upper()\n")
        self.assertEqual(verdict, "same", detail)

    def test_two_dicts_built_in_a_different_ORDER_are_the_same_answer(self):
        verdict, detail = self.probe_pair(
            "def a(n):\n    return {'x': n, 'y': n}\n\n\n"
            "def b(n):\n    return {'y': n, 'x': n}\n")
        self.assertEqual(verdict, "same", detail)

    def test_a_long_value_is_HASHED_so_a_shared_prefix_is_not_agreement(self):
        verdict, detail = self.probe_pair(
            "def a(n):\n    return 'z' * 400 + str(n)\n\n\n"
            "def b(n):\n    return 'z' * 400 + str(n) + '!'\n")
        self.assertEqual(verdict, "differs", detail)

    def test_a_float_difference_is_a_difference_and_is_not_rounded_away(self):
        verdict, _d = self.probe_pair(
            "def a(n):\n    return n * 3\n\n\n"
            "def b(n):\n    return n * 3.0000000001\n")
        self.assertEqual(verdict, "differs")

    def test_the_EMPTY_STRING_is_in_the_ladder(self):
        """The empty case is where two implementations of one function part company.
        These agree on every non-empty string and differ on `''` alone."""
        verdict, detail = self.probe_pair(
            "def a(s):\n"
            "    if not isinstance(s, str):\n        raise TypeError('str')\n"
            "    return s[0] if s else ''\n\n\n"
            "def b(s):\n"
            "    if not isinstance(s, str):\n        raise TypeError('str')\n"
            "    return s[0]\n")
        self.assertEqual(verdict, "differs", detail)

    def test_the_ladder_carries_characters_ordinary_inputs_never_contain(self):
        """`isalpha() or _ or isdigit()` and `isalnum() or _` agree on every ASCII
        value. They are not the same function: `isalnum` is a strict superset that
        also covers numerics. One character is the whole difference."""
        verdict, detail = self.probe_pair(
            "def a(t):\n    return t[:1].isalpha() or t[:1] == '_' or t[:1].isdigit()\n"
            "\n\ndef b(t):\n    return t[:1].isalnum() or t[:1] == '_'\n")
        self.assertEqual(verdict, "differs", detail)
        self.assertIn("bd", detail.lower().replace("\\u00bd", "bd"))

    def test_group_never_mixes_two_LADDERS(self):
        """`arity2` and `arity3` ladders are the same LENGTH, so the key is the only
        thing keeping their vectors apart."""
        self.assertEqual(len(S.ladder(2)), len(S.ladder(3)))
        scan = S.Scan()
        scan.probed = {"x.py::a": ["V:1", "V:2"], "y.py::b": ["V:1", "V:2"]}
        scan.keys = {"x.py::a": "arity2/v2", "y.py::b": "arity3/v2"}
        S.group(scan)
        self.assertEqual(scan.groups, [])

    def test_the_ladder_is_deterministic_across_calls(self):
        """Two runs must be byte-identical; a seeded RNG would make the ladder a
        function of the seed rather than of the question."""
        self.assertEqual(S.ladder(2), S.ladder(2))
        self.assertEqual(S.ladder(1), S.ladder(1))


class Purity(unittest.TestCase):
    """What the tool will and will not execute, driven in both directions."""

    def refusal(self, body):
        return S.purity(S.parse(write(body)).funcs["f"])

    def test_file_io_is_refused(self):
        self.assertIn("open", self.refusal("def f(p):\n    return open(p).read()\n"))

    def test_a_module_that_reaches_outside_is_refused(self):
        self.assertIn("os", self.refusal(
            "import os\ndef f(p):\n    return os.listdir(p)\n"))

    def test_randomness_is_refused_even_though_it_imports_cleanly(self):
        self.assertIn("random", self.refusal(
            "import random\ndef f(n):\n    return random.random() * n\n"))

    def test_the_clock_is_refused_for_the_same_reason(self):
        self.assertIn("time", self.refusal(
            "import time\ndef f(n):\n    return time.time() + n\n"))

    def test_a_generator_is_refused(self):
        self.assertIn("generator", self.refusal("def f(n):\n    yield n\n"))

    def test_a_method_is_not_even_a_candidate(self):
        path = write("class C:\n    def f(self, x):\n        return x\n")
        self.assertIsNone(S.parse(path).funcs.get("f"))

    def test_a_module_level_function_taking_self_IS_refused(self):
        self.assertEqual(self.refusal("def f(self, x):\n    return x\n"), "method")

    def test_zero_arity_is_refused_because_a_ladder_cannot_discriminate(self):
        self.assertIn("no arguments", self.refusal("def f():\n    return 1\n"))

    def test_a_decorated_function_is_refused(self):
        self.assertEqual(self.refusal(
            "import functools\n\n\n@functools.cache\ndef f(n):\n    return n\n"),
            "decorated")

    def test_a_pure_function_is_NOT_refused(self):
        self.assertIsNone(self.refusal("def f(n):\n    return n * 2\n"))

    def test_an_allowlisted_import_is_NOT_refused(self):
        self.assertIsNone(self.refusal(
            "import math\ndef f(n):\n    return math.sqrt(n)\n"))


class Preamble(unittest.TestCase):
    """Free names resolve from the file, and the file is never imported."""

    def test_a_literal_constant_is_replayed(self):
        func = S.parse(write("K = 3\ndef f(n):\n    return n * K\n")).funcs["f"]
        pre, why = S.preamble_for(func)
        self.assertIsNone(why)
        self.assertIn("K = 3", pre)

    def test_a_pure_sibling_helper_is_carried_in(self):
        path = write("def h(n):\n    return n + 1\n\n\ndef f(n):\n    return h(n) * 2\n")
        func = S.parse(path).funcs["f"]
        pre, why = S.preamble_for(func)
        self.assertIsNone(why)
        self.assertIn("def h", pre)
        vector, why = S.probe(func)
        self.assertIsNone(why, why)
        self.assertIn("V:4", vector)

    def test_an_IMPURE_sibling_helper_stops_the_probe(self):
        path = write("import os\n\n\ndef h(n):\n    return os.getpid() + n\n\n\n"
                     "def f(n):\n    return h(n)\n")
        pre, why = S.preamble_for(S.parse(path).funcs["f"])
        self.assertIsNone(pre)
        self.assertIn("helper h", why)

    def test_an_unresolvable_free_name_stops_the_probe(self):
        pre, why = S.preamble_for(
            S.parse(write("def f(n):\n    return SOMETHING(n)\n")).funcs["f"])
        self.assertIsNone(pre)
        self.assertIn("SOMETHING", why)

    def test_a_non_allowlisted_import_stops_the_probe(self):
        pre, why = S.preamble_for(
            S.parse(write("import os\n\n\ndef f(n):\n    return os.sep * n\n"))
            .funcs["f"])
        self.assertIsNone(pre)
        self.assertIn("needs os", why)

    def test_the_module_is_NEVER_imported(self):
        """A file with a side effect at import time must still be safe to probe."""
        marker = os.path.join(tempfile.mkdtemp(), "touched")
        path = write("open(%r, 'w').write('x')\n\n\ndef f(n):\n    return n + 1\n"
                     % marker)
        _vector, why = S.probe(S.parse(path).funcs["f"])
        self.assertIsNone(why, why)
        self.assertFalse(os.path.exists(marker))


def with_per_input(seconds, fn, *args, **kwargs):
    """Run `fn` with the worker's per-input alarm set to `seconds`.

    `PER_INPUT_SECONDS` is read at call time and sent to the worker in the request, so
    the child honours it; restored in a `finally` so one test cannot re-time another.
    """
    saved = S.PER_INPUT_SECONDS
    S.PER_INPUT_SECONDS = seconds
    try:
        return fn(*args, **kwargs)
    finally:
        S.PER_INPUT_SECONDS = saved


class Probing(unittest.TestCase):

    def test_a_nonterminating_function_becomes_an_outcome_not_a_hang(self):
        path = write("def f(n):\n"
                     "    if not isinstance(n, int):\n        raise TypeError('int')\n"
                     "    x = 0\n    while True:\n        x += n\n")
        # A SHORTER ALARM, not a different question. Eight rungs of the arity-1 ladder
        # are ints and each one runs until the alarm fires, so the default second is
        # eight of them — the slowest test here, in a suite the mutation runner runs
        # once per mutation. What is under test is that the wait ENDS IN AN OUTCOME,
        # and the budget travels to the worker in the request, so shrinking it asks
        # exactly the same thing. It stays far longer than the microseconds the other
        # twenty-three rungs need to raise, which is what keeps this from going flaky.
        vector, why = with_per_input(0.25, S.probe, S.parse(path).funcs["f"])
        self.assertIsNone(why, why)
        self.assertTrue(any("Timeout" in o for o in vector), vector)
        # ...and a vector of nothing but raises can never reach the guard.
        self.assertIsNone(S.discriminating(vector, S.ladder(1)))


class Coroutines(unittest.TestCase):
    """An `async def` that only computes is as pure as the `def` beside it."""

    def test_an_async_def_is_COLLECTED_rather_than_invisible(self):
        """It appeared in NO count at all — not probed, not skipped, not in the census.

        `ast.AsyncFunctionDef` is not a subclass of `ast.FunctionDef`, so the module
        reader walked straight past it. That is worse than a refusal: a file of
        `async def` reported zero of everything, which reads as a clean sweep.
        """
        mod = S.parse(write("async def f(a):\n    return a * 2\n"))
        self.assertIn("f", mod.funcs)

    def test_a_coroutine_is_run_to_the_value_it_settles_on(self):
        async def doubled(a):
            return a * 2

        self.assertEqual(S.outcome_of(doubled, (21,)), S.outcome_of(lambda a: a * 2, (21,)))

    def test_a_raise_inside_a_coroutine_is_the_same_outcome_as_one_outside(self):
        async def bad(a):
            raise TypeError("nope")

        def also_bad(a):
            raise TypeError("different words entirely")

        self.assertEqual(S.outcome_of(bad, (1,)), S.outcome_of(also_bad, (1,)))
        self.assertEqual(S.outcome_of(bad, (1,)), "E:TypeError")

    def test_an_async_def_and_its_sync_twin_are_the_same_function(self):
        scan = S.collect([write("async def doubled(a):\n    return a * 2\n"
                                "\n\ndef also_doubled(a):\n    return a * 2\n")])
        S.group(scan)
        self.assertEqual(len(scan.groups), 1, dict(scan.skipped))
        self.assertEqual(sorted(r.split("::")[1] for r in scan.groups[0]),
                         ["also_doubled", "doubled"])

    def test_async_ITERATION_is_still_refused(self):
        """`await` is sequencing; `async for` and `async with` drive an object's
        protocol methods, which is behaviour the ladder cannot supply."""
        func = S.parse(write("async def f(a):\n    async with a:\n        return 1\n")).funcs["f"]
        self.assertIn("async iteration", S.purity(func))


class Grouping(unittest.TestCase):

    def test_two_implementations_of_one_function_are_grouped(self):
        scan = S.collect([write(TWINS)])
        S.group(scan)
        self.assertEqual(len(scan.groups), 1)
        self.assertEqual(sorted(r.rpartition("::")[2] for r in scan.groups[0]),
                         ["a", "b"])

    def test_functions_that_genuinely_differ_are_not_grouped(self):
        scan = S.collect([write("def a(n):\n    return n * 2\n\n\n"
                                "def b(n):\n    return n + 2\n")])
        S.group(scan)
        self.assertEqual(scan.groups, [])

    def test_names_are_never_read_so_differing_names_still_group(self):
        scan = S.collect([write(TWINS.replace("def b(", "def totally_unrelated("))])
        S.group(scan)
        self.assertEqual(len(scan.groups), 1)

    def test_a_singleton_bucket_is_not_duplication(self):
        scan = S.collect([write("def only(n):\n    return n * 3 + 1\n")])
        S.group(scan)
        self.assertEqual(scan.groups, [])

    def test_a_file_that_does_not_parse_is_COUNTED_rather_than_vanishing(self):
        """It was dropped before `files` was incremented and never reached `skipped`,
        so a directory of broken files reported zero of everything — which reads
        exactly like a clean sweep. "We found none" and "we never looked" are
        different claims, and only one of them is evidence."""
        path = write("def f(:\n    this does not parse\n")
        scan = S.collect([path])
        self.assertEqual(scan.functions, 0)
        self.assertEqual(len(scan.skipped), 0)
        self.assertEqual(len(scan.unloadable), 1)
        self.assertEqual(scan.file_census(), [("could not parse", 1)])

    def test_probed_plus_not_probed_equals_functions(self):
        """The headline reads as an equation, so it has to be one. Files and functions
        are different populations and a file holds an unknown number of functions —
        not opening it is exactly why the number is unknown."""
        path = write("def f(n):\n    return n * 3 + 1\n\ndef g():\n    return 1\n")
        scan = S.collect([path])
        self.assertEqual(scan.functions, len(scan.probed) + len(scan.skipped))
        self.assertEqual(scan.functions, 2)

    def test_the_census_counts_every_reason_a_function_was_not_probed(self):
        """"We found none" and "we never looked" are different claims."""
        scan = S.collect([write("import os\n\n\ndef f(p):\n    return os.listdir(p)\n")])
        self.assertEqual(dict(scan.census()), {"touches os": 1})

    def test_a_scan_is_reported_as_a_FINDING_not_a_verdict_on_the_code(self):
        scan = S.collect([write(TWINS)])
        S.group(scan)
        rep = S.report_scan(scan)
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("only a person decides", rep.findings[0].detail)


if __name__ == "__main__":
    unittest.main(verbosity=2)
