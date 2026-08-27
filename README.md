# assay

[![PyPI](https://img.shields.io/pypi/v/assay-checks?label=PyPI&color=3775A9)](https://pypi.org/project/assay-checks/)
[![npm](https://img.shields.io/npm/v/assay-checks?label=npm&color=CB3837)](https://www.npmjs.com/package/assay-checks)
[![ci](https://github.com/Megapixel99/assay-checks/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Megapixel99/assay-checks/actions/workflows/ci.yml)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Two questions ordinary CI does not answer, about work that **already passes its tests**:

> **Could those tests have failed?**
> **Does the tree already answer this?** — *in either language*

A green suite tells you the code did what the suite asked. It tells you nothing about
whether the suite could have objected, and nothing about whether the code needed to be
written at all.

```bash
pip install assay-checks      # the CLI: assay
npm install -g assay-checks   # the CLI: assay (JavaScript projects)
```

```
$ assay scan src/                      # the Python half, over a Python tree
FINDINGS — 1, each checked rather than guessed:
  finding  same answer (arity1/v3): src/format.py::humanize, src/report.py::pretty
           no input in the ladder told them apart — READ them; only a person decides
           whether the duplication is a defect
```

The JavaScript half answers in the same words, because the verdicts, the exit codes
and the ladder key are one contract rather than two:

```
$ assay scan src/                      # the JavaScript half, over a JavaScript tree
FINDINGS — 1, each checked rather than guessed:
  finding  same answer (arity1/v3): src/slug.js::slugify, src/url.js::toSlug
           no input in the ladder told them apart — READ them; only a person decides
           whether the duplication is a defect
```

...and one contract is enough to ask the question **across** the two, which is where the
duplication a polyglot repository actually accumulates:

```
$ assay cross src/api.py::shout src/ui.mjs::yell --with assay-js
FINDINGS — 1, each checked rather than guessed:
  finding  same answer across languages (cross1/v3/d3b2ba61ccb7):
           src/api.py::shout [python]  vs  src/ui.mjs::yell [javascript]
```

Neither half is a linter and neither is a test runner. Both are stdlib-only, in both
languages, because a quality tool that drags in a dependency tree is one more thing
that can break the build it was added to protect.

---

## Half one: could those tests have failed?

`assay runners` audits **mutation harnesses**: the scripts that deliberately break your
code and check that something notices. If you run one, these are the seven ways it can
lie to you, and each is a failure that looks exactly like success:

| property | what it means | what goes wrong without it |
|---|---|---|
| `evidence` | positive proof each suite RAN | no failures reported and no test executed look identical |
| `dead-vs-real` | a DID-NOT-RUN is not a detection | counting any failure scores a crash as a catch |
| `restore-in-finally` | the restore cannot be skipped by an exception | an exception mid-run leaves the target mutated |
| `sigterm` | SIGTERM becomes an exception so `finally` runs | **SIGTERM does not run `finally`**: a kill leaves the tree broken |
| `parses-mutant` | a file-breaking mutation is not scored | a syntax error makes every suite fail, which reads as a catch |
| `no-tree-writes` | no scratch state beside the code under test | a clean target is not a clean tree |
| `restore-verified` | the tree is **proved** to have come back | a restore that ran is not a restore that worked |

**The last one is about the third one's blind spot.** `restore-in-finally` proves the
restore *path executes*; it says nothing about the file on disk. A harness that restores
from a buffer it read *after* mutating, or writes the text back in a different encoding,
or saved one of the two files it touches, satisfies the other six and still leaves the
tree wrong — and every suite after it scores code nobody wrote. Hashing before and
comparing after is the check, and the detector wants both halves of it: a digest nothing
compares is arithmetic, and a message nothing computes is a string.

**And `sigterm` has a blind spot of its own, which is SIGKILL.** SIGKILL cannot be
caught, blocked or handled: no handler runs, no `finally` runs, and no property in the
table above would have helped. The ordinary way to be SIGKILLed is not an impatient
person but a **timeout** — `subprocess.run(..., timeout=...)` kills the child outright,
and so does the kill step of a CI runner that has waited long enough. So a harness
satisfying all seven, invoked under a timeout it then exceeds, leaves the tree mutated
exactly as though it carried none of them, and every suite after it scores code nobody
wrote.

The remedy is not in the harness and cannot be: it belongs to **whatever invoked the
harness**, which has to check that the tree came back rather than trust that the harness
was given the chance to put it back. That is `restore-verified`'s argument one level up
— a restore that ran is not a restore that worked, and this is a restore that never ran
at all. See *Running harnesses in CI* below for the shape of the check.

They collapse into one rule worth remembering on its own, because the seven are just
instances of it:

> **A harness must answer separately whether the suite RAN, whether it FAILED, and
> whether the failure was the RIGHT one.** Collapsing any two of those three is how
> every defect in this family happens.

`assay anchors` checks the other half of a mutation table: every anchor string must
match its target **exactly once**. An anchor matching zero places is a guard nobody is
testing any more; one matching twice means `replace(old, new, 1)` took the first, which
may not be the one you meant, so the harness mutates something nothing asserts and
reports NOT DETECTED. *That reads as "your guard is untested" when the truth is "your
mutation tested something else"*, and those send you to opposite ends of the codebase.

`assay diff` asks whether a **change** carries the checks it needs: a guard added with
no mutation exercising it, a changed file no harness names, tests named for a
limitation that a capability change will turn red on working code.

## Half two: does the tree already answer this?

A property suite is per-artifact and behavioural. Duplication is cross-artifact and
structural. **Two implementations that both pass are two implementations that both
pass**; correctness was never the question duplication asks.

The usual instrument is a differential test, and it works, but you have to know which
two to compare: the pairing is *declared*, so it only ever covers pairs somebody
already suspected. `assay scan` finds them instead.

Every comparable function is probed **once** against one deterministic ladder of
inputs, producing an **outcome vector**. Two functions are candidates for being the
same function exactly when their vectors match, so discovery is a hash bucket rather
than a quadratic sweep, and the decider is **execution**, not text.

**Names are never read.** In the tree this grew out of, it paired `is_wordy` with
`_word`, which no textual or name-based detector puts together.

**One function is never a pair with itself**, and the ways it can look like one are not
obvious. A CommonJS module whose export IS a function arrives under two keys, `default`
and `module.exports`; a barrel module hands back the very objects its dependencies
defined, so a helper is reachable as both `registry.js::truncate` and
`truncate.js::default`. Both are one function wearing two names, and both are rejected
by **identity** rather than by comparing names or source text, so a function genuinely
copied into two files is still the two implementations it is.

| verdict | means | fails? |
|---|---|---|
| **differs** | a **witness input** on which the two disagree | no: this is the good outcome |
| **same** | no input told them apart, **and** the ladder discriminated | yes |
| **look** | not safely executable, no ladder, or a vacuous probe | **never** |

**`differs` is proof. `same` is not.** A witness is a fact; agreement across a finite
ladder is the absence of one. See *What `same` is worth* below: it is one character.

```bash
# Python
assay scan src/                                            # discover
assay pair src/format.py::humanize src/report.py::pretty   # the declared route, one pair
assay search src/format.py::humanize --in src/ lib/        # search before you generate
assay why src/format.py::humanize                          # ...and if it was not probed, why
assay accept --reason "read them; merging needs the router change"   # accept what you have read
assay cross src/format.py::humanize src/ui.mjs::pretty --with assay-js   # across the boundary
assay sweep src/ --against js/src --with assay-js          # ...for whole trees, naming no pair
assay bundle src/ > py.json                                # ...or hand the other half a bundle
assay search --stdin --in src/ lib/ < draft.py             # ...before it is a file
assay search --stdin --against js.json < draft.py          # ...and before it is a file, in the OTHER language
assay why --stdin < draft.py                               # ...and whether it can be searched for at all

# JavaScript: the same commands, and a reference is FILE::NAME in either language
assay scan src/
assay pair src/slug.js::slugify src/url.js::toSlug
assay search src/slug.js::slugify --in src/ lib/
assay search --stdin --in src/ lib/ < draft.js
assay why --stdin < draft.js
```

**`--stdin` is what "search before you generate" actually needs.** A `FILE::NAME`
names something that already exists, so a command taking only one asks you to write
the file first, which is the thing you were trying to find out whether to write. What
arrives on stdin is a **snippet parsed as a module**, not a bare function: it may carry
the imports and helpers the function needs, exactly as the file it is about to become
would. Two definitions in one snippet and `--name` says which, because picking one
would make the tool answer about code nobody asked about. `assay why` takes the same
two ways in, because it is the same question asked one step earlier: writing the file
first in order to be told the file was never the problem is what `--stdin` exists to
avoid.

**A query the ladder cannot tell apart is a `look`, never a `none`.** The census files
every function it cannot discriminate under *not probed*, so a constant or a projection
can only fail to find the other constants and projections — the match was never
possible, and printing the clean result there would say *we found none* where the truth
is *we never looked*:

```
$ assay search --stdin --in src/ lib/ < draft.py
       the tree was not searched: the census excludes every function this ladder cannot tell apart, so a match was never possible
  look     <stdin>::k — not discriminated by the ladder
           1 distinct returned value across the 31 rungs that answered, and 2 is the minimum — as far as this ladder can see it is a constant
```

It is the same answer `assay why` gives about the same vector, from the same code — the
two commands cannot disagree about it. A query the ladder *can* discriminate still gets
the ordinary `same none`, which means the tree really was searched.

## The pair no differential test covers: one function, two languages

A validator reimplemented in a Django backend and a Node frontend is the highest-value
duplication a polyglot repository has, and it is exactly what nobody writes a
differential test for — because writing one means agreeing, by hand, on what `False` and
`false` have in common.

```bash
# both binaries installed
assay cross src/api.py::shout src/ui.mjs::yell --with assay-js

# or one half writes a record and the other reads it, which needs neither to know
# the other exists
assay probe src/ui.mjs::yell > yell.json     # the JavaScript binary
assay cross src/api.py::shout yell.json      # the Python one
```

```
finding  same answer across languages (cross1/v3/d3b2ba61ccb7):
         src/api.py::shout [python]  vs  src/ui.mjs::yell [javascript]
```

**Two things have to be true before that means anything**, and the tool asserts both
rather than assuming them.

**One ladder, not two that resemble each other.** `BASE_VALUES` is a hand-written list
per language, and the strongest thing that can be said about the pair is that they cover
the same *shapes* — the languages have different primitives, so comparing lengths would
fail for a correct reason. That is enough for two Python functions and nothing like
enough here, where two lists that were meant to hold the same values and quietly stopped
is the entire hazard. So the cross ladder is **one JSON document**, carried verbatim by
both halves and parsed by each; `test_parity.py` compares the two texts, and the ladder
key carries a **digest of the rungs** so a comparison across a changed ladder is refused
by the branch that already refuses a mismatched arity.

**One vocabulary for outcomes.** `V:False` and `V:false` are two spellings of one answer.
The interlingua renders every value as canonical JSON, and the three lossy mappings are
choices about which mistake to make rather than accidents:

| | |
|---|---|
| an integral float | renders as an integer — JavaScript has **one** number type, and Python's int/float split is a difference *inside* one language |
| `undefined` and `null` | are one absence — Python has one and JavaScript has two, so the interlingua carries the one both can state |
| a Python `tuple` | renders as an array — JavaScript has no tuple, and a function returning one answers the question an array answers there |

Anything JSON cannot hold — bytes, a `Map`, a `Date`, a class instance — is **refused
rather than approximated**, and one such outcome makes the whole comparison a `look`.
`NaN` and the infinities are spelled out, because `JSON.stringify` turns all three into
`null`: three different answers reported as one absence.

**A raise carries no name.** The two languages' error taxonomies genuinely diverge —
`d['x']` is a `KeyError` in Python and `undefined` in JavaScript — so comparing names
would make every honest pair `differs`, and declaring them equal is worse, because `same`
is the verdict that *fails*. Every raise renders as one token, which masks a rung where
**both** sides raised: two of them can never be a witness, and the vacuity guard counts
only *returned* values so two of them can never be evidence either. A rung where **one**
raised and the other answered stays a witness, and it is the most interesting kind there
is.

Which is how the README's own `½` lesson reads across the boundary:

```python
def is_wordy(tok):
    if not isinstance(tok, str):
        return False
    return tok[:1].isalnum() or tok[:1] == "_"
```

```javascript
export function isWordy(tok) {
  if (typeof tok !== 'string') return false;
  return /[A-Za-z0-9_]/.test(tok[0] ?? '');
}
```

```
ok       differs: word.py::is_wordy [python]  vs  word.mjs::isWordy [javascript]
         ["½"] -> V:true vs V:false
```

**The two halves do not invoke each other.** `pip install assay-checks` gives you one and
`npm install assay-checks` gives you the other; neither can assume the other is on the
machine, and a command that shells out to a binary that may not exist fails in a way that
reads like the code being wrong. So `assay probe` writes a record and `assay cross` reads
one — and `--with CMD` runs that first step for you when both are installed. Two
references in the *same* language are a `look` pointing at `pair`, which compares them on
their own language's fuller ladder.

### ...and the pair nobody named: `bundle` + `sweep`

`cross` answers about two functions somebody already suspected. **Nobody suspects the
pair that matters.** A rule written once in the API and again in the front end, by two
people, a year apart, is exactly the duplication no one goes looking for — so the
command that finds it must not need either name.

Finding it means probing *both* trees, and the halves still do not invoke each other. So
one writes a bundle and the other sweeps against it:

```bash
assay bundle js/src > js.json           # the JavaScript binary: every function's cross vector
assay sweep  src/ --against js.json     # the Python one: which of mine does that tree answer?

# or, with both binaries installed, in one step
assay sweep src/ --against js/src --with assay-js
```

```
finding  same answer across languages (cross1/v3/d3b2ba61ccb7):
         src/api.py::shout [python]  vs  src/ui.mjs::yell [javascript]
         no input in the shared ladder told them apart — READ them; only a person
         decides whether the duplication is a defect

12 files, 0 not loaded
41 functions, 9 probed, 32 not probed
  zero-arity, so no input ladder applies         19
  not discriminated by the ladder                 8
  touches os                                      5
[javascript] 8 files, 1 not loaded
[javascript] 30 functions, 7 probed, 23 not probed
  zero-arity, so no input ladder applies         14
  could not load                                  6
  uses `this`, so it is a method                  3
```

**A bundle is many `assay probe` records in one envelope**, byte-identically shaped, so
an entry lifted out of one is a record `assay cross` already reads. It is versioned
apart from the record it carries — adding a key to the envelope does not change what any
one record means by `vector` — and both schemas are checked before anything is compared,
because comparing a new answer against the wrong earlier answer is precisely the defect
a difference checker exists to catch.

**Both censuses are printed, and the far one is the point.** A function the *other*
binary refused was never compared. A report that says `same none` while staying quiet
about the twenty-three functions the far side never probed is reporting *we never
looked* as *we found none* — across a boundary where the reader has no way to check.

**A bucket is only a comparison because of what never reached it.** `sweep` groups by
vector equality, which is legitimate only because every pair `assay cross` would refuse
was refused first: an outcome the interlingua cannot state, and a vector no rung told
apart from a constant. One place decides that for both commands. Two places deciding it
is how the tree-wide command comes to print a `finding` for a pair the pairwise command
calls a `look` — two answers to one question, and the weaker one on screen.

A bundle of your own language is a `look`-shaped refusal pointing at `scan`, which
compares one language's functions on its own fuller ladder.

### ...and for ONE function, before you write it: `search --against`

`sweep` needs a whole tree on both sides; `cross` needs the pair named. Neither answers
the question you actually have at the keyboard — **I am about to write this one
function; does the other language already have it?**

```bash
assay bundle js/src > js.json
assay search src/format.py::humanize --against js.json    # a function that exists
assay search --stdin --against js.json < draft.py         # ...and one that does not yet
assay search --stdin --in src/ --against js.json < draft.py    # both corpora, one run
```

```
finding  the javascript tree already answers <stdin>::loud: src/ui.mjs::yell
         no input in the shared ladder told them apart — READ them before writing
         a second one
```

**`--stdin` is the point of it.** *Search before you generate* cannot mean "first write
the file", and the cross-language form is where that bites hardest: the duplication you
are about to create is in a language your editor is not even open in. A `FILE::NAME`
works too, for the function you already wrote and now suspect.

**`--in` and `--against` are independent, and either alone is a complete question.**
Give both and you get both verdicts in one run, kept apart — the native ladder is the
stronger of the two, so the answers are not interchangeable and neither replaces the
other. Give neither and it is exit 2 rather than a clean `no findings` from a run that
looked nowhere.

**A query the shared ladder cannot tell apart is a `look`, never a `none`** — the same
rule the one-language `search` follows, from the same `admit` that fills the bundle. A
constant can only fail to match the other constants, because every constant was kept
out of the bundle in the first place; printing the clean result there would say *we
found none* where the truth is *we never looked*, on the one path where the reader is
about to write the function.

---

## Three verdicts, and they are never mixed

```
finding   something was CHECKED and is wrong.        exit 1
look      a rule applies and this tool CANNOT decide. never fails
ok        checked and fine.                          printed, not silent
```

`look` never failing is a deliberate limit, not timidity. **A check that reports things
a person then has to dismiss stops being read, and an unread check occupies the place
where a working one would go.** Anything the tool cannot settle by looking at the code
is offered for a human to settle.

`ok` is printed rather than left silent because **"we found none" and "we never looked"
are different claims**, and only one of them is evidence. Every scan ends with a census
of what it refused and why:

```
247 files, 32 not loaded
  reads the clock                               19
  touches os                                    13
1412 functions, 137 probed, 1275 not probed
  no arguments                                 274
  not discriminated by the ladder              127
```

**A census answers about a tree; `assay why` answers about a name.** Reading `no
arguments 274` does not tell you whether the function you expected to be probed is one
of the 274, and guessing which of eight gates rejected it is the work the census was
supposed to save you:

```
$ assay why src/format.py::humanize
  look     src/format.py::humanize — touches os
           refused before the ladder, so it is in no bucket and can pair with nothing

$ assay why src/slug.js::slugify
  ok       src/slug.js::slugify — probed on arity1/v3: 29 of 29 rungs answered, 23 distinct value(s)
```

It never produces a finding: it reports what the tool did, and decides nothing. `--stdin`
asks it about a snippet instead of a name, with `--name` picking one definition out of
several, exactly as `search` does. It also splits the one reason the census cannot split — `not discriminated by the ladder` covers
a **constant**, a **projection**, and a function the ladder **never reached**, and those
need a wider ladder, a different function, and inputs of another shape respectively.

On the JavaScript half the answer may be at the **file** level, and it says so: a file
that reaches for the clock *on the way in* is refused whole, so none of its functions
were ever looked at and every one of them has the same answer. A clock inside a **body**
is a different answer — it refuses that function and leaves the rest of the file
probeable.

**Files and functions are counted separately, and the second line is an equation.** A
file nobody opened holds an unknown number of functions (not opening it is exactly why
the number is unknown), so adding the two populations together prints a total nobody
measured. Reading `probed + not probed` and not getting `functions` is the shape of
that mistake.

**Exit codes are identical for every subcommand**, because scripts depend on them more
than on anything printed: `0` nothing to read, `1` findings, `2` the tool could not
run. `2` is never suppressible: "could not run" and "found nothing" are opposite
situations, and letting the second silence the first is how a broken invocation reads
as a clean audit for months.

## `--json`, for the thing reading this instead of you

Every subcommand takes `--json`, on either side of the subcommand name, and emits one
object instead of the prose report:

```json
{
  "baseline": null,
  "command": "scan",
  "error": null,
  "exit_code": 1,
  "items": [
    {"verdict": "finding", "message": "same answer (arity1/v3): …",
     "where": "src/slug.js::slugify", "detail": "…"}
  ],
  "language": "python",
  "notes": ["…the census, verbatim…"],
  "root": "/abs/path",
  "scan": {"files": 247, "functions": 1412, "probed": 137, "not_probed": 1275,
           "skipped": {"no arguments": 274}, "unloadable": {"reads the clock": 19},
           "skipped_refs": {"src/fmt.js::pad": "no arguments (a ladder cannot …)"},
           "unloadable_paths": {"src/hbs-helpers.js": "reads the clock"}},
  "schema": 1,
  "tool": "assay",
  "version": "0.4.0"
}
```

**One shape, always.** A run that could not start emits the same keys as one that
finished, with `error` set and `items` empty. Prose on the failure path and JSON
everywhere else hands you a parse error at exactly the moment the tool could not run,
and a sloppy consumer reads a parse error as *no findings* — the same collapse `2` is
never suppressible to prevent.

**`look` gets no severity.** The three verdicts are not mapped onto somebody else's
error/warning/note; that mapping is the collapse the vocabulary exists to prevent. The
verdict travels by its own name and you decide what it means.

**The census is data, not the printed equation.** `probed + not_probed == functions` is
yours to check rather than something you parse back out of `notes`, and files stay a
separate population from functions. A command that ran no scan emits `null` rather than
`0`, because zero probed functions and no sameness half at all are different claims.

**And it names what it never looked at.** `unloadable` and `skipped` count;
`unloadable_paths` and `skipped_refs` say *which*, and carry the whole reason rather
than the tallied key. `could not load 12` is a number you cannot act on — the only
recourse is `assay why FILE::NAME`, which has to be told a file and a function name in
it, the two things the tally withheld. The full reason matters most in the biggest
bucket: a tally key stops at the first `(`, which is exactly where a load error's
message begins, so `could not load (JWT_SECRET must be set)` survives here and nowhere
else. `sum(unloadable.values()) == len(unloadable_paths)`, so the two never drift.

**The baseline's caveat travels as data.** `performed` says what this run audited and
`unchecked` names every entry it could not have seen fire, rather than an empty `stale`
list that reads as "checked, found none". There is no `complete` boolean: completeness
stopped being a property of the run when an entry learned to name the command that
fires it.

**Keys are sorted all the way down, in both halves**, so one contract prints as one
document rather than two. `language` is in the payload because a polyglot repository
runs both halves over one root and a consumer merging two reports has no other way to
tell which produced which.

**`schema` is versioned separately from the tool.** A consumer parsing this has the
same claim on stability as a script reading the exit code, and the two do not move
together.

## Configuration

`assay.json` in your project root. One file serves both languages, deliberately: two
files that had to be kept in step would be the exact duplication this tool exists to
find.

```json
{
  "runner_exempt": [{
    "path": "test/mutate_api.py", "property": "sigterm",
    "reason": "writes only under a tempdir, so a kill leaves nothing mutated"
  }, {
    "path": "test/mutations-http.js", "property": "parses-mutant",
    "reason": "every mutant goes through the bundler first, which rejects one that does not parse"
  }],
  "anchor_exempt": [{
    "path": "test/mutate_api.py", "reason": "anchors into generated source"
  }],
  "baseline": [
    "test/mutate_legacy.py: no `evidence` (no failures reported and no test executed look identical)",
    {
      "line": "same answer (arity1/v3): src/slug.js::slugify, src/url.js::toSlug",
      "reason": "one is the URL path form; merging them needs the router change first",
      "from": "scan"
    }
  ]
}
```

Paths are relative to `--root`, and **the language of the path is not a category**:
`runner_exempt` and `baseline` take Python and JavaScript entries side by side,
because a polyglot repository has one root and the audit that reads this file may be
either binary. `anchor_exempt` affects only `assay anchors`, which both halves now
run — the Python half by parsing the table out with `ast`, the JavaScript half by
importing the harness and reading the exported table as data.

**A `baseline` line is the exact text of a `finding`, and only a `finding`.** It is
matched whole, never as a prefix, so the line above is what `assay` printed rather
than a description of it. A `look` cannot be baselined and does not need to be: it
never fails the run, so there is nothing to accept.

**An entry is that line, or an object carrying it as `line`.** The bare string stays
legal because adopting this means pasting lines out of a run, and a format that refuses
the paste is a format nobody adopts. The object form carries the two things a string
cannot:

| field | | |
|---|---|---|
| `line` | required | the finding's exact text |
| `reason` | required in the object form | why you accepted it |
| `from` | optional | the command that can produce it — one of `runners`, `anchors`, `diff`, `scan` |

`from` is what makes staleness a property of the **line** rather than of the run; see
below. A `from` naming no real command is a hard error rather than a line nobody can
ever check.

**`assay accept` writes the entry for you**, and refuses to write the two entries you
should not have:

```bash
assay accept --reason "one is the URL path form; merging needs the router change"
assay accept "same answer (arity1/v3): src/slug.js::slugify, src/url.js::toSlug" --reason "..."
```

With no line it takes every new finding; with one it takes that one. It fills in `from`
from the audit that actually produced the line, so the check that fires it is the one
that can later call it stale. `--reason` is required.

It refuses **a `look`** — a look never fails the run, so the entry could never be
suppressed and never expire, a record of nothing indistinguishable from a record of
something already fixed. *This package shipped a config example that baselined a look.*
It was corrected by editing the example, and an example is corrected once per copy of
it; a command that cannot make the mistake is corrected once.

It also refuses **a line nothing printed**, because an entry that does not fire is stale
the moment it lands. Nothing is typed by hand: the entry is the finding's exact text,
taken from the run, which is what makes whole-line matching safe.

Put the line **before** the flags. `--scan` takes a list, and a line after it is one
more path.

**Every table is read in both directions.** An exemption naming a file that no longer
exists is a finding. A property name that does not exist is a finding. A baseline line
that no longer fires is a finding, because someone fixed the problem and left the
record claiming otherwise.

A table read only one way rots into decoration: it accumulates entries, none of them
ever expire, and after a while it lists things somebody once believed rather than
things that are true. The second direction costs about ten lines and is the difference
between a **suppression file** and a **record**.

`reason` is required and not decorative: **an exemption without one cannot be told
from an oversight**, and six months later nobody can say which it was. The `baseline`
is the table this matters most for — it accumulates fastest and rots first, because a
fixed finding leaves its line behind in silence — which is why the object form asks for
one and `assay accept` will not write an entry without it.

Adopting this on an existing project means starting with a backlog. The two dishonest
ways to handle that are a magic threshold (goes stale in silence) and a blanket
suppression (hides the next real one). The `baseline` does neither: a new finding is
not in the list so it fails, and one you fixed no longer fires so its line fails as
stale.

**Staleness is a property of the line, not of the run, and getting that wrong made the
tool cry wolf at itself.** `assay runners` cannot produce a finding that only `diff`
reports, so checking staleness there flagged every `diff` line as fixed: the audit
reporting a problem with its own config, on a clean tree, on every run.

The first fix was to check staleness only from `assay all`. Correct, and blunt enough to
be its own problem: every line in every other run went unchecked, and the run printed a
disclaimer where a number belongs. An entry that names the command firing it can be
answered by that command alone, so each line lands in exactly one of three places:

```
BASELINE assay.json — 3 accepted, 0 new, 1 stale, 2 NOT checked for staleness
                      (anchors: 1; no `from`, so it needs `assay all`: 1)
```

*Stale* is a line this run could have seen fire and did not. *Not checked* is a line
this run could not have seen at all — counted, and never folded into the stale number,
because **`0 stale` from a run that never looked reads as "nothing is stale"** and those
are different claims. A line with no `from` keeps the old rule: only a run that
performed every audit can call it fixed, since nothing narrower knows what produces it.

Every command still *suppresses* accepted findings, because that direction is safe from
any run: a line that fires is a line that fires.

**`assay all --scan PATH` is the complete run** — `all` alone does not perform the
sameness half, and saying otherwise is how a `same answer` line got called stale on a
clean tree. Tag your entries with `from` and any command answers its own; leave them
untagged and the complete run is the only one that can.

**Under Node this used to be impossible**, because `assay anchors` was Python-only and
no JavaScript run performed every audit that can produce a baseline line. It does now,
so the JavaScript half answers on exactly the same terms.

## What `same` is worth

The first run of the sameness half paired these two:

```python
def is_wordy(tok):  return tok[:1].isalpha() or tok[:1] == "_" or tok[:1].isdigit()
def _word(tok):     return tok[:1].isalnum() or tok[:1] == "_"
```

They are **not** the same function (`isalnum` is a strict superset that also covers
numerics), but every character in the ladder made them agree. So three characters went
in (`½`, `é`, tab+newline), and:

```
differs  keystrokes.py::is_wordy  vs  pycomplete.py::_word
         ('½',) -> V:False vs V:True
```

A `same` became a `differs` with a witness, from **one character**. That is what `same`
is worth, and it is why the verdict is worded the way it is.

The ladder carries those characters in both halves, so the same question asked in
JavaScript is settled on the same rung. This pair is a demonstration rather than a
finding out of somebody's tree, but the run is real:

```javascript
export function isWordy(tok) { return /[A-Za-z0-9_]/.test(tok[0] ?? ''); }
export function wordish(tok) { return /[\p{L}\p{N}_]/u.test(tok[0] ?? ''); }
```

```
ok       differs: w.js::isWordy  vs  w.js::wordish — ["\u00bd"] -> V:false vs V:true
```

`½` is `\p{N}` and is not in `[0-9]`, which is the whole of the difference between two
functions that agree on every ASCII token you would think to try. The general lesson is
worth stealing whatever you use to test: **ask what characters your inputs never
contain, then add them.**

## The guard the sameness half rests on

Two functions that raise `TypeError` on every input agree perfectly. So do two that
return the same constant. Without a guard, a scan of any codebase reports every
one-argument function as everyone else's twin. `discriminating()` therefore requires at
least two **distinct returned values** and rejects a **projection**: a function handing
back one of its own arguments.

Both halves of that guard exist because both mistakes were made:

- **Counting distinct OUTCOMES is not enough.** One returned value plus one exception is
  two distinct outcomes, so a keyword predicate that returns `False` for every string in
  the ladder and raises on everything else satisfies it. The counting was rewarding a
  probe that had found the function's **type errors** and never reached its behaviour.
- **Comparing whole vectors against the identity is not enough.** A transform whose
  vocabulary the ladder lacks is the identity wherever it answers and raises everywhere
  else, so its vector differs from the projection at exactly the positions where the
  function refused to run. The question is about the positions where it **answered**.
- **Returning an argument is not the only way to do nothing with it.** COPYING it is
  the same emptiness in another shape. Two unrelated query-param transforms (one
  renaming keys, one splitting a `sort` value) agreed on every rung of the ladder,
  because it holds no key either of them recognises and both degraded to *copy the
  object through*. A shallow copy is not behaviour the ladder reached; it is behaviour
  the ladder missed, so it is rejected alongside the identity.

The general form: *a round trip is necessary and not sufficient, because an identity
program passes it.*

## Safety: this executes your code

Stated plainly, because it does.

**Python.** A single function's source is lifted out with `ast` and executed alone, so
**the containing module is never imported**. A function is probed only if it is
module-level, undecorated, not a method, not a generator, 1–3 arguments, and reaches
nothing outside its arguments: no files, no network, no clock, and **no randomness**
(`random` and `time` import cleanly and both make an outcome depend on something the
ladder does not control, so a `differs` from either is noise and a `same` is luck). Free
names resolve only from the file's own literal constants, its other gated functions, and
a stdlib allowlist. Each probe runs in a subprocess with a per-input `SIGALRM` and a wall
timeout, so an infinite loop is a `look`, not a hang.

**JavaScript, and this is a real difference rather than a detail.** A function object
only exists once its module has been evaluated, so the JS half **loads the module and
therefore runs its top-level code**. The child answers the parent on **fd 3**, never on
stdout, because a module is free to print at import time and an answer sharing a channel
with arbitrary output is an answer that output can destroy: **one function per line, as
each finishes**, so the kill that bounds a non-terminating function costs that function
rather than the file. Two compensations: it happens in a child process,
and the file's source is gated *before* it is loaded at all.

**The gate is two questions, because it guards two events.** *May this module be
imported?* is asked of **module-scope code only** — top-level statements, initializers,
IIFEs, class fields — because that is what running an import actually executes. A
`new Date()` sitting in a function body is no evidence about importing the module, and
refusing the file for it took every pure helper beside it down with it: on a barrel of
ten Handlebars helpers, two clock-using ones cost the other eight their eligibility.

A body is deferred **wherever a body cannot run** — under a declaration, bound to a
name, or as an object-literal property or shorthand method, which is how CommonJS
exposes a barrel. An **IIFE** is refused in every position: it runs on the way in. So is
an **accessor** — `{ get x() { … } }` runs when the property is *read*, and enumerating
a module's exports reads every one of them.

*May this function be called?* is the second question, and `fn.toString()` cannot answer
it alone — **a free name resolves in a module scope the function's own text cannot
see**. So the per-function gate runs over its real source (including the **declared
parameter list**, because `fn.length` stops counting at the first default) and then over
everything it **reaches**: local bindings, followed transitively, and relative imports
followed into modules that themselves pass the load gate. A bare package specifier, a
core module, an unknown global and a name declared twice are each refused **by name**.
Probing *calls* the function, so this is the last thing between the ladder and a real
side effect on a real path.

The refusal is a chain you can walk back to the code —
`reaches config, which reaches env, which touches process`.

**The residue is genuine:** a module with an import-time side effect that mentions none
of the gated names will still be evaluated. If that is unacceptable for your tree, point
the tool at the files you trust rather than at the whole repository.

## Two implementations, one contract

| | Python | JavaScript |
|---|---|---|
| `scan` / `pair` / `search` | yes | yes |
| `why` | yes | yes, and the answer is often the FILE gate |
| `probe` / `cross` | yes | yes |
| `accept` | yes | yes |
| `runners` | yes | yes, with a weaker `dead-vs-real` (see below) |
| `diff` | yes | yes |
| `anchors` | yes, by **parse** | yes, by **import** |

**`anchors` is the one command whose halves work by different mechanisms**, and the
difference is worth knowing before you rely on either. Python lifts the table out with
`ast` and executes nothing. JavaScript has no parser in its standard library and this
package has no dependencies, so for a long time the honest answer here was a gap: a
regex cannot tell a label from an anchor, and **a check reporting confident nonsense
about which strings are anchors is worse than no check**.

But the JavaScript half already loads modules. A table that is **exported** is readable
as *data* — a property access, no parser, no dependency, no approximation anywhere in
the path:

```javascript
export const MUTATIONS = [
  ['the negative guard stops firing', "if (x < 0) throw new RangeError('x');", 'if (false) {}'],
];
```

Two consequences, one in each direction. The harness **gets imported**, so guard your
`main()` behind the entry-point check every program in this package already carries — a
harness that does work at import time will do that work, in a child process that cannot
reach your session but on the real tree. In exchange, a **computed** anchor is simply a
string here, where the Python half can only report it as a shape it cannot read.

A harness that exports no table is a `look`, never a finding: it has not opted into
being read this way, and inventing a reading of it is the thing this declines to do.

The JS `dead-vs-real` detector is textual where Python's reads an AST. The consequence is
one-directional and worth knowing: it will not produce a false FINDING, it will miss a
real one. If your harnesses are Python, run the Python half over them.

`python/tests/test_parity.py` asserts the contract rather than trusting it: same
property names, same verdict names, same config keys, same subcommands, same ladder
version, same thresholds, same baseline families, same probe schema — and, for
`assay cross`, the same cross ladder **byte for byte**, because two lists that were
meant to hold the same values and quietly stopped is the only thing that comparison
rests on. Two implementations of one contract is exactly the duplication this tool
exists to find, so it is checked.

## Also shipped

**GitHub Action**, one `uses:` line instead of a run block:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }   # `diff` needs a base ref; a shallow clone has none
- uses: Megapixel99/assay-checks@v0.4.0
  with:
    command: all       # every audit that can produce a baseline line
    paths: src         # ...and with `all`, paths mean `--scan`: the sameness half
                       # is what makes the run COMPLETE for an untagged entry

# The same action runs the other half. `language` is `python` unless you say otherwise,
# so a JavaScript project has to name it.
- uses: Megapixel99/assay-checks@v0.4.0
  with:
    command: scan
    paths: js/src
    language: node

# ...and across the two, naming no pair. `against` is the far tree; `with` is the far
# binary, which is named rather than guessed — both packages install `assay`, so a
# half that guessed would compare a tree with itself.
- uses: Megapixel99/assay-checks@v0.4.0
  with:
    command: sweep
    paths: src
    against: js/src
    with: assay-js
```

**Running harnesses in CI: check the tree afterwards.** `assay runners` audits the
harness, and the harness cannot audit the thing that kills it. A step that runs one
under a timeout has to answer for the SIGKILL case itself, and `git` already knows the
answer:

```yaml
- name: mutation harnesses
  run: |
    rc=0
    for h in $(git ls-files '*mutations*.py'); do
      timeout 1200 python3 "$h" || { echo "FAILED: $h"; rc=1; }
      if ! git diff --quiet; then
        echo "DIRTY: $h left the tree mutated"; git checkout -- .; rc=1
      fi
    done
    exit $rc
```

Four things in that loop are the point rather than boilerplate. **`git ls-files`, not a
list of harnesses**: a list is one more table that goes stale, and the harness nobody
added to it is the one that has been asleep longest. **The dirt check runs after every
harness, not once at the end**, because a tree checked once names the last harness
rather than the one that broke it, and a mutated file left behind means every harness
after it scored code nobody wrote. **The failure is recorded and the loop continues**
rather than exiting on the first one — a red run that means *one broke and the rest were
never asked* is the same collapse `dead-vs-real` exists to prevent, one level up. And
**`rc` is what exits**, because a loop that reports failures and returns 0 is the
sleeping suite this whole half of the tool is about.

**Docker**, both runtimes, one image, for CI that has neither toolchain — and the one
place `assay cross` needs no arranging, because both binaries are already there:

```bash
docker run --rm -v "$PWD:/work" assay runners
docker run --rm -v "$PWD:/work" --entrypoint assay-js assay scan src
docker run --rm -v "$PWD:/work" assay cross src/api.py::shout src/ui.mjs::yell --with assay-js
docker run --rm -v "$PWD:/work" assay sweep src --against js/src --with assay-js
```

## Limits (honest ones)

- **`same` is never equivalence.** It is "no input in this ladder told them apart", and
  the `is_wordy`/`_word` pair above is the measured proof that the distance between
  those two sentences can be one character. A ladder is a sample; only `differs` is
  proof.
- **Coverage of the sameness half is roughly a tenth of functions, and the census says
  so.** The largest excluded class is zero-arity, which no input ladder can ever tell
  apart. Every exclusion is printed with its reason and a count.
- **It compares functions, not programs.** Two programs that are the same function under
  a *mapping of their arguments* (a cipher and a special case of a more general one)
  are out of reach. That needs a declared pairing, and this does not replace one.
- **Cross-language discovery runs on a strictly weaker ladder than `scan` does.**
  `assay sweep` buckets every function of both trees on the shared ladder, which is the
  *intersection* of what the two languages can express — so it discriminates less than
  either native one, and a `same` it reports is worth less than a `same` from `scan`.
  Use `cross` on a pair you already suspect and you get the same ladder; use `pair` or
  `scan` within one language and you get a fuller one. A sweep is where to start
  looking, not where to stop.
- **The cross ladder is a subset, and `same` there is worth less than `same` here.**
  It holds no tuple, no `set`, no `undefined`, and one number type. Two functions it
  cannot tell apart may well be told apart by a value only one language has — which is
  why two references in the same language are refused, with a pointer at `pair`.
- **The ladder is hand-written for three arities.** A domain whose inputs are structured
  (an AST, a socket, a dataframe) gets `not discriminated`, and correctly so.
- **The JavaScript half inherits Node's module resolution, including its version
  differences.** A `.js` file containing `export` in a directory with no
  `package.json` is a SyntaxError on Node 18 and loads fine on Node 22
  (module-syntax detection arrived in between), so the same tree can report different
  coverage on two runners. Ordinary projects declare `"type"` and are unaffected; a
  loose directory of ESM `.js` files is not, and shows up as `could not load` in the
  census rather than as a wrong answer.
- **An `async` function is probed on the value it settles on.** `async function f(x)
  { return x * 2; }`, `function g(x) { return x * 2; }` and `function h(x) { return
  Promise.resolve(x * 2); }` all answer the same question, and all three are compared
  as one. A rejection is the same outcome as a throw, by type. **`async` widens what
  gets executed**, and that is worth saying plainly: a service-layer function that
  awaits a database is a function this tool will call. It was already true that loading
  a module runs its top-level code, so this is more of the same hazard rather than a new
  one, but it is more of it, and the answer is unchanged: point the tool at the files
  you trust. `async for` and `async with` are still refused, because both drive an
  object's protocol methods and the ladder cannot supply one.
- **A timeout is an outcome; only a *synchronous* hang is a `look`.** Python bounds
  every input with `SIGALRM`, so a non-terminating input lands in the vector as a raise.
  JavaScript bounds every awaited rung with a timer racing the promise (the event loop
  is free while a promise is pending, so that race is a real interrupt), and the rung
  becomes `E:TimeoutError`, the same outcome by the same name. **A synchronous loop is
  the one case with nothing to interrupt it**: it never yields, so the JS half falls
  back to a wall clock and a kill, and that function is a `look` rather than a vector.
  It costs only itself: the child answers one function at a time, so the kill loses the
  function that hung and, after it, the ones never started, each named as such in the
  census, while everything already answered keeps its vector.
- **The probe exits when it has answered, rather than when the event loop drains.** A
  module that opens a pool, a socket or an interval at import time keeps its process
  alive long after the last answer is written, and every such file used to cost the full
  wall timeout for work that finished in a fraction of a second. This is not an async
  problem: a file of ordinary synchronous functions pays it too if its module opened
  something on the way in.
- **A `--stdin` snippet may not import from the tree.** Python already refuses one:
  free names resolve from the snippet's own constants, its own gated functions and the
  stdlib allowlist, and nothing else. JavaScript refuses one for a different reason
  worth stating, because a module has to be **on disk to be imported at all**: outside
  the root a relative import resolves to nothing, and inside the root the snippet would
  be scratch state beside the code under test, which is what `no-tree-writes` audits
  harnesses for. A snippet that already imports half the tree is a file, so point
  `search` at the file.
- **A JavaScript snippet that exports nothing needs `--name`.** A module's functions
  reach the probe through its exports, so an unexported declaration is invisible, and
  finding it anyway would mean reading declarations out of source with a regex — the
  same thing `anchors` declines to do. The name is asked for instead. Python has no
  such gap: a top-level `def` is a top-level `def`.
- **`assay anchors` under Node IMPORTS the harness, and that is a real hazard rather
  than a detail.** The Python half reads the table with `ast` and executes nothing; the
  JavaScript half has no parser to read it with, so it reads the table as *data* — which
  means the module that builds it has run. It runs in a child process, so a crash or a
  hang costs the probe rather than the audit, but a harness that mutates the tree at
  import time mutates the tree, and no child process undoes that. Guard `main()` behind
  the entry-point check every program in this package carries. If yours cannot,
  `anchor_exempt` is the table for saying so, with the reason.
- **The seven properties are about mutation harnesses.** If your project has none, that
  half has nothing to say about it and says so rather than reporting a pass.
- **`sigterm` cannot cover SIGKILL, and a timeout is usually a SIGKILL.** The property
  is satisfied by a harness that turns SIGTERM into an exception, which is the whole of
  what a process can do about being asked to stop. Being *killed* is not that: no
  handler runs and no `finally` runs, so a harness passing all seven still leaves the
  tree mutated when the thing invoking it runs out of patience. Only the invoker can
  check that, and `assay` does not see the invoker. See *Running harnesses in CI*.
- **`targets_mentioned` under-reports.** A harness that merely mentions a filename counts
  as covering it. An audit that errs should err toward saying less.
- **It is not a code reviewer.** It cannot tell you an abstraction is wrong, a name is
  misleading, or an edge case is unhandled, and it does not decide whether duplication
  is a defect. Only one flavour of duplication is; telling them apart is a judgment about
  what two pieces of code are *for*, which no execution can make. The output says
  `READ them` and stops there.

## Development

Each half lives in its own directory, and the two are laid out the same way:

```
python/assay/     the Python package, imported as `assay`, published as assay-checks
python/tests/     its suites, and the mutation runner that audits them
js/src/           the JavaScript half, published as assay-checks on npm
js/test/          its suites
```

**The folder is `python/`, the import is still `assay`.** They are different names
deliberately: the directory sits beside `js/` so the two halves are findable in the
same shape, while `import assay`, `python3 -m assay` and the `assay` console script
are what is already published and do not change. `pyproject.toml` bridges the two with
`package-dir`, so an installed wheel puts `assay` at the top level exactly as before.

Working from a checkout rather than an install, `python/` is what goes on the path:

```bash
python3 python/tests/run_tests.py        # 319 tests, ~5 s
npm test                                 # 302 tests, ~20 s
python3 python/tests/mutations_assay.py  # 193 mutations, both halves
PYTHONPATH=python python3 -m assay scan python/assay   # scanned by its own scanner
PYTHONPATH=python python3 -m assay --root . all --base origin/master --scan python/assay
```

No install step, no virtualenv, no `npm install`: both halves are standard library
only, and `PYTHONPATH=python` is the whole of what an install would have done. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rules this code is built on and what
happens when a mutation comes back `NOT DETECTED`.

The mutation runner carries all seven properties `assay runners` audits for, and several
of its mutations are versions this tool actually shipped, kept as mutations rather than
as comments, so a defect fixed once cannot come back quietly.

**It breaks both halves.** For a while it could mutate Python only, and the gap did not
show in its score: it printed a full tally while every guard in `js/src` had nothing
breaking it on purpose. A tally over the half you can reach reads exactly like a tally
over the whole thing, which is the defect this package exists to report, so it was
pointed at itself. A mutation names a file, the suffix says which half, and that half's
suite is the one that has to go red.

One of them is worth naming here because no ordinary test could have caught it: a **NUL
byte** landed where a space belonged inside a template literal. The file displayed
correctly, the parser accepted it, and printing the function back showed a space, while
the key it built at runtime could never match the key in the table, so the audit went on
reporting the finding an exemption had been written to silence. That reads exactly like a
config that was never loaded. `test_parity.py` now checks the bytes.

**A mutation that comes back `NOT DETECTED` is not always a missing test, and it is
never left in the table.** Three came back that way while 0.3.0 was being written: two
were fixtures that could not reach the case, and the third was a guard whose absence
produced *the same observable as its presence* — dead code with a comment explaining
what it did. That last one is the defect this package exists to report, arriving inside
it, so the branch was deleted and the check moved to the thing it had been restating. A
mutation nothing can catch is a table entry claiming a guard is covered when nothing
breaks it on purpose.

## A note on the name

`assay` is a common word and the space is not empty. **`@metahub-ai/assay`** (Apache-2.0,
live) evaluates AI artifacts (skills, MCP servers, agents) with static analysis plus
sandboxed behavioural testing, and produces signed reproducible reports. Adjacent
territory and a different question: it asks whether *somebody else's artifact* can be
trusted; this asks whether *your own checks could have failed* and whether your tree
already answers what you are about to write.

Bare `assay` is taken on npm (2013, dormant) and on PyPI, which is why this ships as
**`assay-checks`** on both. **Its global CLI is still `assay`, and so is theirs**: if
you install both globally, one shadows the other. Recorded here rather than worked
around, so nobody has to rediscover it from a confusing `assay --help`.

## License

MIT
