"""Project configuration: exemptions and an accepted-findings baseline.

WHY THIS IS A FILE AND NOT A CONSTANT. Both halves of this tool need to know things
only your project knows — which harness meets a property by a mechanism the detector
cannot see, which findings you have read and accepted. Baking those into the tool
makes it one project's tool. Reading them from a file makes the tool general and puts
the judgment where the judgment belongs, next to the code it is about.

EVERY TABLE HERE IS READ IN BOTH DIRECTIONS, and that is the whole design. An
exemption naming a file that no longer exists is a finding. A property name that does
not exist is a finding. A baseline line that no longer fires is a finding, because
someone fixed the problem and left the record claiming otherwise.

A table read only one way rots into decoration. It accumulates entries, none of them
ever expire, and after a while it is a list of things somebody once believed rather
than a list of things that are true. The second direction costs about ten lines and is
the difference between a suppression file and a record.

FORMAT — `assay.json` beside your project root, or `--config PATH`:

    {
      "runner_exempt": [{
        "path": "test/mutate_api.py", "property": "sigterm",
        "reason": "writes only under a tempdir, so a kill leaves nothing mutated"
      }],
      "anchor_exempt": [{
        "path": "test/mutate_api.py", "reason": "anchors into generated source"
      }],
      "baseline": [
        "test/mutate_legacy.py: no `evidence` (no failures reported and no test executed look identical)",
        {"line": "test/mutate_old.py: an anchor matches NOTHING — ...",
         "reason": "the guard moved to the new parser; deleting it is the 0.3 job",
         "from": "anchors"}
      ]
    }

A baseline entry is the finding's exact text, or an OBJECT carrying it as `line`. The
object form takes a `reason` — required, for the reason an exemption's is — and an
optional `from` naming the command that can produce the line, which is what lets a
single command call that line stale instead of every run needing to be `assay all`.

A `baseline` line is the exact text of a FINDING, and only a finding. The example above
used to read `src/thing.py has NO mutation runner naming it`, which is a `look`: it
never fails a run, so there is nothing to accept and the line could never match.

`property` may be `"*"` to exempt a file from every property. `reason` is required and
not decorative: an exemption without one is indistinguishable from an oversight, and
six months later nobody can tell which it was.
"""

import json
import os

CONFIG_NAMES = ("assay.json", ".assay.json")

# THE COMMANDS THAT CAN PRODUCE A BASELINE LINE, which is exactly the set `assay all`
# performs. A baseline entry may name the one that fires it, and that turns staleness
# from a property of the RUN into a property of the LINE — see `apply_baseline`.
#
# `pair`, `search` and `why` are absent on purpose: the first two answer about a pair
# somebody named rather than auditing a tree, and the third produces no findings at
# all. Nothing they print is a line a CI run would accept.
FAMILIES = ("runners", "anchors", "diff", "scan")


class Accepted:
    """One accepted finding: the exact line, why it was accepted, what fires it.

    A BARE STRING IS STILL LEGAL, and that is not politeness about old configs.
    Adopting this on an existing project means pasting lines out of a run, and a format
    that refuses the paste is a format nobody adopts. What a string cannot carry is the
    two things this table needs most:

      reason  `runner_exempt` requires one because an exemption without one cannot be
              told from an oversight. A baseline entry is the same claim about a
              different thing — and it is the table that accumulates most and rots
              first, since a fixed finding leaves its line behind in silence. The
              object form asks for one.

      from    WHICH COMMAND can produce this line. Without it, completeness is a
              property of the whole RUN: a line can only be called stale by a run that
              performed every audit, so under any single command every line goes
              unchecked and the run prints a disclaimer instead of a number. With it,
              completeness is per line, and `assay runners` can call a `runners` line
              stale while saying nothing about the `anchors` ones.
    """

    def __init__(self, line, reason=None, produced_by=None):
        self.line = line
        self.reason = reason
        self.produced_by = produced_by

    def __eq__(self, other):
        return (isinstance(other, Accepted)
                and (self.line, self.reason, self.produced_by)
                == (other.line, other.reason, other.produced_by))

    def __repr__(self):                                       # pragma: no cover
        return "<Accepted %r from=%s>" % (self.line[:40], self.produced_by)


class ConfigError(Exception):
    """The config exists and is unusable. Distinct from the config being absent."""


class Config:
    def __init__(self, runner_exempt=None, anchor_exempt=None, baseline=None,
                 path=None):
        # {(path, property): reason}
        self.runner_exempt = dict(runner_exempt or {})
        # {path: reason}
        self.anchor_exempt = dict(anchor_exempt or {})
        # Strings normalise to `Accepted`, so everything downstream sees one shape and
        # the two forms cannot drift apart into two code paths.
        self.baseline = [b if isinstance(b, Accepted) else Accepted(b)
                         for b in (baseline or [])]
        self.path = path

    @property
    def baseline_lines(self):
        return [a.line for a in self.baseline]

    def exempt_runner(self, rel, key):
        """The reason this runner is excused this property, or None."""
        return (self.runner_exempt.get((rel, "*"))
                or self.runner_exempt.get((rel, key)))

    def __repr__(self):                                       # pragma: no cover
        return "<Config %s runner=%d anchor=%d baseline=%d>" % (
            self.path, len(self.runner_exempt), len(self.anchor_exempt),
            len(self.baseline))


