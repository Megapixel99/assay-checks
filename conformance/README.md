# A conformance suite for mutation-testing frameworks

`assay runners` audits mutation harnesses against seven properties. The seven are
framework-agnostic — nothing in them is about *your* harness rather than anyone's —
but until now they had only ever been pointed at hand-rolled harnesses inside one
tree. This runs them, and the one question they explicitly cannot answer, against
four incumbents: **mutmut**, **cosmic-ray**, **Stryker**, and **PIT**.

The question the properties stop short of is written down in this repository's own
README and left open there:

> SIGKILL cannot be caught, blocked or handled: no handler runs, no `finally` runs,
> and no property in the table above would have helped. The ordinary way to be
> SIGKILLed is not an impatient person but a **timeout**. […] The remedy is not in
> the harness and cannot be: it belongs to **whatever invoked the harness**.

So: run each framework under an interruption it cannot survive, at the instant it is
least able to survive it, and hash the tree.

## The result

```
python3 conformance/run.py
```

| framework | version | baseline | sigterm-leader | sigterm | sigkill | mutates in place? |
|---|---|---|---|---|---|---|
| `control-inplace` | n/a | **CLEAN** | **CLEAN** | **CLEAN** | **DIRTY** | yes |
| `cosmic-ray` | 8.4.6 | **SCRATCH** | **DIRTY** | **DIRTY** | **DIRTY** | yes |
| `mutmut` | 3.7.0 | **SCRATCH** | **SCRATCH** | **SCRATCH** | **SCRATCH** | no — sandboxed |
| `pit` | 1.16.1 | **SCRATCH** | **CLEAN** | **CLEAN** | **CLEAN** | no — sandboxed |
| `stryker` | 8.7.1 | **CLEAN** | **SCRATCH** | **SCRATCH** | **SCRATCH** | no — sandboxed |

- **CLEAN** — every file byte-for-byte as it was before the run.
- **SCRATCH** — the code under test came back, but the run left other paths behind.
- **DIRTY** — a file under test was left mutated. This is the one that costs you
  something: every command you run afterwards is scoring code nobody wrote.

Four columns, because *what* interrupted the run turns out to change the answer.
`sigterm-leader` signals only the process we started, which is what `timeout` and
`subprocess.run(..., timeout=...)` do. `sigterm` signals the whole process group,
which is what a CI cancel and a Ctrl-C do. `sigkill` is the case no property reaches.

## What it found

**One of the four fails, and it fails earlier than predicted.** cosmic-ray mutates
the file on disk, and a SIGTERM delivered while a mutant is applied leaves it
mutated — under a plain `timeout`, not merely under SIGKILL. That is a failure of
the `sigterm` property itself, which is *inside* the seven, rather than of the
SIGKILL blind spot beyond them. The prediction was that everyone would pass the
seven and fail the eighth question; cosmic-ray does not get that far.

**The other three never mutate the tree at all.** mutmut copies the project into
`mutants/`, Stryker copies it into `.stryker-tmp/`, and PIT mutates *bytecode* in
memory and never writes a mutated `.java` file anywhere. Their source is clean after
SIGKILL because their source was never dirty — the hole is closed by architecture
rather than by handling a signal, and no signal handler could have done it.

That is the finding to sit with, and it cuts against the incumbents less than it
first appears to. The remedy the README assigns to the invoker — *check that the
tree came back* — is only load-bearing for harnesses that mutate in place. Three of
these four sidestep it by construction, and the fourth is the one that fails. **If
you are writing a harness, the lesson is not "handle more signals"; it is "mutate a
copy".** No process can promise to clean up after being killed, and the only way to
have nothing to clean up is to have put nothing there.

**Everything else here is residue, and residue is the `no-tree-writes` property.**

- `mutmut` leaves `mutants/` behind on every run including a clean one, and after a
  kill it leaves a *partial* one (11 paths against the 12 a finished run writes).
- `stryker` cleans `.stryker-tmp/` when it finishes and cannot when it is killed —
  the one row where the interruption is what makes the difference.
- `pit` writes `target/pit-reports/` on success and nothing when killed, having died
  before the report stage.
- `cosmic-ray` writes `.pytest_cache/` into the tree, which is the default test
  command's doing rather than cosmic-ray's, and is still scratch state beside the
  code under test.

All four of those directories are conventionally git-ignored, so `git diff --quiet`
would not flag them. That is the right call for CI and the wrong call for reasoning
about what a run touched, which is why the report separates the two.

## Why you should believe the table

