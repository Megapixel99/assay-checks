# Changelog

Versions follow [semantic versioning](https://semver.org/). The parts under version
are the **CLI contract** (subcommand names, flags, the three exit codes), the
**`assay.json` format**, and the **verdict vocabulary** — not the set of findings a
given release reports, which is expected to grow.

**A new check is a MINOR bump even though it can turn a passing build red.** That is
the honest reading: a tool whose whole purpose is finding things you had not checked
cannot promise that a patch release finds nothing new. Pin exactly if that matters,
and use the `baseline` in `assay.json` to accept what you have read.

## Unreleased

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
