"""Every mutation anchor must match its target EXACTLY ONCE.

WHY THE RULE EXISTS. A mutation harness typically applies `src.replace(old, new, 1)`,
so the anchor string it carries has to identify one place in one file. An anchor
matching:

  * ZERO places — the code moved out from under it. Loud if the harness checks
    (TARGET MISSING) and silently inert if it does not, which means a guard nobody is
    testing any more, reported as a passing suite.

  * MORE THAN ONE — `replace(..., 1)` takes the FIRST, which may not be the one you
    meant. The harness then mutates something nothing asserts, and reports NOT
    DETECTED. That reads as *your guard is untested* when the truth is *your mutation
    tested something else*, and those two send you to opposite ends of the codebase.

Both failures are silent in the direction that matters, which is why counting is worth
a check rather than a habit.

AND BOTH NAME A PLACE, not just a count. The finding is ABOUT the harness — the harness
is whose table has gone ambiguous — but the second copy of an anchor usually lives in
some other file, frequently one added since that harness was last touched. A reader
handed only the harness starts from the one file that is fine. So the ambiguous finding
carries the file holding the copies, and the dead one carries the size of the corpus it
searched, because *matches nothing* and *there was nothing to search* are different
claims and only the first is about the anchor.

READ, NEVER IMPORTED. Anchors are parsed with `ast` rather than by importing the
harness: importing one drags in the whole tool it tests, and a harness that does work
at import time can mask its own mutation just by being loaded. Reading is enough and
cannot have side effects — which also makes this safe to run while a harness is going,
unlike most things that touch a mutation table.

`MUTATIONS += [...]` IS AN AugAssign, NOT AN Assign, and reading only the latter
silently skips every anchor added in a `+=` block. The tell that something is wrong is
a total that does not move when a mutation is added, which is a thing nobody watches.
Both forms are read here.
"""

import ast
import os
import re

from .verdicts import Report
from .checks import find_runners


#: A METADATA column: a declared test name, a suite name, a section flag — anything a
#: harness carries so a mutation can say WHICH check must go red or WHERE to run it,
#: rather than "something failed". It is one bare word: an identifier or a flag, with
#: no whitespace and no code punctuation. A REPLACEMENT is code, and that difference is
#: the only thing separating the shapes, which is why this is a regex and not a
#: position.
METADATA_COLUMN = re.compile(r"^-{0,2}[A-Za-z_][A-Za-z0-9_.-]*$")


def anchor_column(parts):
    """The anchor, given one entry's string columns.

    `parts[-2]` is right whenever the last column is the REPLACEMENT, which covers
    `(label, old, new)` and `(label, target, old, new)`. It is wrong for every shape
    that carries something AFTER the replacement:

        (label, old, new, expected_test)     names the check that must go red
        (label, target, old, new, section)   names where to run it

    Both exist so that "something failed" and "the check that covers this failed" stay
    different claims. There `parts[-2]` lands on the REPLACEMENT, which matches nothing
    by construction — so every entry becomes a dead-anchor finding on a harness that is
    perfectly healthy, and an audit that fires on correct code is one that gets
    switched off.

    SO TRAILING METADATA IS DROPPED BEFORE COUNTING BACK, rather than each shape being
    enumerated: a metadata column is one bare word and a replacement is code, and that
    distinction does not need to know how many columns precede it.

    THE STRIP STOPS AT THREE COLUMNS, and that bound is the whole reason this is safe.
    `("label", code, "pass")` is an ordinary three-column mutation whose replacement
    happens to be a bare word; stripping there would leave `("label", code)` and put
    the anchor on the LABEL, trading a false finding on one shape for a false finding
    on another. Measured on a real tree: one such entry across 34 harnesses.
    """
    trimmed = list(parts)
    while len(trimmed) > 3 and METADATA_COLUMN.match(trimmed[-1].value):
        trimmed.pop()
    return trimmed[-2]


