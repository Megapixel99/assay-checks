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

from .verdicts import Report
from .checks import find_runners


def anchors_of(path):
    """Every anchor string a harness's MUTATIONS table carries."""
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    found = []
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
            # The anchor is the string that gets replaced. Tables are
            # (label, old, new, ...) or (label, target, old, new, ...); the anchor is
            # whichever string is long enough to be code AND is followed by another
            # string. Take every candidate and let the occurrence count decide — a
            # label will simply not be found, and that is reported as UNMATCHED rather
            # than guessed at. Guessing which element is the anchor would make the
            # audit wrong about tables it has never seen.
            for i in range(len(parts) - 1):
                value = parts[i].value
                if len(value) > 12 and ("\n" in value or " " in value
                                        or "(" in value):
                    found.append(value)
    return found


def source_files(root, exts=(".py", ".js")):
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
    # Anchors point at the code under test. Harnesses are not the code under test.
    skip = {os.path.realpath(os.path.join(root, rel)) for rel in runners}
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
            anchors = anchors_of(path)
        except SyntaxError as exc:
            rep.finding("%s does not parse (%s)" % (rel, exc), rel)
            continue
        ambiguous, unmatched = [], 0
        for anchor in anchors:
            total += 1
            worst = max([src.count(anchor) for src in corpus.values()] or [0])
            if worst == 0:
                unmatched += 1
            elif worst > 1:
                # PER FILE, not in total: the same anchor legitimately appearing once
                # in two different files is not ambiguous for a harness that names its
                # target, and calling it so would be the crying-wolf failure.
                ambiguous.append((anchor, worst))
        if ambiguous:
            for anchor, hits in ambiguous:
                rep.finding("%s: an anchor matches %d times in ONE file — "
                            "`replace(..., 1)` will take the first: %r"
                            % (rel, hits, anchor[:60]), rel)
        else:
            rep.ok("%-46s %d anchors, %d unmatched"
                   % (rel, len(anchors), unmatched), rel)
    rep.note("\n  %d anchors checked across %d runners" % (total, len(runners)))
    return rep
