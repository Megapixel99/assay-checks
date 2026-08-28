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

ZERO EXTRACTED ANCHORS IS A LOOK, NEVER AN `ok`, and that is the failure this file was
most recently wrong about. A runner whose table shape this cannot read extracted no
anchors, and a runner whose anchors are all unique also has nothing to report — so
both printed `ok ... 0 anchors, each matching exactly once`, a sentence that is
literally true of the empty set and reads as a clean bill of health. Measured on a real
tree: 82 of 95 audited runners printed it, 13 contributed every anchor, and one of the
82 was carrying an anchor that matched TWICE in the file it points at — the exact
defect this audit exists to find, sitting under an `ok`. A count of zero is now the
tool saying it could not read the table, and the totals name how many runners said it.
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


#: The REPLACEMENT column's name, as a harness spells it when it unpacks its own table:
#: `for path, old, new, want_check, why in MUTATIONS:`. The anchor is the column BEFORE
#: it — the same `replace(old, new)` adjacency the rule above rests on, except READ OFF
#: THE HARNESS'S OWN DECLARATION rather than counted back from the end of the entry.
REPLACEMENT_NAMES = frozenset({"new", "repl", "replacement"})

#: The anchor column's own name, for a harness that names the anchor but calls the
#: replacement something this does not know. Second choice, because a replacement name
#: fixes the anchor by adjacency and so cannot be off by a column.
ANCHOR_NAMES = frozenset({"old", "needle", "anchor"})


def declared_columns(tree):
    """{table name: (arity, anchor index)}, FROM THE HARNESS'S OWN UNPACK.

    WHY THIS BEATS COUNTING BACK FROM THE END. `anchor_column` infers the anchor's
    position from what the columns look like, and that inference is bounded by what a
    value can tell you: it strips a trailing column that is one bare word, because a
    replacement is code and a metadata column is a name. It has no reading at all for
    the shape this tree is mostly made of —

        for path, needle, repl, want_check, why in MUTATIONS:

    — where the trailing metadata is a bare word AND a sentence of prose, and no rule
    over values separates a sentence from a replacement without guessing. Measured
    against 947 entries whose columns are declared: the best value-only rule this was
    tried against read 586 correctly, offered 345 as unreadable, and got 16 WRONG. A
    wrong anchor is a false dead-anchor finding on a healthy harness, which is how an
    audit stops being run.

    The harness already says which column is which, in the loop that consumes the
    table. Reading that is not a guess — it is the declaration, and it is exact for
    all 947. The three columns it cannot help with are the ones that are not string
    constants, and those are reported as unreadable rather than counted.

    ONLY A BARE NAME AS THE ITERABLE, and only a tuple as the target. `for x in
    sorted(TABLE)` or `for i, row in enumerate(TABLE)` shifts the columns, and a rule
    that read the names anyway would be confidently off by one — which is the failure
    this function exists to avoid, arriving inside the fix for it.
    """
    out = {}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.For)
                and isinstance(node.target, ast.Tuple)
                and isinstance(node.iter, ast.Name)):
            continue
        names = [t.id if isinstance(t, ast.Name) else None
                 for t in node.target.elts]
        index = None
        for i, name in enumerate(names):
            if i > 0 and name in REPLACEMENT_NAMES:
                index = i - 1
                break
        if index is None:
            for i, name in enumerate(names):
                if name in ANCHOR_NAMES:
                    index = i
                    break
        if index is not None:
            # FIRST DECLARATION WINS, so a harness that unpacks its table twice — once
            # in `main` and once in a helper — is read the same way both times rather
            # than by whichever loop `ast.walk` reached last.
            out.setdefault(node.iter.id, (len(names), index))
    return out


def entry_label(elts):
    """Something to CALL an entry this cannot read, for the `look` that reports it.

    The first string in it, which is the label in every shape here. An entry with no
    string at all is named by nothing, and `<no string column>` is a worse name than
    it looks — it is the honest one.
    """
    for elt in elts:
        if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
            return elt.value
    return "<no string column>"


