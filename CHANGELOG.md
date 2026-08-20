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
exits 2 and names where the command does exist. `tests/test_parity.py` asserts the
two halves share property names, verdict names, config keys, ladder version and
thresholds.

**Also shipped:** a GitHub Action (`action.yml`) and a Dockerfile carrying both
runtimes.

**Known limits**, stated in the README rather than discovered: `same` is never
equivalence; coverage of the sameness half is roughly a tenth of functions and the
census says which and why; it compares functions, not programs; the JavaScript half
loads the module it probes, where Python does not.