def anchors_of(path):
    """(anchors, unreadable). Every anchor a harness's MUTATIONS table carries.

    `unreadable` holds the LABELS of entries carrying more strings than the two
    documented shapes, where the anchor cannot be identified without guessing. Those
    are reported as a `look` rather than counted: a wrong conviction about a table
    this audit has never seen is worse than saying it could not tell.
    """
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    found = []
    unreadable = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AugAssign):
            names = [node.target.id] if isinstance(node.target, ast.Name) else []
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        else:
            continue
        if not any(n.upper().startswith("MUTATION") for n in names):
            continue
        for elt in getattr(node.value, "elts", []):
            parts = [e for e in getattr(elt, "elts", [])
                     if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            # THE ANCHOR IS THE SECOND-TO-LAST STRING, which is a consequence of
            # `replace(old, new)` rather than a guess about column order: whatever else
            # an entry carries — a label, a target file — `old` and `new` are adjacent
            # and in that order, because that is the call they feed. Both documented
            # shapes fall out of it, `(label, old, new)` and
            # `(label, target, old, new)`, without knowing which one is in front of it.
            #
            # AN EARLIER VERSION TOOK EVERY STRING long enough to look like code and
            # let the occurrence count decide which was the anchor. It could not tell a
            # label from an anchor, so roughly half of what it counted were labels that
            # match nothing by construction, and `unmatched` became a number nobody
            # could read: 60 of 118 on this package's own runner — with one genuinely
            # dead anchor sitting among them, invisible. Counting the wrong things
            # precisely is worse than counting fewer things.
            if 2 <= len(parts) <= 4:
                found.append(anchor_column(parts).value)
            elif len(parts) > 4:
                unreadable.append(parts[0].value)
    return found, unreadable


SOURCE_EXTS = (".py", ".js", ".mjs", ".cjs")


def harness_paths(root):
    """Every mutation harness under root, IN EITHER LANGUAGE, as real paths.

    `find_runners` finds the harnesses this half can READ, which is the `.py` ones.
    This finds the ones that must be kept OUT OF THE CORPUS, which is all of them: a
    polyglot repository has a `mutations_x.py` beside a `mutations-y.js`, and a
    JavaScript harness left in the corpus is a file full of anchor strings for the
    Python audit to match its own anchors against. One harness's REPLACEMENT text
    routinely appears in another's, so that produces a confident finding about a file
    the harness has nothing to do with.

    Reading and excluding are two different questions, and answering both with one
    walk was the mistake.
    """
    out = set()
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs
                         if not d.startswith(".") and d not in
                         {"node_modules", "__pycache__", "venv", ".venv"})
        for name in sorted(files):
            if name.startswith("mutations") and name.endswith(SOURCE_EXTS):
                out.add(os.path.realpath(os.path.join(base, name)))
    return out


def source_files(root, exts=SOURCE_EXTS):
    out = []
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs
                         if not d.startswith(".") and d not in
                         {"node_modules", "__pycache__", "venv", ".venv"})
        for name in sorted(files):
            if name.endswith(exts):
                out.append(os.path.join(base, name))
    return out