def anchors_of(path):
    """(anchors, unreadable, tables). Every anchor a harness's mutation table carries.

    `tables` holds the NAMES of the tables that were read, and it is there so that a
    caller can tell "this harness declares no table I recognise" from "it declares one
    and I read no anchor out of it". Collapsing those two is what let a runner whose
    shape this could not parse print the same line as a runner whose anchors are all
    unique.

    `unreadable` holds the LABELS of entries whose anchor column cannot be identified
    without guessing. Those are reported as a `look` rather than counted: a wrong
    conviction about a table this audit has never seen is worse than saying it could
    not tell.
    """
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    # WHAT THE HARNESS SAYS ITS COLUMNS ARE, read before the tables so a table can be
    # recognised BY BEING CONSUMED as one. `M = [(G, old, new, name, why), ...]` is a
    # mutation table under a name no prefix rule would match, and the loop that unpacks
    # it says so plainly.
    declared = declared_columns(tree)
    found = []
    unreadable = []
    tables = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AugAssign):
            names = [node.target.id] if isinstance(node.target, ast.Name) else []
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        else:
            continue
        named = [n for n in names
                 if n.upper().startswith("MUTATION") or n in declared]
        if not named:
            continue
        spec = next((declared[n] for n in named if n in declared), None)
        tables.extend(named)
        for elt in getattr(node.value, "elts", []):
            elts = [e for e in getattr(elt, "elts", [])]
            if not elts:
                continue
            # THE DECLARED COLUMN FIRST, and by POSITION IN THE ENTRY rather than
            # position among its strings — which is the whole reason it reaches shapes
            # the rule below cannot. A target column that is a module-level variable,
            # `(G, old, new, name, why)`, is not a string constant and so vanishes from
            # `parts`; the declaration counts it, because the harness does.
            #
            # ONLY WHEN THE ARITY MATCHES. A `+=` block appending entries of a
            # different width to the same table would otherwise be read against the
            # wrong declaration, off by however much the widths differ.
            if spec and len(elts) == spec[0]:
                column = elts[spec[1]]
                if isinstance(column, ast.Constant) and isinstance(column.value, str):
                    found.append(column.value)
                else:
                    # A COMPUTED ANCHOR. `ast` sees an expression where the harness
                    # will see a string, and there is nothing to count. Offered, not
                    # guessed at: the value rule below would happily read some OTHER
                    # column here and report it matching exactly once, which is a
                    # vacuous pass wearing a number.
                    unreadable.append(entry_label(elts))
                continue
            parts = [e for e in elts
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
    return found, unreadable, tables


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
    exempt = measured = silent = 0
    for rel in runners:
        if rel in config.anchor_exempt:
            exempt += 1
            rep.note("  exempt   %-46s %s"
                     % (rel, config.anchor_exempt[rel][:60]))
            continue
        path = os.path.join(root, rel)
        try:
            anchors, unreadable, tables = anchors_of(path)
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
        # ZERO EXTRACTED ANCHORS IS A LOOK, NOT AN `ok`, and it is the same sentence
        # either way that made this audit vacuous. "0 anchors, each matching exactly
        # once" is true of the empty set and reads as a clean bill of health, so a
        # runner whose table shape was never recognised printed exactly what a runner
        # with a page of unique anchors printed. Measured on a real tree: 82 of 95
        # audited runners printed it, 13 carried every anchor, and one of the 82 held
        # an anchor matching TWICE in the file it points at — this rule's own defect,
        # under an `ok`.
        #
        # A LOOK RATHER THAN A FINDING because a harness legitimately holding no
        # anchors exists — one that replaces functions, or mutates strings in memory —
        # and `anchor_exempt` is where that is said, with the reason. What must not
        # happen is this tool claiming to have checked it.
        if not anchors:
            silent += 1
            if tables:
                rep.look("%s: its table (%s) yielded NO anchor this can read — the "
                         "shape was not recognised, so nothing here is a claim about "
                         "its anchors"
                         % (rel, ", ".join(sorted(set(tables)))[:60]), rel,
                         "an entry is read either by the column its own unpack "
                         "declares or as `(label, old, new)`; if it is neither, say "
                         "so in `anchor_exempt` or unpack the table by name")
            else:
                rep.look("%s: NO mutation table found to read — nothing here is a "
                         "claim about its anchors" % rel, rel,
                         "a table is recognised by a name beginning MUTATION, or by "
                         "being unpacked as one: `for path, old, new, ... in TABLE:`")
        elif not ambiguous and not dead:
            measured += 1
            rep.ok("%-46s %d anchors, each matching exactly once"
                   % (rel, len(anchors)), rel)
        else:
            measured += 1
    # THE DENOMINATOR IS PRINTED, because the numerator alone reads as coverage. "296
    # anchors checked across 101 runners" is a true sentence about a run in which 82 of
    # those runners contributed nothing at all, and it is the sentence a person reads
    # as "101 runners are clean". A zero-anchor runner is not a clean one.
    rep.note("\n  %d anchors from %d of %d runners, each counted per file"
             % (total, measured, len(runners)))
    rep.note("  ZERO anchors: %d runner(s), of which %d exempt — their tables were "
             "not read,\n  so no line above is evidence about them"
             % (silent + exempt, exempt))
    return rep
