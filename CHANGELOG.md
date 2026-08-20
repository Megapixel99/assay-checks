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