def audit_anchors(root, config, report=None):
    """Count every anchor's occurrences PER FILE and fail on one that matches twice."""
    rep = report or Report()
    runners = find_runners(root)
    if not runners:
        rep.note("ANCHORS — no mutation runners found under %s" % root)
        return rep
    # NO MUTATION HARNESS IS PART OF THE CORPUS, and this is the whole rule rather
    # than an optimisation. A harness's source contains its own anchors as string
    # literals, so counting them there makes every anchor "match twice" and the audit
    # reports problems that are all itself. Excluding only the DECLARING harness is not
    # enough either: one harness's REPLACEMENT text routinely appears in another's, so
    # a common replacement like a disabled branch matches dozens of times in a sibling
    # and produces a confident finding about a file it has nothing to do with.
    #
    # IN EITHER LANGUAGE, which `find_runners` cannot answer: it finds the harnesses
    # this half can READ, and what has to leave the corpus is all of them. Reading and
    # excluding are two different questions.
    #
    # Anchors point at the code under test. Harnesses are not the code under test.
    skip = harness_paths(root)
    corpus = {}
    for path in source_files(root):
        if os.path.realpath(path) in skip:
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                corpus[path] = fh.read()
        except (OSError, UnicodeDecodeError):
            continue

    rep.note("ANCHORS — every anchor must match exactly once in some file\n")
    total = 0
    for rel in runners:
        if rel in config.anchor_exempt:
            rep.note("  exempt   %-46s %s"
                     % (rel, config.anchor_exempt[rel][:60]))
            continue
        path = os.path.join(root, rel)
        try:
            anchors, unreadable = anchors_of(path)
        except SyntaxError as exc:
            rep.finding("%s does not parse (%s)" % (rel, exc), rel)
            continue
        ambiguous, dead = [], []
        for anchor in anchors:
            total += 1
            # THE COUNT WITHOUT THE FILE SENDS THE READER TO THE WRONG PLACE. This
            # finding names the HARNESS, because the harness is whose table has become
            # ambiguous — but the second copy is usually somewhere else entirely, and
            # often in a file added since that harness was last touched. Saying only
            # "matches twice" points a reader at the one file they already know about
            # and leaves them grepping the tree for the one they do not. The path was
            # in `max()`'s hand and thrown away; keeping it is the whole of the fix.
            #
            #
            # THE FIRST FILE AT THE WORST COUNT WINS, and `>` rather than `>=` is what
            # says so: the walk is sorted, so a tie names the same file on every run
            # and on every machine. A finding that moves between two equally guilty
            # files reads as two different problems.
            worst, where = 0, None
            for src_path, src in corpus.items():
                hits = src.count(anchor)
                if hits > worst:
                    worst, where = hits, src_path
            if worst == 0:
                dead.append(anchor)
            elif worst > 1:
                # PER FILE, not in total: the same anchor legitimately appearing once
                # in two different files is not ambiguous for a harness that names its
                # target, and calling it so would be the crying-wolf failure.
                ambiguous.append((anchor, worst, os.path.relpath(where, root)))
        for anchor, hits, where in ambiguous:
            rep.finding("%s: an anchor matches %d times in ONE file (%s) — "
                        "`replace(..., 1)` will take the first: %r"
                        % (rel, hits, where, anchor[:60]), rel)
        # ZERO MATCHES IS A FINDING, and it is the half of this rule that used to be
        # counted and then reported as `ok`. An anchor matching nothing means the code
        # moved out from under it: loud if the harness checks its target (TARGET
        # MISSING) and SILENTLY INERT if it does not, which is a guard nobody is
        # testing any more inside a suite that still reports a pass. That was only
        # ever reported as a number because the parser could not tell a label from an
        # anchor and would have failed on every label; it can now, so it can say so.
        #
        # AND HOW MANY FILES WERE SEARCHED, because "matches nothing" and "there was
        # nothing to match it against" are different claims and only one of them is
        # about the anchor. A root pointed one directory too deep, a corpus emptied by
        # an `exts` that does not cover the tree, a walk that skipped everything: each
        # makes every anchor dead at once, and the count is what tells that apart from
        # a guard the code really did move out from under.
        for anchor in dead:
            rep.finding("%s: an anchor matches NOTHING in any of %d file%s — the "
                        "code moved out from under it, so its mutation tests a guard "
                        "that is no longer there: %r"
                        % (rel, len(corpus), "" if len(corpus) == 1 else "s",
                           anchor[:60]), rel)
        for label in unreadable:
            rep.look("%s: cannot tell which column is the anchor in %r — more strings "
                     "than either documented table shape" % (rel, label[:50]), rel)
        if not ambiguous and not dead:
            rep.ok("%-46s %d anchors, each matching exactly once"
                   % (rel, len(anchors)), rel)
    rep.note("\n  %d anchors checked across %d runners" % (total, len(runners)))
    return rep
