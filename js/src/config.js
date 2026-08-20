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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_NAMES = ['assay.json', '.assay.json'];

export class ConfigError extends Error {}

export class Config {
  constructor({ runnerExempt = new Map(), anchorExempt = new Map(),
    baseline = [], filePath = null } = {}) {
    this.runnerExempt = runnerExempt;
    this.anchorExempt = anchorExempt;
    this.baseline = baseline;
    this.path = filePath;
  }

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
  const baseline = raw.baseline || [];
  if (!Array.isArray(baseline) || baseline.some((b) => typeof b !== 'string')) {
    throw new ConfigError(`${target}: 'baseline' must be a list of strings`);
  }
  return new Config({ runnerExempt, anchorExempt, baseline, filePath: target });
}

/**
 * [stillFailing, stale]. Accepted findings pass; a stale acceptance fails.
 *
 * Adopting any audit on an existing project means starting with a backlog, and the two
 * dishonest ways to handle that are a magic threshold (which goes stale in silence)
 * and a blanket suppression (which hides the next real one). Listing the findings you
 * have read, by their exact text, does neither: a new one is not in the list so it
 * fails, and one you fixed no longer fires so its line fails as stale.
 */
export function applyBaseline(findings, accepted) {
  const known = new Set(accepted);
  const seen = new Set(findings.map((f) => f.message));
  const still = findings.filter((f) => !known.has(f.message));
  const stale = [...known].filter((k) => !seen.has(k)).sort();
  return [still, stale];
}