def _entries(raw, key, required, path):
    out = raw.get(key, [])
    if not isinstance(out, list):
        raise ConfigError("%s: %r must be a list" % (path, key))
    for entry in out:
        if not isinstance(entry, dict):
            raise ConfigError("%s: every %s entry must be an object" % (path, key))
        for field in required:
            if not entry.get(field):
                raise ConfigError("%s: a %s entry is missing %r — an exemption "
                                  "without a reason cannot be told from an oversight"
                                  % (path, key, field))
    return out


def load(path=None, root="."):
    """Read config from `path`, or find one in `root`. Absent is fine; broken is not.

    An absent config is an empty one: the tool must work on a project that has never
    heard of it, and demanding a file before it will run is how a tool goes unadopted.
    A config that exists and is malformed is a hard error, because silently ignoring
    it would run the audit with none of the judgment the file was written to carry.
    """
    if path is None:
        for name in CONFIG_NAMES:
            candidate = os.path.join(root, name)
            if os.path.exists(candidate):
                path = candidate
                break
    if path is None:
        return Config()
    if not os.path.exists(path):
        raise ConfigError("no config at %s" % path)
    try:
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
    except ValueError as exc:
        raise ConfigError("%s is not valid JSON (%s)" % (path, exc))
    if not isinstance(raw, dict):
        raise ConfigError("%s must hold a JSON object" % path)

    runner = {}
    for entry in _entries(raw, "runner_exempt", ("path", "reason"), path):
        runner[(entry["path"], entry.get("property", "*"))] = entry["reason"]
    anchor = {}
    for entry in _entries(raw, "anchor_exempt", ("path", "reason"), path):
        anchor[entry["path"]] = entry["reason"]

    raw_baseline = raw.get("baseline", [])
    if not isinstance(raw_baseline, list):
        raise ConfigError("%s: 'baseline' must be a list" % path)
    baseline = []
    for entry in raw_baseline:
        if isinstance(entry, str):
            baseline.append(Accepted(entry))
            continue
        if not isinstance(entry, dict):
            raise ConfigError("%s: a 'baseline' entry must be the finding's exact "
                              "text, or an object carrying it as 'line'" % path)
        for field in ("line", "reason"):
            if not entry.get(field):
                raise ConfigError(
                    "%s: a 'baseline' entry in object form is missing %r — an "
                    "acceptance without a reason cannot be told from an oversight"
                    % (path, field))
        produced_by = entry.get("from")
        if produced_by is not None and produced_by not in FAMILIES:
            raise ConfigError("%s: a 'baseline' entry names %r in 'from', which is "
                              "no command that can produce a finding (known: %s)"
                              % (path, produced_by, ", ".join(FAMILIES)))
        baseline.append(Accepted(entry["line"], entry["reason"], produced_by))
    return Config(runner, anchor, baseline, path)


def apply_baseline(findings, accepted, performed=()):
    """(still_failing, stale, unchecked). Accepted findings pass; a stale one fails.

    Adopting any audit on an existing project means starting with a backlog, and the
    two dishonest ways to handle that are a magic threshold (which goes stale in
    silence) and a blanket suppression (which hides the next real one). Listing the
    findings you have read, by their exact text, does neither: a new one is not in the
    list so it fails, and one you fixed no longer fires so its line fails as stale.

    STALENESS IS PER LINE, NOT PER RUN, and getting that wrong made the tool cry wolf
    at itself. `assay runners` cannot produce a finding that only `diff` reports, so a
    partial run that checked staleness flagged every `diff` line as fixed — the audit
    reporting a problem with its own config, on a clean tree, on every run. The first
    fix was to check staleness only from `assay all`, which is correct and blunt: it
    makes every line in every other run unchecked, and the run prints a disclaimer
    where a number belongs.

    An entry that names the command that fires it can be answered by that command
    alone. So `performed` is the set of audits this run actually did, and each entry
    lands in exactly one of three places:

      it fired            — nothing to say, and it is suppressed from the findings.
      this run could see it and it did not fire   — STALE.
      this run could not see it                   — UNCHECKED, and counted as such,
                                                    because `0 stale` from a run that
                                                    never looked reads as "nothing is
                                                    stale" and those are different
                                                    claims.

    An entry with no `from` keeps the old rule: only a run that performed EVERY audit
    can call it stale, since nothing narrower knows what could have produced it.

    `findings` is a list of Items and `accepted` a list of `Accepted`; `stale` and
    `unchecked` come back as `Accepted`, so a caller can print the reason too.
    """
    known = {a.line for a in accepted}
    seen = {f.message for f in findings}
    still = [f for f in findings if f.message not in known]
    performed = frozenset(performed or ())
    complete = set(FAMILIES) <= performed
    stale, unchecked = [], []
    for entry in sorted(accepted, key=lambda a: a.line):
        if entry.line in seen:
            continue
        if entry.produced_by is None:
            (stale if complete else unchecked).append(entry)
        elif entry.produced_by in performed:
            stale.append(entry)
        else:
            unchecked.append(entry)
    return still, stale, unchecked
