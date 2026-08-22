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
        "test/mutate_legacy.py: no `evidence` (no failures reported and no test executed look identical)"
      ]
    }

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


class ConfigError(Exception):
    """The config exists and is unusable. Distinct from the config being absent."""


class Config:
    def __init__(self, runner_exempt=None, anchor_exempt=None, baseline=None,
                 path=None):
        # {(path, property): reason}
        self.runner_exempt = dict(runner_exempt or {})
        # {path: reason}
        self.anchor_exempt = dict(anchor_exempt or {})
        self.baseline = list(baseline or [])
        self.path = path

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

    baseline = raw.get("baseline", [])
    if not isinstance(baseline, list) or any(not isinstance(b, str) for b in baseline):
        raise ConfigError("%s: 'baseline' must be a list of strings" % path)
    return Config(runner, anchor, baseline, path)


def apply_baseline(findings, accepted):
    """(still_failing, stale). Accepted findings pass; a stale acceptance fails.

    Adopting any audit on an existing project means starting with a backlog, and the
    two dishonest ways to handle that are a magic threshold (which goes stale in
    silence) and a blanket suppression (which hides the next real one). Listing the
    findings you have read, by their exact text, does neither: a new one is not in the
    list so it fails, and one you fixed no longer fires so its line fails as stale.

    `findings` is a list of Items; the return keeps that shape.
    """
    known = set(accepted)
    seen = {f.message for f in findings}
    still = [f for f in findings if f.message not in known]
    stale = sorted(known - seen)
    return still, stale
