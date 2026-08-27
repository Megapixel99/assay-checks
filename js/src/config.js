/**
 * Project configuration: exemptions and an accepted-findings baseline.
 *
 * WHY THIS IS A FILE AND NOT A CONSTANT. Both halves need to know things only your
 * project knows — which harness meets a property by a mechanism the detector cannot
 * see, which findings you have read and accepted. Baking those into the tool makes it
 * one project's tool. Reading them from a file makes the tool general and puts the
 * judgment where the judgment belongs, next to the code it is about.
 *
 * EVERY TABLE IS READ IN BOTH DIRECTIONS, and that is the whole design. An exemption
 * naming a file that no longer exists is a finding. A property name that does not
 * exist is a finding. A baseline line that no longer fires is a finding, because
 * someone fixed the problem and left the record claiming otherwise.
 *
 * A table read only one way rots into decoration. It accumulates entries, none of them
 * ever expire, and after a while it is a list of things somebody once believed rather
 * than a list of things that are true. The second direction costs about ten lines and
 * is the difference between a suppression file and a record.
 *
 * The format is identical to the Python half's, deliberately: one `assay.json` serves
 * a polyglot repository, and two files that had to be kept in step would be the exact
 * duplication this tool exists to find.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_NAMES = ['assay.json', '.assay.json'];

/**
 * The commands that can produce a baseline line, which is exactly the set `assay all`
 * performs. A baseline entry may name the one that fires it, and that turns staleness
 * from a property of the RUN into a property of the LINE — see `applyBaseline`.
 *
 * `pair`, `search` and `why` are absent on purpose: the first two answer about a pair
 * somebody named rather than auditing a tree, and the third produces no findings at
 * all. Nothing they print is a line a CI run would accept.
 */
export const FAMILIES = ['runners', 'anchors', 'diff', 'scan', 'sweep'];

/**
 * What an UNTAGGED line could have come from, which is NOT the same set and the
 * difference is load-bearing.
 *
 * `FAMILIES` answers "is this a legal `from`?". This answers "may a run that did not
 * perform X call an UNTAGGED line stale?" — and conflating the two is a defect in
 * whichever direction you resolve it. Put `sweep` in here and every existing
 * `assay all --scan` stops being a complete run, so untagged entries in every
 * already-written `assay.json` silently stop being checked for staleness — the tool
 * quietly doing less, which is the failure this package exists to report. Leave `sweep`
 * out of `FAMILIES` instead and a cross finding cannot be tagged at all, so it lands
 * untagged and `all --scan` — complete by this definition, having never swept — calls
 * it stale on a clean tree. That is the cry-wolf defect `applyBaseline` already carries
 * a comment about.
 *
 * The two sets differ by exactly one name, and the reason it is safe is a fact about
 * TIME rather than a convention: `assay accept` always writes `from`, so the only
 * untagged lines that can exist were written before `sweep` did, and no line older than
 * a command can have been produced by it. A line hand-written untagged for a cross
 * finding is outside that — tag it, which is what the tool would have done.
 */
export const COMPLETING = ['runners', 'anchors', 'diff', 'scan'];

export class ConfigError extends Error {}

/**
 * One accepted finding: the exact line, why it was accepted, what fires it.
 *
 * A BARE STRING IS STILL LEGAL, and that is not politeness about old configs. Adopting
 * this on an existing project means pasting lines out of a run, and a format that
 * refuses the paste is a format nobody adopts. What a string cannot carry is the two
 * things this table needs most:
 *
 *   reason  `runner_exempt` requires one because an exemption without one cannot be
 *           told from an oversight. A baseline entry is the same claim about a
 *           different thing — and it is the table that accumulates most and rots
 *           first, since a fixed finding leaves its line behind in silence.
 *
 *   from    WHICH COMMAND can produce this line. Without it, completeness is a
 *           property of the whole RUN: a line can only be called stale by a run that
 *           performed every audit, so under any single command every line goes
 *           unchecked and the run prints a disclaimer where a number belongs.
 */
export class Accepted {
  constructor(line, reason = null, producedBy = null) {
    this.line = line;
    this.reason = reason;
    this.producedBy = producedBy;
  }
}

export class Config {
  constructor({ runnerExempt = new Map(), anchorExempt = new Map(),
    baseline = [], filePath = null } = {}) {
    this.runnerExempt = runnerExempt;
    this.anchorExempt = anchorExempt;
    // Strings normalise to `Accepted`, so everything downstream sees one shape and the
    // two forms cannot drift apart into two code paths.
    this.baseline = baseline.map((b) => (b instanceof Accepted ? b : new Accepted(b)));
    this.path = filePath;
  }

  get baselineLines() { return this.baseline.map((a) => a.line); }

  /** The reason this runner is excused this property, or null. */
  exemptRunner(rel, key) {
    return this.runnerExempt.get(`${rel} *`)
      || this.runnerExempt.get(`${rel} ${key}`)
      || null;
  }
}

function entries(raw, key, required, where) {
  const list = raw[key] || [];
  if (!Array.isArray(list)) throw new ConfigError(`${where}: '${key}' must be a list`);
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigError(`${where}: every ${key} entry must be an object`);
    }
    for (const field of required) {
      if (!entry[field]) {
        throw new ConfigError(`${where}: a ${key} entry is missing '${field}' — an `
          + 'exemption without a reason cannot be told from an oversight');
      }
    }
  }
  return list;
}

