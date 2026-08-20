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

- `assay diff` no longer reports a **deleted** file as needing a check. A commit
  that removes a directory used to produce one `look` per file, all of them advice
  about code that is gone. Found by a repository converting a subdirectory into a
  submodule: the diff lists every file as deleted, and the audit had an opinion
  about each one.

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
