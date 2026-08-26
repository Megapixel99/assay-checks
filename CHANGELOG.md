# Changelog

Versions follow [semantic versioning](https://semver.org/). The parts under version
are the **CLI contract** (subcommand names, flags, the three exit codes), the
**`assay.json` format**, the **verdict vocabulary**, and the **JSON schema** that
`--json` emits — not the set of findings a given release reports, which is expected to
grow.

The JSON schema carries its own number (`"schema": 1`) beside the tool's, because a
consumer parsing that output has the same claim on stability as a script reading the
exit code and the two do not move together.

**A new check is a MINOR bump even though it can turn a passing build red.** That is
the honest reading: a tool whose whole purpose is finding things you had not checked
cannot promise that a patch release finds nothing new. Pin exactly if that matters,
and use the `baseline` in `assay.json` to accept what you have read.

## Unreleased

**A MINOR bump when it lands, and the rule at the top says why:** `why` grows two flags
and `search` reports a case it used to print as a clean result, so a tree green on 0.4.0
may show a new `look`. Nothing is removed and no exit code moves — a `look` has never
failed a run — but two invocations that used to be accepted are now errors, and both
were flags or arguments the tool parsed and ignored. `anchors` moves the other way, and
is the reason this is not a patch either: it stops reporting dead anchors on harnesses
that carry a column after the replacement, so a tree red on 0.4.0 for that reason goes
green without being edited.

### The gate asks two questions, because it guards two events

`fileRefusal` read the whole file, so one `new Date()` in one body refused every
function beside it. It is now `loadRefusal` — *may this module be imported?* — asked of
module-scope code only, paired with a per-function *may this be called?* that follows
what a function **reaches**. On a barrel of ten Handlebars helpers this goes from 0
probed to 6; the two clock helpers are still refused, individually and by name.

**Narrowing the file gate alone would have been unsafe**, and the reason was already
written in `probe.js`: `functionRefusal` reads a function's own source and cannot see
the module scope its free names resolve in. `slugA(s) { return stamp(s) }` mentions
nothing gated, and `stamp` calls `writeFileSync`. So the call gate walks free names —
local bindings transitively, and relative imports into modules that pass the load gate
themselves. Bare specifiers, core modules, unknown globals and doubly-declared names
refuse by name.

**This closes a hole that was open, not merely a coverage limit.** A function calling an
*imported* impure function passed both old gates: the importing file mentions no core
module, so it loaded, and probing called it. The "barrel could launder the gate" fix
covered re-exported functions, never callers of imported ones. On a two-file fixture the
old build wrote a real file to a real absolute path; there is now a test that asserts it
does not.

Refusals are a chain you can walk back to the code — `reaches config, which reaches env,
which touches process` — with every hop kept.

**Coverage moves both ways, and it was measured rather than argued.** On
`@azure/msal-common`: 6 files refused before loading down to 4, 142 functions found up
to 166, 12 probed up to 13. The gains are barrels; the losses are real —
`reaches nowSeconds, which reads the clock` refuses three functions the old build probed
and should not have, because their outcome vectors were never deterministic. On `semver`
every comparison now refuses through a `debug` helper two modules away that reads
`process.env`, which is true and expensive: the env read cannot change the return value.
That is the trade this makes.

Five defects in the analysis were found by running it against real packages rather than
by reading it, and each has a test: callback parameters read as free names, class method
names read as references, regex flags read as identifiers, reached bindings judged by
the probe's own eligibility rules, and — worst — files using ASI or opening with a
`'use strict'` directive finding **no** top-level bindings at all, which silently
refused everything in ordinary CommonJS.

`URL`, `URLSearchParams`, `TextEncoder` and `TextDecoder` join the deterministic
globals. `Buffer` deliberately does not: the allowlist is per name, and
`Buffer.allocUnsafe` hands back whatever was in that memory.

The parity suite now pins the call gate. Both halves resolve a free name through the
module rather than refusing it on sight, both follow a helper and name it when it is
impure, both call an unresolvable name `free name X`, and neither opens a module it
would not have loaded to find out — Python by never importing the containing module and
admitting only an allowlist of stdlib roots, JavaScript by following a relative
specifier only, and only into a module that passes the same load gate.

**One rule is per-language on purpose, and is asserted rather than left to drift.**
Python inlines each helper's source into a preamble it then executes, so it bounds the
walk at `HELPER_DEPTH` and says when it stops; JavaScript reads text and never inlines,
so its walk costs nothing to continue and terminates on a `seen` set instead — which
also makes recursion and mutual recursion ordinary rather than special. Both refuse
rather than guess when they stop, so this is not a contradiction; a tree probed by one
binary and not the other would be.

### The census names what it never looked at

`--json` grows `unloadable_paths` and `skipped_refs` beside the existing tallies. Both
map a name to the reason, both are additive, and the tallies are unchanged — so the
schema number does not move.

The counts could say how much a run never opened and not which. On a real tree that
reads `could not load 12`, and the only recourse the tool offered was
`assay why FILE::NAME` — which has to be told a file and a function name inside it, the
two things the tally had just withheld. A census that measures its own blind spot and
then declines to locate it stops one step short of the claim it exists to make.

The reason travels whole here, and that matters most where the tally is largest. A
tally key stops at the first `(` so that one bucket counts every spelling of a failure,
and a load error's message begins at exactly that `(`: the child already computed
`could not load (JWT_SECRET must be set)`, and aggregation was throwing the diagnosis
away while keeping the count. `sum(unloadable.values()) == len(unloadable_paths)` is
checkable by a consumer, so the two views cannot drift into two different answers about
one run.

Nothing about which files load or which functions are probed changed. This is the same
census, addressable.

### `search` checks its own query, and stops calling `none` what it never looked for

`assay search` matched its query's vector against the census and, on no hit, printed the
clean result:

```
same   none — nothing in the tree matched <ref>'s outcome vector
       which is not proof that nothing answers it; see Limits
```

For a **query the ladder cannot discriminate** — a constant, a projection, or a vector
that raised on every rung — that line was never true. `collect` files exactly those
functions under *not probed*, so a constant query can only fail to find the other
constants: the match was never possible and the tree was never really searched. No false
positive was ever possible either, which is why this was a reporting defect rather than
a wrong answer, and it landed on the **highest-traffic path**. `--stdin` is *search
before you generate*, so the person reading that line is about to write the function.

`search` now applies the same `discrimination_detail` check `why` does, and reports a
non-discriminating query as a `look` with the reason the census cannot give:

```
       the tree was not searched: the census excludes every function this ladder cannot tell apart, so a match was never possible
  look     <stdin>::k — not discriminated by the ladder
           1 distinct returned value across the 31 rungs that answered, and 2 is the minimum — as far as this ladder can see it is a constant
```

**ONE DECIDER, not two that agree by hand.** The `look` is written in one place per half
and both commands go through it, because the defect being fixed *was* the two of them
answering one question differently — and a sentence kept in step by hand is how they get
back there. Exit codes are unchanged: a `look` never fails a run, and a query the ladder
*can* discriminate still gets the ordinary `same none`.

### `assay why --stdin`, for symmetry

`why` takes a snippet on stdin, with `--name` picking one definition out of several,
exactly as `search` does. It is the same question asked one step earlier, and answering
it only for code already on disk meant writing the file first in order to be told the
file was never the problem. Both commands now resolve their query through one place, so
`--name` without `--stdin`, `--stdin` with a `FILE::NAME`, and a second reference are
errors in both halves and for both commands rather than in some of the four.

Two consequences worth naming: `search` inherits `why`'s three-way resolution failure —
no such file, a file that does not parse, a file with no such function, instead of one
`cannot resolve` that sends you to none of them — and `assay why` with no argument now
says `why needs a FILE::NAME or --stdin`.

### `assay anchors` stopped calling a harness's metadata a dead anchor

`anchors` reads a mutation table and checks that every anchor matches its target
exactly once, and it found the anchor at `parts[-2]` — the second-to-last string in the
entry. That is right whenever the last column is the REPLACEMENT, which covers both
documented shapes, `(label, old, new)` and `(label, target, old, new)`. It is wrong for
every table carrying something *after* it:

```
(label, old, new, expected_test)      names the check that must go red
(label, target, old, new, section)    names where to run it
```

Those shapes exist for the reason this package exists: so that *something failed* and
*the check that covers this failed* stay different claims. On them `parts[-2]` lands on
the replacement, which matches nothing by construction — so **the most careful
harnesses in a tree were the ones reported as broken**, every entry a dead anchor, on a
table that was perfectly healthy.

Measured on a real tree: **79 findings on a repository with none** — 6 harnesses, 74
entries. The same tree now reports 13, and all but one of those are three further
mechanisms that carry no text anchor at all — regex substitution, function replacement,
a table of callables — which are `anchor_exempt` questions rather than extraction ones.

Trailing metadata is now dropped before counting back, rather than each shape being
enumerated: a metadata column is one bare word and a replacement is code, and that
distinction does not need to know how many columns precede it. **The strip stops at
three columns**, which is what makes it safe — `("label", code, "pass")` is an ordinary
three-column mutation whose replacement happens to be a bare word, and stripping there
would put the anchor on the label, trading a false finding on one shape for a false
finding on another. One such entry exists across the 34 harnesses measured.

**This moves what `assay anchors` reports, in the direction of reporting less.** A tree
that was red on 0.4.0 for this reason goes green, and no `anchor_exempt` entry written
to silence it is needed any more — though one left in place stays harmless, and the
stale-exemption check does not fire on it. Nothing about the CLI contract, `assay.json`,
the verdict vocabulary or the JSON schema moves. An audit that fires on correct code is
one that gets switched off, which is why this is a fix rather than a tuning.

## 0.4.0

**A MINOR bump, and the rule at the top says why:** the purity gate now refuses files
it used to load, so a tree that was green on 0.3.0 may report new `look`s — and a
project whose census counted certain functions as probed will find them counted as
declined instead. Nothing about the CLI contract, `assay.json`, the verdict vocabulary
or the JSON schema moves.

### A barrel could launder the gate its own file failed

`config.js` imports `node:fs`, so the gate refuses it and `writeBaseline` is never
probed there. `index.js` re-exports `writeBaseline` and imports no core module of its
own — so it passed the same gate, and loading it handed the probe the very function the
gate had just refused. `functionRefusal` could not catch it either: that gate looks for
**import statements**, and a function body never contains one. `writeFileSync` is a
free name resolved in a module scope the gate cannot see.

What stood in the way was the de-duplication skip in `exportedFunctions`, which exists
to name each function once and had no idea it was also the last thing between the probe
and a real `writeFileSync` on a real path. Two mutations remove that skip, and the
probe wrote **ten files named after the ladder's string rungs into the repository
root** — which CI then reported as `a mutation was left applied — the restore did not
run`, naming the wrong cause for a real failure.

The defining file's refusal now travels **with** the function. A function reached
through a barrel is skipped by name, with the origin's reason, rather than silently
dropped — so the census says what it declined to run instead of saying nothing.

### `await import('node:fs')` was not an import

The same gate refused `require('node:fs')` and `from 'node:fs'` and allowed the dynamic
form, so a file could reach the filesystem through the one spelling nobody had written
down — no barrel required. The Python half has always banned `__import__` by name; this
is the two halves agreeing again rather than a new rule.

### The probe no longer runs in your repository

Every gate here is best-effort, so the question is not only what gets refused but where
the damage lands when something is not. The child resolves every path it uses
absolutely and needs no particular working directory, so it is given a scratch one. A
probed function calling `writeFileSync('a', ...)` can no longer reach the tree it was
pointed at.

### The suites got about five times faster

`run_tests.py` runs one process per `TestCase` class. The suite is almost entirely
waiting — a probe is a child process per function — so the cores sat idle through all
of it: **25.4s serial against 4.9s in parallel**. The output contract is unchanged,
because `mutations_assay.py` reads this suite's stdout to decide whether it RAN.

The mutation runner is also line-buffered now. Python switches to an 8KB block buffer
the moment stdout is not a terminal, so a measured CI run printed **nothing for its
first 15m49s**, then 8190 bytes at once. A job that shows no output for a quarter of an
hour cannot be told from one that never started, which is the conflation this whole
package is about. The full table now runs in about 28 minutes, against 93 before.

## 0.3.1 (unreleased, folded into 0.4.0)

**A PATCH bump, and the rule at the top says why:** nothing here touches the CLI
contract, the `assay.json` format, the verdict vocabulary or the JSON schema, and no
new check is added. A tree green on 0.3.0 is green on 0.3.1, faster.

### Probing no longer imports `asyncio` to find out it did not need it

One probe is one child process per function, and that child imported `assay.sameness`,
which imported `asyncio` at module scope — **85ms of the 190ms a spawn cost**, paid by
every function to serve the small minority that are coroutines. Both call sites were
already behind `inspect.iscoroutine`, so the import moved inside the branch that awaits.
A scan's probing is about **35% faster per function**, which is most of what a scan is;
the package's own Python suite went from 39s to 25s on the same machine, and the
mutation job from about ninety minutes to about sixty.

Nothing about what a probe answers changed. `asyncio` remains in the purity gate's
refusal list, which is a string of module names and was never this import.

### The JavaScript probe takes the per-input budget from its caller

`probeFile` gained an optional final `perInput`, and the request it writes to the child
carries it. The Python worker has always received `per_input` this way; the JavaScript
child read the constant from its own copy of the module instead, so a caller that
shortened the budget shortened it only for itself. Additive — a request without the
field gets the same `PER_INPUT_MS` the child would have read anyway.

### The mutation runner drops cached bytecode

A `.pyc` is judged valid by source **size** plus mtime **seconds**, so a same-length
mutation — `MIN_DISTINCT = 2` -> `MIN_DISTINCT = 1` is one, and it is in the table —
restores to an identical size within the same second, CPython's cache check passes it,
and the **next** run executes bytecode compiled from the mutated file. It fails on a
line that exists in no source file on disk, which reads like a defect in the tool rather
than an instrument fault.

The suites now run with `PYTHONDONTWRITEBYTECODE=1`, and `__pycache__` beside the
mutated package is dropped before the baseline, before each mutation and inside every
restore — which every restore path already goes through, including the SIGTERM handler
and the outer `finally`. An eighth property this runner carries, beside the seven
`assay runners` audits for.

### Three tests that were waiting rather than testing

The slowest test in each half was paying a timeout in full to assert something the
timeout's *length* was no part of: a non-terminating Python function burned eight
one-second alarms, and a never-settling JavaScript rung burned thirty-one 250ms ones.
Both now set a shorter budget and ask the same question, and the two synchronous
spinners bounded by the wall clock dropped from 2500ms to 1000ms — still five times
what the child needs to boot, load and answer. The JavaScript suite's `sameness` file
went from 17s to 8s.

## 0.3.0

**A MINOR bump, and the rule says why:** a new check is a minor bump even though it can
turn a passing build red. This release adds a seventh runner property, an `anchors`
implementation for the JavaScript half, and three commands, so a tree that was green on
0.2.2 may not be on 0.3.0. Pin exactly if that matters, and `assay accept` is the
shortest route through the backlog.

**Two contract changes to read before upgrading.** A `baseline` entry may now be an
object, and the old bare string is still legal, so no config has to move. The `--json`
payload's `baseline` object drops `complete`/`incomplete_because` for `performed` and
`unchecked` — `--json` has not been in a release, so nothing published ever carried the
older shape.

### `assay cross`: a Python function against a JavaScript one

A validator reimplemented in a Django backend and a Node frontend is the highest-value
duplication a polyglot repository has, and it is exactly what nobody writes a
differential test for — because writing one means agreeing, by hand, on what `False` and
`false` have in common.

```bash
assay cross src/api.py::shout src/ui.mjs::yell --with assay-js

assay probe src/ui.mjs::yell > yell.json     # or: one half writes a record,
assay cross src/api.py::shout yell.json      # the other reads it
```

**One ladder, not two that resemble each other.** `BASE_VALUES` is a hand-written list
per language, and the strongest thing that could be said about the pair was that they
cover the same *shapes* — the languages have different primitives, so comparing lengths
would fail for a correct reason. Enough for two Python functions; nothing like enough
here, where two lists meant to hold the same values that quietly stopped is the entire
hazard. The cross ladder is **one JSON document** carried verbatim by both halves;
`test_parity.py` compares the two texts, and the ladder key carries a **digest of the
rungs**, so a comparison across a changed ladder is refused by the branch that already
refuses a mismatched arity.

**One vocabulary for outcomes.** Every value renders as canonical JSON. The three lossy
mappings are choices about which mistake to make: an integral float renders as an integer
(JavaScript has one number type), `undefined` and `null` are one absence (Python has one
and JavaScript has two), and a Python `tuple` renders as an array. Anything JSON cannot
hold — bytes, a `Map`, a `Date`, a class instance — is refused rather than approximated,
and one such outcome makes the whole comparison a `look`. `NaN` and the infinities are
spelled out, because `JSON.stringify` turns all three into `null`.

**A raise carries no name.** The two error taxonomies genuinely diverge — `d['x']` is a
`KeyError` in Python and `undefined` in JavaScript — so comparing names would make every
honest pair `differs`, and declaring them equal is worse, because `same` is the verdict
that *fails*. Every raise renders as one token, which is the whole of how a rung where
**both** sides raised gets masked: two of them can never be a witness, and the vacuity
guard counts only returned values so two of them can never be evidence either. A rung
where **one** raised and the other answered stays a witness, and it is the most
interesting kind there is.

The first version of that masking was a branch in the comparison loop with a comment
explaining what it did — and a mutation removing it changed nothing, because two raises
already render alike. The guard and its absence produced the same observable, which is
precisely the failure this package exists to report, so the branch is gone and the
parity test pins the rendering it restated.

**The two halves do not invoke each other.** Neither package can assume the other is
installed, and a command that shells out to a binary that may not exist fails in a way
that reads like the code being wrong. `assay probe` writes a record and `assay cross`
reads one; `--with CMD` runs that first step when both are present. Two references in the
same language are a `look` pointing at `pair`, which compares them on their own
language's fuller ladder.

`assay probe` writes JSON on stdout with its keys sorted in both halves, and carries an
`assay_probe` schema number checked on the way in: comparing a new answer against the
wrong earlier answer is precisely the defect a difference checker exists to catch.

### A baseline entry can carry a `reason`, and the command that fires it

`runner_exempt` requires a `reason` because **an exemption without one cannot be told
from an oversight**. `baseline` was a bare list of strings and got no such treatment,
though it is the table that accumulates fastest and rots first: a fixed finding leaves
its line behind in silence.

An entry is now the finding's exact text **or** an object carrying it as `line`:

```json
{"line": "same answer (arity1/v3): src/slug.js::slugify, src/url.js::toSlug",
 "reason": "one is the URL path form; merging them needs the router change first",
 "from": "scan"}
```

The bare string stays legal, and that is not politeness about old configs: adopting this
means pasting lines out of a run, and a format that refuses the paste is a format nobody
adopts. In the object form `reason` is required, on the same terms an exemption's is.

**`from` makes staleness a property of the line rather than of the run.** Naming a
command that cannot produce a finding is a hard error rather than a line nobody can ever
check — the same both-directions rule every other table here follows.

### `assay accept`: a command that cannot baseline a `look`

```bash
assay accept --reason "one is the URL path form; merging needs the router change"
assay accept "same answer (arity1/v3): src/slug.js::slugify, src/url.js::toSlug" --reason "..."
```

With no line it takes every new finding; with one it takes that one. It fills in `from`
from the audit that actually produced the line, so the check that fires it is the one
that can later call it stale, and `--reason` is required.

**It refuses a `look`.** A look never fails the run, so a baselined one could never be
suppressed and never expire — a record of nothing, indistinguishable from a record of
something already fixed. The 0.2.2 changelog records shipping a config example that
baselined a look; it was corrected by editing the example, and an example is corrected
once per copy of it.

**It refuses a line nothing printed**, because an entry that does not fire is stale the
moment it lands. Nothing is typed by hand either: the entry is the finding's exact text,
taken from the run, which is what makes whole-line matching safe. Other keys in the file
and existing bare-string entries are left exactly as they were.

`all` and `accept` share one definition of what a complete run is. Two lists that had to
agree about what "every audit" means would be the duplication this package exists to
find, and they would disagree in silence: `accept` would tag a line with a command `all`
no longer performs, and that line could then never be called stale.

### Per-line baseline staleness

Staleness used to need `assay all`, because `assay runners` cannot produce a finding
that only `diff` reports and calling one stale from a partial run flagged every other
command's lines as fixed — the audit reporting a problem with its own config, on a clean
tree, on every run. The fix was a whole-run flag: correct, and blunt enough to be its own
problem. Every line in every other command went unchecked, and the run printed a
disclaimer where a number belongs.

A line that names the command firing it can be answered by that command alone. Each entry
now lands in exactly one of three places:

```
BASELINE assay.json — 3 accepted, 0 new, 1 stale, 2 NOT checked for staleness
                      (anchors: 1; no `from`, so it needs `assay all`: 1)
```

*Stale* is a line this run could have seen fire and did not. *Not checked* is one it
could not have seen at all — **counted rather than folded into the stale number**,
because `0 stale` from a run that never looked reads as "nothing is stale" and those are
different claims. An untagged line keeps the old rule.

**A defect this made visible: `assay all` without `--scan` claimed to be complete.** The
docstring said the completeness flag tracked whether a scan had run; the code passed
`complete=True` either way, so a `same answer` line in the baseline was called stale by a
run that never scanned anything, on a clean tree. `scan` now joins the performed set only
when a scan actually ran, and **`assay all --scan PATH` is the complete run**.

### `assay anchors` runs under Node, by IMPORT rather than by parse

It used to exit 2 and point at PyPI, and the reason was sound: pulling a mutation table
out of source needs a real parser, JavaScript has none in its standard library, this
package has no dependencies, and **a regex reporting confident nonsense about which
strings are anchors would be worse than the gap**.

The gap closes from the other side. The JavaScript half already loads modules, so a
table that is **exported** is readable as *data*:

```javascript
export const MUTATIONS = [
  ['the negative guard stops firing', "if (x < 0) throw new RangeError('x');", 'if (false) {}'],
];
```

A property access. No parser, no dependency, no approximation anywhere in the path. The
rule is the same one the Python half enforces and `test_parity.py` pins it: the anchor is
the **second-to-last string**, which follows from `replace(old, new)` rather than from a
convention about column order, and both halves bound the readable shapes identically so
an entry one offers as unreadable is not silently guessed at by the other.

**The cost is stated rather than hidden.** The harness gets imported, so guard `main()`
behind the entry-point check every program in this package already carries — a harness
that does work at import time will do that work, in a child process that cannot reach
your session but on the real tree. In exchange a **computed** anchor is simply a string
here, where the Python half can only report it as a shape it cannot read. A harness that
exports no table is a `look`, never a finding.

**Every harness leaves the corpus, in either language.** `find_runners` answers which
harnesses a half can *read*; what has to leave the corpus is *all* of them. A polyglot
repository has a `mutations-x.js` beside a `mutations_a.py`, and a JavaScript harness
left in the Python corpus is a file full of anchor strings for that audit to match its
own anchors against — a confident finding about a file the harness has nothing to do
with. Reading and excluding are two different questions, and answering both with one
walk was the mistake.

**Under Node, `assay all` can now call a baseline line stale.** No JavaScript run used
to perform every audit able to produce one, so the half said so instead of printing a
`0 stale` that reads as "nothing is stale". It performs them all now.

### `assay why FILE::NAME`: the census, for one name

The census prints refusal reasons with counts, which is the right shape for a tree and
the wrong shape for a question. Somebody who expected a particular function to be probed
cannot read `no arguments 274` and learn whether theirs is one of the 274, and guessing
which of eight gates rejected it is the work the census was supposed to save them.

`why` prints the gate that refused **this** function, or says it was probed and on which
ladder. It never produces a finding — it reports what the tool did and decides nothing —
so a refusal is a `look` and a probe is an `ok`, printed rather than left silent for the
reason every other `ok` is.

**It splits the one reason the census cannot split.** `not discriminated by the ladder`
covers three different situations: a **constant**, a **projection**, and a vector that
raised on every rung. They need a wider ladder, a different function, and inputs of
another shape, and the census sends all three to the same place. The explanation is
**deduced** rather than re-decided: `discrimination_detail` defers to `discriminating`
and then says which branch refused, because a second decider for one question is two
answers that can disagree.

**A `look` now prints its detail**, exactly as a finding does — that is where `why` puts
its whole answer, and dropping it answered half the question.

**Three answers where `resolve` had one.** No such file, a file that does not parse, and
a file with no such function send you to three different places; `cannot resolve` sends
you to none of them. On the JavaScript half a name that is not exported says so, with
the reason: a module's functions arrive through its exports, and finding an unexported
declaration would mean reading source with a regex.

On the JavaScript half the answer is often at the **file** level. A file that reaches for
the clock is refused whole, so none of its functions were ever looked at — reporting a
per-function reason for a file nobody opened would be a reason invented after the fact.

### A seventh runner property: `restore-verified`

`restore-in-finally` proves the restore **path executes**. It does not prove the tree
came back. A harness that restores from a buffer it read *after* mutating, that writes
the text back in a different encoding, or that saved one of the two files it touches,
satisfies all six of the other properties and still leaves the working tree wrong —
and every suite after that one scores code nobody wrote, at a tally that reads exactly
like a clean run.

Hashing before and comparing after is the check. The detector wants **both halves**:
a digest nothing compares is arithmetic, and a message nothing computes is a string,
so it looks for a digest *and* a named failure for the case where the two disagree.
The tells live in one list per half and `test_parity.py` pins them equal, because this
is the one property whose two detectors read different files — a `.py` harness is
audited by the Python half and a `.js` one by the JavaScript half — and a tell in one
list and not the other means a correct harness passes in one language and is a finding
in the other.

`python/tests/mutations_assay.py` now carries the property it audits for: it digests
the **bytes** of every file it will touch before writing anything and compares them
after the last restore, and a mismatch exits 2 whatever the mutation score was. The
digest is over bytes rather than over decoded text on purpose — hashing the string
would agree with itself after a restore that wrote the file back in a different
encoding, which is one of the three ways a restore runs and still leaves the tree
wrong.
### `--json`: the same Report, in the shape a machine can read

Every subcommand takes `--json`, on either side of the subcommand name like every other
global flag, and emits one object instead of the prose report. The renderer was already
the only thing that printed and every command already built a `Report` as data, so this
is a second emitter over a structure that existed rather than a rewrite.

**One shape, always.** A run that could not start emits the same keys as one that
finished, with `error` set and `items` empty. Prose on the failure path and JSON
everywhere else hands a consumer a parse error at exactly the moment the tool could not
run, and a sloppy consumer reads a parse error as *no findings* — which is the failure
this package exists to report, arriving in its own output. Every exit-2 site routes
through one helper.

**`look` gets no severity.** Mapping the three verdicts onto somebody else's
error/warning/note is the collapse the verdict vocabulary exists to prevent. The verdict
travels by its own name and the consumer decides what it means.

**The census is data, not the printed equation.** `probed + not_probed == functions` is
checkable by the consumer rather than by parsing our own prose back out of `notes`, and
files stay a separate population from functions. A command that ran no scan emits `null`
rather than `0`, because zero probed functions and no sameness half at all are different
claims.

**The baseline's caveat travels as data.** `performed` says what this run audited and
`unchecked` names every entry it could not have seen fire, rather than an empty `stale`
list that reads as *checked, found none*. (This shipped with a `complete` boolean and an
`incomplete_because` string; both are gone in the same unreleased cycle, because
completeness stopped being a property of the run — see *Per-line baseline staleness*
below. `schema` stays at 1: version 1 has never been released, so there is nothing for a
consumer to have pinned.)

**Keys are sorted all the way down, in both halves**, so one contract prints as one
document rather than two: `JSON.stringify` emits insertion order and `json.dump` is
asked to sort, and the Python half emits UTF-8 rather than `\uXXXX` escapes for the
same reason.

Incidentally, the JavaScript version literal moves into one `VERSION` constant, and the
parity test that keeps every version site in step reads that rather than the printed
string.

### `assay search --stdin`: ask about a function before it is a file

`search` took a `FILE::NAME`, which names something that already exists — so the
command sold as **search before you generate** required you to write the file first,
which is the thing you were trying to find out whether to write. `--stdin` takes the
function on its way to being written.

What arrives is a **snippet parsed as a module**, not a bare function. A function alone
cannot carry what it needs: free names resolve from the file's own constants, its other
gated functions and the stdlib allowlist, and a bare `def` has none of those. So the
snippet may hold its imports and helpers, exactly as the file it is about to become
will.

**Which function is never guessed.** One definition is unambiguous; several without
`--name` is a refusal rather than a default, because picking one would make the tool
answer about code nobody asked about — and that reads exactly like an answer about the
code you did ask about.

`--name` without `--stdin` is an **error**, not a silently ignored flag. A flag that is
accepted, documented and inert is the shape of the `-q` defect this CLI already carries
a docstring about.

Two limits, both in the README: a snippet may not import from the tree, and a
JavaScript snippet that exports nothing needs `--name`. The second is a real difference
between the halves rather than an oversight — a module's functions reach the probe
through its exports, and finding an unexported declaration would mean reading source
with a regex, which is the thing `anchors` declines to do.

## 0.2.2

Documentation only. No behaviour changed: with docstrings stripped, every shipped
source file is identical to `0.2.1`, and the sole change inside the wheel is the
`assay.json` example in `config.py`'s module docstring. Baselines, ladder keys and
exit codes are all untouched, so an upgrade from `0.2.1` needs nothing.

It is a release rather than a merge because **the README is the package page on both
registries**, and both were serving the older text.

**The `config.py` example baselined a `look`.** It read `src/thing.py has NO mutation
runner naming it`, which `assay diff` reports as a `look` rather than a finding. A look
never fails a run, so there is nothing to accept and that line could never have matched
anything. The README's copy of the same mistake was corrected earlier; this was the
second copy, and two copies of one example that disagree is the thing this package
argues against everywhere else.

**Both halves now appear in every example the README gives.** The three-command block
showed Python references only, and the GitHub Action block never mentioned `language`,
which defaults to `python` and is therefore the one input a JavaScript project has to
set. A reader arriving from npm could follow the whole file and not learn the Action
ran their half at all.

**The prose is rewritten to the voice guide.** Em dashes fall from 12.58 per 1,000
words of prose to zero. The dashes that remain are inside code fences, quoted from
`verdicts.py`, `sameness.js` and `cli.js`, because editing them would misquote the tool
in its own README.

## 0.2.1

**The installed `assay` command did nothing and exited 0.** `npm` puts a `bin` on the
path as a SYMLINK — `node_modules/.bin/assay` pointing at
`node_modules/assay-checks/js/src/cli.js` — so `process.argv[1]` is the link while
`import.meta.url` is its target. The check for "was I run as a program" compared the two
with `path.resolve`, which makes a path absolute and leaves symlinks alone, so it never
matched: the CLI printed nothing, ran nothing, and exited **0** — the code that means
*the tool ran and there is nothing to read*. A published auditing tool reported a clean
tree by never having run, which is the exact failure this package exists to find.

It affects **0.1.0 and 0.2.0**, on every install where the command is reached through
`npx assay`, `node_modules/.bin/assay`, or a global install. Running the file by path —
`node node_modules/assay-checks/js/src/cli.js` — was never affected, which is why the
repository's own suite and CI never saw it: both invoke it by path.

Both sides are now realpath'd, which also drops a hand-built `file://` URL that mangled
any directory containing a space or a `#`. The test creates the symlink itself rather
than relying on the platform having one — the same lesson the symlink guard in
`changed_files` learned — and asserts both that the linked command prints and that a
run with findings still exits 1, since exiting 0 in silence was the whole defect.

Python was never affected: its console script calls `main()` directly and never
compares `argv[0]` to anything.

## 0.2.0

A MINOR bump by the contract at the top of this file, and it earns it twice over: the
ladder key changed, and `async` functions are probed where they used to be refused. Both
can turn a build red that was green on `0.1.0` — the first by invalidating baseline
lines, the second by finding duplication it could not previously reach. Neither is a
break in the CLI contract, the `assay.json` format or the verdict vocabulary, which are
the parts the version is about.

### ⚠ The ladder changed: `LADDER_VERSION` is now `v3`

**Every `same answer` line in an existing `assay.json` baseline stops matching**, because
the ladder key is part of the finding text. Re-run `assay all`, read the findings again,
and accept the ones you accept. Vectors from `v2` and `v3` are never compared — that is
what the key is for — so nothing silently gets the wrong answer; the lines simply have
to be re-accepted.

**An `async` function is probed on the value it settles on.** It used to be refused
outright: 73 refusals on the first real tree, 34 of them in `services/` and 24 in
`controllers/`, which put a modern Node service layer permanently out of reach. What
made `async` a refusal was reading the promise object instead of the value it resolves
to, so `async function f(x) { return x * 2 }` was unprobeable while
`function h(x) { return Promise.resolve(x * 2) }` scored `E:AsyncResult` on every rung —
two functions that answer the same question, one never probed and the other never
comparable to anything. Both are now compared with the plain `function g(x) { return x
* 2 }` beside them, and all three group. A rejection is the same outcome as a throw, by
type and never by message.

The Python half had the same gap and a worse symptom: `ast.AsyncFunctionDef` is not a
subclass of `ast.FunctionDef`, so an `async def` was not refused, it was **never seen**.
It appeared in no count at all — not probed, not skipped, not in the census — and a file
of `async def` reported zero of everything, which reads as a clean sweep.

`async for` and `async with` are still refused, because both drive an object's protocol
methods and the ladder cannot supply one. The two halves diverge in mechanism and not in
verdict: `asyncio.run` is callable from synchronous code, so Python needs one entry
point, while JavaScript has no synchronous await and so keeps a separate `probeOutcome`
for probing — the sync `outcomeOf` stays for the projection vectors, which the module
generates itself and which can never be promises.

**Probing no longer waits for the event loop to drain**, and that was the larger half
of what it cost. Node keeps a process alive while any handle is open, and the handles
belong to the code under test: a module that opens a pool, a socket or an interval AT
IMPORT TIME keeps the probe child alive long after its last answer is written, so every
such file paid the full twenty-second wall timeout for work that finished in a fraction
of a second — measured at seventeen and a half minutes over one directory of
controllers. The child now exits when it has answered. **This was never an async
problem**: a file of ordinary synchronous functions pays it too, as long as its module
opened something on the way in, and it did so on `v2` exactly as on `v3`.

**An awaited rung is bounded by a timer racing the promise**, and it becomes
`E:TimeoutError` — the same outcome, by the same name, that the Python half's per-input
`SIGALRM` produces. The claim that there was no interrupt to deliver from inside the
process was wrong: it is true of a synchronous loop, which never yields, and false of a
pending promise, where the event loop is free. A synchronous hang is still the wall
clock's and still a `look`, because there really is nothing to interrupt it with. The
bound is 250ms rather than the Python half's second, because this half spends one child
on a whole FILE while Python spends one on a single function — and it is safe to make it
that small because it can only ever fire on a promise, never on a computation.

**The mutation runner survives a suite that hangs rather than one that fails.** A
mutation can wedge `node --test`, which carries no timeout of its own; letting the
subprocess timeout propagate ended the whole run and lost every mutation after it.
A hung suite is now a DID-NOT-RUN, which is how every other absence of evidence here is
reported, and never a detection.

**This widens what gets executed**, and the README says so in Limits. A service function
that awaits a database is a function this tool will now call. Loading a module already
ran its top-level code, so the hazard is not new — but there is more of it.

**The JavaScript half chose the ladder by `fn.length`, and reported a wrong finding
for it.** `fn.length` stops counting at the first parameter with a default, so
`withDefault(a, b = 10)` came back as arity 1: probed on the one-argument ladder,
never handed a second argument, and reported as answering the same question as a
genuinely one-argument `plainOne` — `withDefault(1, 2)` is `3`, `plainOne(1)` is `11`.
That is the worst category this package has, a finding a reader must dismiss, and it
was a parity break as well: the Python half reads the declared list off the AST, probes
at 2, and the first rung separates them. Arity now comes from the declared parameter
list in `fn.toString()`, which the per-function gates already parse textually — with
commas inside defaults, destructured parameters and bare-identifier arrows all counted
correctly, and a list that cannot be read REFUSED rather than fallen back to
`fn.length`, because a fallback restores the wrong answer exactly where the parser
found it hardest. The parsed count is checked against `fn.length` as a lower bound,
since `fn.length` can never exceed the declared count.

**One non-terminating function cost the whole file.** Synchronous JavaScript has no
per-input interrupt, so the probe is bounded by a wall clock and a SIGKILL — and a
child that answered once at the end lost everything it had already computed when that
fired. A file with one `while (true)` and one perfectly probeable function reported
`1 files, 1 not loaded / probe failed` and nothing about the function that was fine.
The child now writes one NDJSON line per function to fd 3 as each completes, after a
roster line naming what it will attempt. A kill costs the function that hung and, after
it, the ones never started — reported separately, because "it hung here" and "we never
got to it" are different facts. Everything already answered keeps its vector. A
trailing partial line is dropped rather than repaired: parsing half an object would be
inventing an answer.

The README's Limits section claimed a timeout is an outcome rather than a `look`,
unqualified. That is true of Python, which has `SIGALRM` per input, and was never true
of JavaScript. It now says so per half.

- Test fixtures declare `"type": "module"`, so the JavaScript suites pass on Node
  18 as `engines` claims. A `.js` file containing `export` with no `package.json`
  beside it is a SyntaxError on Node 18 and loads fine on Node 22 — the fixture was
  the unrealistic thing, since a real project declares its type. The version
  difference is now stated in the README's limits, because it changes what the
  census reports rather than producing a wrong answer.
- The symlink guard in `changed_files` has a test that **creates** the symlink
  rather than relying on the platform's temp directory having one. It was exercised
  by accident on macOS and untested on Linux, where the mutation came back NOT
  DETECTED.

- `assay diff` no longer reports a **deleted** file as needing a check. A commit
  that removes a directory used to produce one `look` per file, all of them advice
  about code that is gone. Found by a repository converting a subdirectory into a
  submodule: the diff lists every file as deleted, and the audit had an opinion
  about each one.

Six defects in the JavaScript half, all found by pointing `assay scan` at a real
project for the first time. Five of them made the tool report or refuse the wrong
thing quietly; none changed the CLI contract, the config format or the verdict names.

**Findings it should never have made.** A CommonJS module whose export is a function
arrives through the ESM bridge under two keys, `default` and `module.exports`, pointing
at one object — reported as a pair, so every `module.exports = fn` file duplicated
itself: eleven of fourteen findings on the first tree it was run against. A barrel
module re-exporting its helpers was the same mistake one scope out. Both are now
rejected by identity, which leaves a function genuinely copied into two files reported
as the two implementations it is.

**A whole directory it never opened.** The probe child wrote its answer to stdout,
which it shared with whatever the loaded module printed at import time. A `dotenv`
banner in front of the JSON broke the parse and replaced a diagnosis the child had
already computed — `could not load (JWT_SECRET must be set...)` — with `probe failed
(silent)`: 58 of 119 skips in one directory. The answer now travels on fd 3, and a
failure quotes what the child actually said.

**A census that did not add up.** `probed + not probed` never equalled `functions`,
because refused FILES were counted among the skipped functions. Files and functions
are now two populations with two counts, and the function line is an equation. The
Python half had the mirror defect: a file that did not parse was dropped before
`files` was incremented and appeared in no number at all.

**Gates that read prose.** The purity patterns are regexes and matched inside comments
and property names: the English word "this" in a comment refused a plain function as a
method, and `perms.global.includes(...)` refused an entire file as touching the global
object. Comments and string bodies are now blanked before matching — except for module
specifiers, whose subject IS a string literal, and with any file the scanner cannot lex
keeping its refusal rather than being cleared by a guess.

**A vacuity guard with a gap.** `is_projection` rejected a function that returns one of
its arguments but not one that merely copies it, so two unrelated object transforms
whose vocabulary the ladder lacks both degraded to a shallow copy and were reported as
the same function. Both halves now reject the copy alongside the identity.

**The mutation runner reaches the JavaScript half.** It could mutate Python only,
and the gap did not show in its score: it printed a full tally while every guard in
`js/src` had nothing breaking it on purpose. A tally over the half you can reach reads
exactly like a tally over the whole thing, which is the defect this package exists to
report, so it was pointed at itself. A mutation names a file, the suffix says which
half, and that half's suite is the one that has to go red — each half bringing its own
four answers: where its sources are, how to run its suite, how to tell the suite RAN,
and how to read a failure out of what it printed. Twelve JavaScript mutations now
cover the six defects the first real project found, plus the vacuity guards, the
ladder-key check, the config validation and the baseline's cry-wolf rule.

The `parses-mutant` property holds on the new half too: a `.js` mutant is checked with
`node --check` **where it lives**, because Node reads module format from the nearest
`package.json` and a check fed the text from anywhere else calls every valid mutant a
syntax error — scoring the weakest possible mutation as the strongest possible catch.

**A dead mutation anchor is a finding, not a footnote.** `assay anchors` counted an
anchor that matches nothing and then reported `ok`, so the failure its own docstring
names — the code moved out from under the anchor, leaving a guard nobody is testing
inside a suite that still passes — was the one thing it would not fail on. The reason
was real: the parser could not tell a label from an anchor, so failing on zero matches
would have failed on every label. It reads the anchor precisely now — the
second-to-last string in an entry, which follows from `replace(old, new)` rather than
from a guess about column order — and the count fell from 118 anchors with 60
unmatched to 73 anchors with none. An entry carrying more strings than either
documented shape is a `look`: a wrong conviction about a table this audit has never
seen is worse than saying it could not tell.

**Both halves now call the same extensions source.** `assay diff` under Node audited
`.mjs` and `.cjs`; under Python it did not, so one commit produced two different file
lists depending on which binary CI invoked — and a file missing from the list is not a
finding, it is silence. `.js` was in the Python list all along, so auditing JavaScript
was never the disagreement, only which JavaScript. The Python half widened rather than
the JavaScript half narrowing, and `test_parity.py` now pins the two sets against each
other. The empty-run note reads `no source files changed` on both sides instead of
naming a list that was wrong on one of them.

**The Python half moved into `python/`, beside `js/`.** Two halves of one tool that
were laid out two different ways — `assay/` with `tests/` at the root, against `js/src`
with `js/test` — made the repository harder to read than the code in it. `python/assay`
now sits next to `js/src` and `python/tests` next to `js/test`.

**The import name did not move.** `import assay`, `python3 -m assay` and the `assay`
console script are unchanged: `pyproject.toml` bridges the directory to the package
with `package-dir`, so an installed wheel still puts `assay` at the top level. The
folder name is about reading the repository; the import name is a published interface
and renaming it would have broken every caller to make a directory tidier. Working
from a checkout, `PYTHONPATH=python` is what an install would have done.

**Both registries now have an exclude list.** `.npmignore` and `MANIFEST.in` keep each
half's distribution to its own half. Two traps are documented in the files themselves:
adding a `.npmignore` REPLACES npm's `.gitignore` fallback, so everything that file was
keeping out has to be restated or it silently starts shipping; and `packages` governs
only the wheel, leaving the sdist to sweep up whatever sits beside the package. Both
are checked rather than trusted — `npm pack --dry-run` and `twine check --strict` run
in the release workflow before anything is published.

**The `assay.json` example in the README shows both languages**, since one file serves
a polyglot root, and its `baseline` lines are now real `finding` text. The previous
example baselined a `look`, which can never match: a `look` does not fail the run, so
there is nothing to accept, and the line would have been reported stale forever.

## 0.1.0

First release. Two halves that answer adjacent questions about work that already
passes its tests.

**Could those checks have failed?**

- `assay runners` — six properties over mutation harnesses: positive evidence a
  suite ran, a dead-vs-real partition before counting, restore in a `finally`,
  SIGTERM handled (it does not run `finally`), a parse guard so a file-breaking
  mutation is not scored as a catch, and no scratch state beside the code under test.
- `assay anchors` — every mutation anchor must match its target exactly once.
- `assay diff` — does this change carry the checks it needs?
- `assay all` — every audit, and **the only command that can call a baseline entry
  stale**.

**Does the tree already answer this?**

- `assay scan` — functions that answer the same question, discovered by executing
  them against a deterministic ladder and bucketing by outcome vector. Names are
  never read.
- `assay pair` — the declared route, for two named functions.
- `assay search` — search before you generate.

**Both languages.** Python is complete; JavaScript ships everything except
`anchors`, which needs a real parser the no-dependency rule forbids — under Node it
exits 2 and names where the command does exist. `python/tests/test_parity.py` asserts the
two halves share property names, verdict names, config keys, ladder version and
thresholds.

**Also shipped:** a GitHub Action (`action.yml`) and a Dockerfile carrying both
runtimes.

**Known limits**, stated in the README rather than discovered: `same` is never
equivalence; coverage of the sameness half is roughly a tenth of functions and the
census says which and why; it compares functions, not programs; the JavaScript half
loads the module it probes, where Python does not.