A suite whose output is a column of CLEANs is worth nothing unless it can be shown to
say DIRTY when the tree really is dirty. `nothing found` and `nothing looked` are the
same output otherwise — which is the `evidence` property, one level up from the
harnesses it audits. So the suite carries its own calibration row.

[`frameworks/control-inplace/mutations_calc.py`](frameworks/control-inplace/mutations_calc.py)
is a harness that mutates in place and satisfies **all seven properties**. Not by
argument — `assay runners` says so:

```
$ PYTHONPATH=python python3 -m assay --root conformance/frameworks/control-inplace runners
  ok       mutations_calc.py

no findings.
```

It is `CLEAN` under both SIGTERMs and `DIRTY` under SIGKILL. That row is the claim in
this repository's README compiled and executed: seven properties, correctly
implemented, and a kill still leaves the tree mutated. It is also the proof that the
three CLEAN rows above mean something.

Three further things the suite does to keep itself honest:

**The kill is timed on an observation, not a stopwatch.** A blind timeout can land
between two mutants, where every framework looks clean. The probe polls the tree every
50ms and signals *at the instant a watched source file is seen mutated on disk*. Where
that never happens — the sandboxing three — it says so explicitly and kills mid-run
anyway, at half the framework's own measured baseline duration, so that "we never
managed to interrupt it" and "it survived being interrupted" stay different findings.
Every fixture's tests sleep 400ms for the same reason: a suite that finishes instantly
cannot be interrupted in the middle of one.

**Each baseline must prove it did the work.** Every framework declares a proof-of-work
string, and a baseline whose output lacks it turns the whole row into `NO-RUN` rather
than a pass. This is not hypothetical — Stryker's first run in this suite died with
`spawn ps ENOENT` in a slim image lacking `procps`, having mutated nothing, and it
produced a *clean tree*. Without the gate that was four passing verdicts about a run
that never happened.

**The framework has to be the process being signalled.** The first version invoked
cosmic-ray via `sh -c` and Stryker via `npx`. A leader-only signal then killed the
shell, orphaned the framework, and let it finish unwatched — and both reported CLEAN
for it. The probe now checks whether anything outlived the leader and records it, and
both invocations were changed so the framework is the leader. Correcting that flipped
Stryker's `sigterm-leader` row from CLEAN to SCRATCH and cosmic-ray's from SCRATCH to
DIRTY, which is to say the original numbers for that column were entirely artifact.

## How it works

```
conformance/
  run.py                      host orchestrator: build, probe, tabulate
  probe.py                    runs INSIDE each container; stdlib only
  fixtures/{python,javascript,java}/   the same three functions, three languages
  frameworks/<name>/          Dockerfile + framework.json (+ config, + harness)
  results/                    one JSON per framework, plus SUMMARY.md
```

Every framework gets a pinned image and a **fresh container per probe**, so no run can
be contaminated by the one before it and every probe starts from the same pristine
tree. The fixture is the same three functions in each language — `clamp`, `score`,
`tally`, all covered — so a difference between two rows is a difference between two
frameworks and not between two codebases.

`probe.py` hashes every file in the tree, starts the framework in its own process
group, polls, signals, waits for the group to go quiet, and hashes again. It reports
modifications to the code under test separately from everything else added, because a
restored target and a clean tree are different claims.

Adding a framework is a `Dockerfile` and a `framework.json`:

```json
{
  "name": "yours", "version": "1.2.3", "language": "python", "fixture": "python",
  "watch": ["calc/*.py"],
  "command": ["yours", "run"],
  "evidence": "mutation score",
  "expected_scratch": [".yours-tmp"]
}
```

`watch` is what counts as the code under test, `evidence` is the proof-of-work string
the baseline must print, and `expected_scratch` is what the framework's own docs say
it leaves behind — anything else it leaves is reported as undocumented.

## What this does not measure

The four properties above are the ones observable from outside a running process.
`dead-vs-real`, `parses-mutant` and half of `evidence` are claims about how a
framework *scores* what it observes, and probing those means feeding each framework a
mutant it should refuse to count and reading its report — a different instrument to
this one, and one that has to be written per framework rather than once. It is the
obvious next thing to build and it is not built here.

`restore-verified` is likewise untested against the incumbents: it asks whether the
framework proves the tree came back, and from outside you can only see whether it
*did* come back. Those are the same distinction the property itself is about.

## Reproducing

Needs Docker and Python 3. Nothing else — the toolchains are all in the images.

```bash
python3 conformance/run.py                  # everything, ~4 minutes after the builds
python3 conformance/run.py cosmic-ray       # one framework
python3 conformance/run.py --no-build       # reuse images already built
```

Results as run on 2026-08-31, x86_64, Docker 29.2.1, are committed under `results/`.
