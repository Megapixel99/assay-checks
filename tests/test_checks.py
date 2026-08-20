#!/usr/bin/env python3
"""The check-audit half. Every detector is driven in BOTH directions.

A detector tested only on code that should fail it will happily fire on code that
should pass, and that is the failure mode that gets an audit switched off. Each
property below has a runner that must be flagged and one that must not.
"""

import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from assay import checks  # noqa: E402
from assay.config import Config  # noqa: E402

# A harness is BUILT rather than string-surgered, so a negative case drops exactly one
# property and a test can only fail for the reason it names. Editing one shared blob
# with `str.replace` produced two false failures while these tests were being written —
# one replacement made the file unparseable (so the finding was "does not parse", not
# the property under test) and another left the marker string behind in a second place.
def runner(evidence=True, partition=True, restore_in_finally=True, sigterm=True,
           parses=True, named_section=False, tree_write=False):
    marker = 'EVIDENCE = "Ran "' if evidence else 'MARKER = "x"'
    ran_check = ('    if EVIDENCE not in out:\n'
                 '        return False, ["DID NOT RUN"]\n') if evidence else (
                 '    if MARKER not in out:\n'
                 '        return False, []\n')
    if partition:
        score = ('            dead = [x for x in fails if "crashed" in x]\n'
                 '            real = [x for x in fails if x not in dead]\n'
                 '            if dead and not real:\n'
                 '                continue\n')
    elif named_section:
        score = ('            wanted = "the section this mutation must redden"\n'
                 '            if wanted not in str(fails):\n'
                 '                print("WRONG section")\n')
    else:
        score = '            pass\n'
    if restore_in_finally:
        body = ('            try:\n'
                '                ran, fails = run_suite()\n'
                '            finally:\n'
                '                write_back(original)\n')
    else:
        body = ('            ran, fails = run_suite()\n'
                '            write_back(original)\n')
    guard = '            ast.parse(mutated)\n' if parses else ''
    handler = ('    signal.signal(signal.SIGTERM, lambda *a: None)\n' if sigterm
               else '    signal.signal(signal.SIGUSR1, lambda *a: None)\n')
    scratch = ('\nOUT = os.path.join(HERE, "results.json")\n' if tree_write else '')
    return (
        'import ast\n'
        'import os\n'
        'import signal\n'
        'import subprocess\n'
        '\n'
        'HERE = os.path.dirname(__file__)\n'
        + marker + '\n'
        'MUTATIONS = [("a label", "old code here", "new code here")]\n'
        '\n\n'
        'def write_back(text):\n'
        '    pass\n'
        '\n\n'
        'def run_suite():\n'
        '    out = subprocess.run(["x"], capture_output=True, text=True).stdout\n'
        + ran_check +
        '    return True, []\n'
        '\n\n'
        'def main():\n'
        '    original = "source"\n'
        + handler +
        '    for name, old, new in MUTATIONS:\n'
        '        mutated = original.replace(old, new, 1)\n'
        '        if True:\n'
        + guard + body + score
        + scratch)


GOOD_RUNNER = runner()


