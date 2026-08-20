# Contributing

## Running it

```bash
python3 tests/run_tests.py          # 148 tests, ~15 s, no dependencies
node --test js/test/*.test.js       # 111 tests, ~2 s
python3 tests/mutations_assay.py    # 56 mutations, ~4 min
python3 -m assay scan assay/        # the package, scanned by its own scanner
python3 -m assay --root . all --base origin/master
```

No install step, no virtualenv, no `npm install`. Both halves are standard library
only, and that is a constraint rather than a current state: **a quality tool that
drags in a dependency tree is one more thing that can break the build it was added
to protect.** CI asserts it rather than trusting `dependencies = []`.

## The rules this code is built on

These are not style preferences. Each one is a defect that shipped, and the reason
it is worth stating is that every one of them produces output that looks like
success.

**Three verdicts, never mixed.** `finding` was checked and is wrong. `look` means a
rule applies and the tool cannot decide. `ok` was checked and is fine. `look` never
fails the run — a check that reports things a person then has to dismiss stops
being read, and an unread check occupies the place where a working one would go.

**`ok` is printed, not left silent.** "We found none" and "we never looked" are
different claims and only one is evidence. Every scan ends with a census of what it
refused and why.

**Exit codes are the interface.** `0` nothing to read, `1` findings, `2` the tool
could not run — identical for every subcommand, because scripts depend on them more
than on anything printed. **`2` is never suppressible**: "could not run" and "found
nothing" are opposite situations, and letting the second silence the first is how a
broken invocation reads as a clean audit for months.

**Every table is read in both directions.** An exemption naming a file that no
longer exists is a finding. A baseline line that stopped firing is a finding. A
table read one way only accumulates entries, none of them expire, and after a while
it lists what somebody once believed rather than what is true.

**A `reason` is required and load-bearing.** An exemption without one cannot be told
from an oversight.

## Adding a check

1. **Write the test first, by asking what a mutation would change.** A test written
   by asking what the function *does* passes for the wrong reason far more often
   than one written by asking what *breaking it* would do.
2. **Drive it in both directions.** A detector tested only on code that should fail
   it will happily fire on code that should pass, and that is the failure mode that
   gets an audit switched off. Every property in `checks.py` has a harness that must
   be flagged and one that must not.
3. **Add a mutation to `tests/mutations_assay.py`** that puts the defect back — not
   one that merely changes the code. Several entries there are versions this package
   actually shipped, kept as mutations rather than comments so a fix cannot come back
   quietly.
4. **Run the mutation runner and check WHICH test went red.** "Something failed" and
   "the check that covers this failed" are different claims.

If a mutation comes back `NOT DETECTED`, the first thing to suspect is the fixture,
not the code. Three of this package's tests were rewritten because their fixture
could not tell the guard from its absence — a lightweight tag where an annotated one
was needed, a balanced pair of backticks where one was needed, a corpus so
repetitive the count was ambiguous.

## Changing anything shared between the two halves

`tests/test_parity.py` pins property names, verdict names, config keys, ladder
version, thresholds and the documented exit codes across Python and JavaScript. One
`assay.json` is meant to serve a polyglot repository: **if the halves disagree, the
same config yields different verdicts depending on which binary CI invoked, and
nothing says so.**

It reads the JavaScript as *text*. Running it would need Node, and a suite that
silently skips when a runtime is missing reports a pass for a check that never ran.

## Touching the ladder

`BASE_VALUES` in `sameness.py` and `js/src/sameness.js` decides what `same` is
worth. Two rules:

- **Bump `LADDER_VERSION` when you change it.** Vectors from different ladders must
  never be compared, and the key is what says so.
- **Ask what characters your inputs never contain, then add them.** The ladder
  carries `½`, `é` and tab+newline because without them a predicate written over
  ASCII and one written over Unicode categories agreed on every value — and one
  character turned that `same` into a `differs` with a witness.

## Things that will not be accepted

- A check that makes `look` fail the build.
- A dependency.
- A detector that fires on correct code. A wrong conviction is worse than a missing
  check, which is why unused-import detection is deliberately absent: re-exports and
  side-effect imports make it wrong too often.
- A number reported without saying what produced it.

## Origin

Extracted from a research repository where both halves were built as instruments,
each of the six runner properties earned by a defect that shipped there. The
citations are gone from this code on purpose — a rule should carry the failure it
prevents in its own words, not a pointer to somebody else's notebook.