/**
 * Read config from `filePath`, or find one in `root`.
 *
 * An absent config is an empty one: the tool must work on a project that has never
 * heard of it, and demanding a file before it will run is how a tool goes unadopted. A
 * config that exists and is malformed is a hard error, because silently ignoring it
 * would run the audit with none of the judgment the file was written to carry.
 */
export function load(filePath = null, root = '.') {
  let target = filePath;
  if (!target) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(root, name);
      if (existsSync(candidate)) { target = candidate; break; }
    }
  }
  if (!target) return new Config();
  if (!existsSync(target)) throw new ConfigError(`no config at ${target}`);

  let raw;
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${target} is not valid JSON (${err.message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${target} must hold a JSON object`);
  }

  const runnerExempt = new Map();
  for (const entry of entries(raw, 'runner_exempt', ['path', 'reason'], target)) {
    runnerExempt.set(`${entry.path} ${entry.property || '*'}`, entry.reason);
  }
  const anchorExempt = new Map();
  for (const entry of entries(raw, 'anchor_exempt', ['path', 'reason'], target)) {
    anchorExempt.set(entry.path, entry.reason);
  }
  const rawBaseline = raw.baseline || [];
  if (!Array.isArray(rawBaseline)) {
    throw new ConfigError(`${target}: 'baseline' must be a list`);
  }
  const baseline = [];
  for (const entry of rawBaseline) {
    if (typeof entry === 'string') { baseline.push(new Accepted(entry)); continue; }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${target}: a 'baseline' entry must be the finding's exact `
        + "text, or an object carrying it as 'line'");
    }
    for (const field of ['line', 'reason']) {
      if (!entry[field]) {
        throw new ConfigError(`${target}: a 'baseline' entry in object form is missing `
          + `'${field}' — an acceptance without a reason cannot be told from an `
          + 'oversight');
      }
    }
    const producedBy = entry.from === undefined ? null : entry.from;
    if (producedBy !== null && !FAMILIES.includes(producedBy)) {
      throw new ConfigError(`${target}: a 'baseline' entry names '${producedBy}' in `
        + "'from', which is no command that can produce a finding "
        + `(known: ${FAMILIES.join(', ')})`);
    }
    baseline.push(new Accepted(entry.line, entry.reason, producedBy));
  }
  return new Config({ runnerExempt, anchorExempt, baseline, filePath: target });
}

/**
 * Append accepted findings to `file`, leaving every other key exactly as it was.
 *
 * IT REWRITES THE WHOLE DOCUMENT, because JSON cannot be appended to. Everything
 * already in the file is read back and written out unchanged, and an existing
 * bare-string entry stays a bare string: rewriting somebody's file into a shape they
 * did not ask for is not the job of a command asked to add one line.
 *
 * `entries` is `{ line, reason, producedBy }`. A null `producedBy` writes no `from`
 * rather than a `from` of null — a key whose value says nothing is a key a later
 * reader has to decide the meaning of.
 */
export function writeBaseline(file, entries) {
  let raw = {};
  if (existsSync(file)) {
    raw = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConfigError(`${file} must hold a JSON object`);
    }
  }
  const baseline = [...(raw.baseline || [])];
  for (const { line, reason, producedBy } of entries) {
    const entry = { line, reason };
    if (producedBy) entry.from = producedBy;
    baseline.push(entry);
  }
  raw.baseline = baseline;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * [stillFailing, stale, unchecked]. Accepted findings pass; a stale one fails.
 *
 * Adopting any audit on an existing project means starting with a backlog, and the two
 * dishonest ways to handle that are a magic threshold (which goes stale in silence)
 * and a blanket suppression (which hides the next real one). Listing the findings you
 * have read, by their exact text, does neither: a new one is not in the list so it
 * fails, and one you fixed no longer fires so its line fails as stale.
 *
 * STALENESS IS PER LINE, NOT PER RUN, and getting that wrong made the tool cry wolf at
 * itself. `runners` cannot produce a finding that only `diff` reports, so a partial run
 * that checked staleness flagged every `diff` line as fixed — the audit reporting a
 * problem with its own config, on a clean tree, on every run. The first fix was to
 * check staleness only from `all`, which is correct and blunt: it makes every line in
 * every other run unchecked, and the run prints a disclaimer where a number belongs.
 *
 * An entry that names the command firing it can be answered by that command alone, so
 * `performed` is what this run actually audited and each entry lands in exactly one of
 * three places: it fired, this run could see it and it did not, or this run could not
 * see it. The third is COUNTED rather than treated as fresh — `0 stale` from a run that
 * never looked reads as "nothing is stale", and those are different claims.
 *
 * An entry with no `from` keeps the old rule: only a run that performed EVERY audit can
 * call it stale, since nothing narrower knows what could have produced it.
 */
export function applyBaseline(findings, accepted, performed = []) {
  const known = new Set(accepted.map((a) => a.line));
  const seen = new Set(findings.map((f) => f.message));
  const still = findings.filter((f) => !known.has(f.message));
  const did = new Set(performed);
  const complete = COMPLETING.every((f) => did.has(f));
  const stale = [];
  const unchecked = [];
  const ordered = [...accepted].sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  for (const entry of ordered) {
    if (seen.has(entry.line)) continue;
    if (entry.producedBy === null) (complete ? stale : unchecked).push(entry);
    else if (did.has(entry.producedBy)) stale.push(entry);
    else unchecked.push(entry);
  }
  return [still, stale, unchecked];
}