def project(runner_src, name="mutations_thing.py", extra=None):
    """A throwaway project holding one harness. Never inside this package's tree."""
    root = tempfile.mkdtemp(prefix="assay-checks-")
    with open(os.path.join(root, name), "w", encoding="utf-8") as fh:
        fh.write(runner_src)
    for extra_name, extra_src in (extra or {}).items():
        path = os.path.join(root, extra_name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(extra_src)
    return root


def audit(root, config=None):
    return checks.audit_runners(root, config or Config())


class Discovery(unittest.TestCase):

    def test_harnesses_are_found_by_WALKING_not_by_a_list(self):
        """A list of harnesses is one more table that goes stale, and the harness
        nobody added to it is the one that has been asleep longest."""
        root = project(GOOD_RUNNER, extra={"deep/nest/mutations_other.py": GOOD_RUNNER})
        self.assertEqual(checks.find_runners(root),
                         ["deep/nest/mutations_other.py", "mutations_thing.py"])

    def test_vendored_directories_are_skipped(self):
        root = project(GOOD_RUNNER,
                       extra={"node_modules/pkg/mutations_vendor.py": GOOD_RUNNER})
        self.assertEqual(checks.find_runners(root), ["mutations_thing.py"])

    def test_no_harnesses_is_reported_not_treated_as_a_pass(self):
        rep = audit(tempfile.mkdtemp())
        self.assertEqual(rep.exit_code(), 0)
        self.assertIn("none found", "\n".join(rep.sections))


class Properties(unittest.TestCase):
    """Each property: one harness that must be flagged, one that must not."""

    def missing(self, src):
        rep = audit(project(src))
        return {f.message.split("`")[1] for f in rep.findings if "`" in f.message}

    def test_a_complete_harness_is_flagged_for_NOTHING(self):
        self.assertEqual(self.missing(GOOD_RUNNER), set())

    def test_no_evidence_the_suite_ran_is_flagged(self):
        self.assertEqual(self.missing(runner(evidence=False)), {"evidence"})

    def test_no_dead_vs_real_partition_is_flagged(self):
        self.assertEqual(self.missing(runner(partition=False)), {"dead-vs-real"})

    def test_a_NAMED_SECTION_requirement_satisfies_the_partition_another_way(self):
        """A structural detector must not punish a design stronger than the one it
        knows. Requiring the failure in a named section and printing WRONG otherwise
        makes a crashed suite unscoreable without any partition at all."""
        src = runner(partition=False, named_section=True, parses=False)
        self.assertNotIn("dead-vs-real", self.missing(src))
        self.assertNotIn("parses-mutant", self.missing(src))

    def test_a_restore_outside_finally_is_flagged(self):
        self.assertEqual(self.missing(runner(restore_in_finally=False)),
                         {"restore-in-finally"})

    def test_no_sigterm_handling_is_flagged(self):
        self.assertEqual(self.missing(runner(sigterm=False)), {"sigterm"})

    def test_not_parsing_the_mutant_is_flagged(self):
        self.assertEqual(self.missing(runner(parses=False)), {"parses-mutant"})

    def test_writing_scratch_state_beside_the_code_is_flagged(self):
        self.assertEqual(self.missing(runner(tree_write=True)), {"no-tree-writes"})

    def test_a_harness_that_does_not_PARSE_is_a_finding_not_a_crash(self):
        rep = audit(project("def broken(:\n"))
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("does not parse", rep.findings[0].message)

    def test_every_property_key_is_covered_by_the_declared_set(self):
        """The keys the audit reports and the keys config may name must be one set."""
        self.assertEqual({k for k, _d, _w, _f in checks.PROPERTIES},
                         set(checks.PROPERTY_KEYS))


class Exemptions(unittest.TestCase):

    def test_an_exemption_silences_the_property_it_names(self):
        root = project(runner(sigterm=False))
        cfg = Config({("mutations_thing.py", "sigterm"): "writes only to a tempdir"})
        self.assertEqual(audit(root, cfg).findings, [])

    def test_an_exemption_does_NOT_silence_a_property_it_does_not_name(self):
        root = project(runner(sigterm=False))
        cfg = Config({("mutations_thing.py", "evidence"): "different reason"})
        self.assertEqual(len(audit(root, cfg).findings), 1)

    def test_an_exemption_for_a_file_that_no_longer_EXISTS_is_a_finding(self):
        root = project(GOOD_RUNNER)
        cfg = Config({("gone/mutations_old.py", "*"): "reason"})
        rep = checks.check_exemptions(root, cfg)
        self.assertEqual(len(rep.findings), 1)
        self.assertIn("no longer exists", rep.findings[0].message)

    def test_an_exemption_naming_an_UNKNOWN_property_is_a_finding(self):
        root = project(GOOD_RUNNER)
        cfg = Config({("mutations_thing.py", "not-a-property"): "reason"})
        rep = checks.check_exemptions(root, cfg)
        self.assertIn("unknown property", rep.findings[0].message)

    def test_a_stale_ANCHOR_exemption_is_a_finding_too(self):
        cfg = Config(anchor_exempt={"gone.py": "reason"})
        rep = checks.check_exemptions(project(GOOD_RUNNER), cfg)
        self.assertEqual(len(rep.findings), 1)


class Targets(unittest.TestCase):

    def test_a_mention_counts_as_coverage_so_this_UNDER_reports(self):
        """Stated rather than hidden: resolving paths statically is more machinery
        than the question needs, and an audit that errs should err toward saying less."""
        found = checks.targets_mentioned('TOOL = os.path.join(HERE, "widget.py")')
        self.assertEqual(found, {"widget.py"})

    def test_a_bare_word_is_not_mistaken_for_a_file(self):
        self.assertEqual(checks.targets_mentioned("just some prose about python"), set())


class ChangeAudit(unittest.TestCase):
    """`diff` needs a real repository, so these build one."""

    def repo(self):
        root = tempfile.mkdtemp(prefix="assay-git-")
        for args in (["init", "-q", "-b", "main"],
                     ["config", "user.email", "a@b.c"],
                     ["config", "user.name", "t"]):
            subprocess.run(["git", "-C", root] + args, check=True,
                           capture_output=True)
        return root

    def commit(self, root, message="c"):
        subprocess.run(["git", "-C", root, "add", "-A"], check=True,
                       capture_output=True)
        subprocess.run(["git", "-C", root, "commit", "-qm", message], check=True,
                       capture_output=True)

    def write(self, root, name, body):
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)

    def test_a_bad_ref_is_a_finding_rather_than_a_traceback(self):
        root = self.repo()
        self.write(root, "a.py", "x = 1\n")
        self.commit(root)
        rep = checks.audit_diff(root, "no-such-ref", Config())
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("valid ref", rep.findings[0].message)

    def test_a_changed_file_no_harness_names_is_a_LOOK_not_a_finding(self):
        root = self.repo()
        self.write(root, "a.py", "x = 1\n")
        self.commit(root, "first")
        self.write(root, "a.py", "x = 2\n")
        rep = checks.audit_diff(root, "HEAD", Config())
        self.assertEqual(rep.exit_code(), 0)
        self.assertTrue(any("NO mutation runner" in i.message for i in rep.looks))

    def test_a_guard_added_with_no_new_mutation_is_a_FINDING(self):
        root = self.repo()
        self.write(root, "a.py", "def f(n):\n    return n\n")
        self.write(root, "mutations_a.py", 'T = "a.py"\nMUTATIONS = []\n')
        self.commit(root, "first")
        self.write(root, "a.py", "def f(n):\n    if n < 0:\n        return 0\n    return n\n")
        rep = checks.audit_diff(root, "HEAD", Config())
        self.assertEqual(rep.exit_code(), 1)
        self.assertIn("adds a guard", rep.findings[0].message)

    def test_a_guard_added_WITH_its_harness_changed_is_fine(self):
        root = self.repo()
        self.write(root, "a.py", "def f(n):\n    return n\n")
        self.write(root, "mutations_a.py", 'T = "a.py"\nMUTATIONS = []\n')
        self.commit(root, "first")
        self.write(root, "a.py", "def f(n):\n    if n < 0:\n        return 0\n    return n\n")
        self.write(root, "mutations_a.py", 'T = "a.py"\nMUTATIONS = [("g", "x", "y")]\n')
        rep = checks.audit_diff(root, "HEAD", Config())
        self.assertEqual(rep.findings, [])

    def test_a_guard_in_ONE_file_does_not_indict_another_changed_file(self):
        """Computing guards over the whole patch makes one guard look like an
        unguarded change in every other file in the same commit."""
        root = self.repo()
        for name in ("a.py", "b.py"):
            self.write(root, name, "def f(n):\n    return n\n")
            self.write(root, "mutations_%s" % name, 'T = "%s"\nMUTATIONS = []\n' % name)
        self.commit(root, "first")
        self.write(root, "a.py", "def f(n):\n    if n < 0:\n        return 0\n    return n\n")
        self.write(root, "b.py", "def f(n):\n    return n + 1\n")
        rep = checks.audit_diff(root, "HEAD", Config())
        self.assertEqual(len(rep.findings), 1)
        self.assertIn("a.py", rep.findings[0].message)
        self.assertNotIn("b.py adds", rep.findings[0].message)

    def test_paths_are_rebased_onto_ROOT_when_code_sits_in_a_subdirectory(self):
        """git reports paths from the TOPLEVEL and the harness walk yields them from
        ROOT. When those differ, every comparison between them is silently False —
        which does not look like a bug, it looks like a clean audit."""
        top = self.repo()
        sub = os.path.join(top, "pkg")
        os.makedirs(sub)
        self.write(top, "pkg/a.py", "def f(n):\n    return n\n")
        self.write(top, "pkg/mutations_a.py", 'T = "a.py"\nMUTATIONS = []\n')
        self.commit(top, "first")
        self.write(top, "pkg/a.py",
                   "def f(n):\n    if n < 0:\n        return 0\n    return n\n")
        rep = checks.audit_diff(sub, "HEAD", Config())
        self.assertEqual(len(rep.findings), 1, [i.message for i in rep.items])
        self.assertIn("a.py adds a guard", rep.findings[0].message)

    def test_limitation_shaped_tests_are_a_LOOK(self):
        root = self.repo()
        self.write(root, "a.py", "def f(n):\n    return n\n")
        self.write(root, "test_a.py",
                   "def test_it_cannot_handle_negatives():\n    pass\n")
        self.write(root, "mutations_a.py", 'T = "a.py test_a.py"\nMUTATIONS = []\n')
        self.commit(root, "first")
        self.write(root, "test_a.py",
                   "def test_it_cannot_handle_negatives():\n    pass\n\n"
                   "def test_it_refuses_strings():\n    pass\n")
        rep = checks.audit_diff(root, "HEAD", Config())
        self.assertTrue(any("limitation-shaped" in i.message for i in rep.looks))
        self.assertEqual(rep.exit_code(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
