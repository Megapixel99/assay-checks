# assay

[![PyPI](https://img.shields.io/pypi/v/assay-checks?label=PyPI&color=3775A9)](https://pypi.org/project/assay-checks/)
[![npm](https://img.shields.io/npm/v/assay-checks?label=npm&color=CB3837)](https://www.npmjs.com/package/assay-checks)
[![ci](https://github.com/Megapixel99/assay-checks/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Megapixel99/assay-checks/actions/workflows/ci.yml)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Two questions ordinary CI does not answer, about work that **already passes its tests**:

> **Could those tests have failed?**
> **Does the tree already answer this?**

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

Neither half is a linter and neither is a test runner. Both are stdlib-only, in both
languages, because a quality tool that drags in a dependency tree is one more thing
that can break the build it was added to protect.

---

## Half one: could those tests have failed?

`assay runners` audits **mutation harnesses**: the scripts that deliberately break your
code and check that something notices. If you run one, these are the six ways it can
lie to you, and each is a failure that looks exactly like success:

| property | what it means | what goes wrong without it |
|---|---|---|
| `evidence` | positive proof each suite RAN | no failures reported and no test executed look identical |
| `dead-vs-real` | a DID-NOT-RUN is not a detection | counting any failure scores a crash as a catch |
| `restore-in-finally` | the restore cannot be skipped by an exception | an exception mid-run leaves the target mutated |
| `sigterm` | SIGTERM becomes an exception so `finally` runs | **SIGTERM does not run `finally`**: a kill leaves the tree broken |
| `parses-mutant` | a file-breaking mutation is not scored | a syntax error makes every suite fail, which reads as a catch |
| `no-tree-writes` | no scratch state beside the code under test | a clean target is not a clean tree |

They collapse into one rule worth remembering on its own, because the six are just
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

# JavaScript: the same three commands, and a reference is FILE::NAME in either language
assay scan src/
assay pair src/slug.js::slugify src/url.js::toSlug
assay search src/slug.js::slugify --in src/ lib/
```

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
    "same answer (arity1/v3): src/slug.js::slugify, src/url.js::toSlug"
  ]
}
```

Paths are relative to `--root`, and **the language of the path is not a category**:
`runner_exempt` and `baseline` take Python and JavaScript entries side by side,
because a polyglot repository has one root and the audit that reads this file may be
either binary. `anchor_exempt` is the one exception: it only affects `assay anchors`,
which is Python-only, so a JavaScript-only project never needs an entry there.

**A `baseline` line is the exact text of a `finding`, and only a `finding`.** It is
matched whole, never as a prefix, so the line above is what `assay` printed rather
than a description of it. A `look` cannot be baselined and does not need to be: it
never fails the run, so there is nothing to accept.

**Every table is read in both directions.** An exemption naming a file that no longer
exists is a finding. A property name that does not exist is a finding. A baseline line
that no longer fires is a finding, because someone fixed the problem and left the
record claiming otherwise.

A table read only one way rots into decoration: it accumulates entries, none of them
ever expire, and after a while it lists things somebody once believed rather than
things that are true. The second direction costs about ten lines and is the difference
between a **suppression file** and a **record**.

`reason` is required and not decorative: **an exemption without one cannot be told
from an oversight**, and six months later nobody can say which it was.

Adopting this on an existing project means starting with a backlog. The two dishonest
ways to handle that are a magic threshold (goes stale in silence) and a blanket
suppression (hides the next real one). The `baseline` does neither: a new finding is
not in the list so it fails, and one you fixed no longer fires so its line fails as
stale.

**Staleness needs a complete run, and getting that wrong made the tool cry wolf at
itself.** `assay runners` cannot produce a finding that only `diff` reports, so
checking staleness there flagged every `diff` line as fixed: the audit reporting a
problem with its own config, on a clean tree, on every run. So a line that does not
fire is only called stale by `assay all`, which performs every audit that can produce
one (add `--scan PATH` to fold the sameness half in). Every command still *suppresses*
accepted findings, because that direction is safe from any command: a line that fires
is a line that fires. **Run `assay all` in CI**, not the subcommands separately, or an
accepted finding can be fixed and its record left behind forever.

**Under Node, no command calls a line stale**, and the run says so instead of printing
a zero. `assay anchors` is Python-only, so no JavaScript run performs every audit that
can produce a baseline line, and claiming completeness there would flag every anchor
line as fixed. A polyglot project should point the **Python** `assay all` at the root
for that one job; the JavaScript half still suppresses accepted findings exactly as
the Python half does.

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
and the file's source is gated *before* it is loaded at all: a file that reaches for
the filesystem, the network, the clock, randomness or the process is skipped whole. A
per-function gate then runs over `fn.toString()`, which is real source rather than a
guess, including the **declared parameter list**, because `fn.length` stops counting at
the first default and would pick the ladder for a function of the wrong shape. **The
residue is genuine:** a module with an import-time side effect that
mentions none of the gated names will still be evaluated. If that is unacceptable for
your tree, point the tool at the files you trust rather than at the whole repository.

## Two implementations, one contract

| | Python | JavaScript |
|---|---|---|
| `scan` / `pair` / `search` | yes | yes |
| `runners` | yes | yes, with a weaker `dead-vs-real` (see below) |
| `diff` | yes | yes |
| `anchors` | yes | **no, and the CLI says so** |

`anchors` needs to pull a mutation table out of source, which needs a real parser.
Python has one in its standard library; this package has no dependencies, so the JS half
would need a regex, and **a regex that reports confident nonsense about which strings are
anchors would be worse than the gap**. `assay anchors` under Node exits 2 and points at
the Python package rather than doing something approximate quietly.

The JS `dead-vs-real` detector is textual where Python's reads an AST. The consequence is
one-directional and worth knowing: it will not produce a false FINDING, it will miss a
real one. If your harnesses are Python, run the Python half over them.

`python/tests/test_parity.py` asserts the contract rather than trusting it: same property
names, same verdict names, same config keys, same ladder version, same thresholds. Two
implementations of one contract is exactly the duplication this tool exists to find, so
it is checked.

## Also shipped

**GitHub Action**, one `uses:` line instead of a run block:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }   # `diff` needs a base ref; a shallow clone has none
- uses: Megapixel99/assay-checks@v0.2.2
  with:
    command: all       # `all` is the run that can call a baseline entry stale

# The same action runs the other half. `language` is `python` unless you say otherwise,
# so a JavaScript project has to name it.
- uses: Megapixel99/assay-checks@v0.2.2
  with:
    command: scan
    paths: js/src
    language: node
```

**Docker**, both runtimes, one image, for CI that has neither toolchain:

```bash
docker run --rm -v "$PWD:/work" assay runners
docker run --rm -v "$PWD:/work" --entrypoint assay-js assay scan src
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
- **The six properties are about mutation harnesses.** If your project has none, that
  half has nothing to say about it and says so rather than reporting a pass.
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
python3 python/tests/run_tests.py        # 169 tests, ~21 s
npm test                                 # 160 tests, ~30 s
python3 python/tests/mutations_assay.py  # 84 mutations, both halves
PYTHONPATH=python python3 -m assay scan python/assay   # scanned by its own scanner
PYTHONPATH=python python3 -m assay --root . all --base origin/master
```

No install step, no virtualenv, no `npm install`: both halves are standard library
only, and `PYTHONPATH=python` is the whole of what an install would have done. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the rules this code is built on and what
happens when a mutation comes back `NOT DETECTED`.

The mutation runner carries all six properties `assay runners` audits for, and several
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
