/**
 * assay — audit the checks, and find the answers your tree already has.
 *
 * Two questions ordinary CI does not answer, about work that already passes its tests:
 *
 *     could those checks have failed?
 *     does the tree already answer this?
 *
 * Three verdicts, never mixed. `finding` fails, `look` never does, `ok` is printed
 * because "we found none" and "we never looked" are different claims.
 */

export { FINDING, LOOK, OK, Item, Report, render } from './verdicts.js';
export { Config, ConfigError, applyBaseline, load as loadConfig } from './config.js';
export {
  PROPERTIES, PROPERTY_KEYS, THREE_QUESTIONS,
  auditDiff, auditRunners, changedFiles, checkExemptions, findRunners,
  guardsPerFile, targetsMentioned,
} from './checks.js';
export {
  BASE_VALUES, LADDER_VERSION, MAX_ARITY, MIN_DISTINCT, Scan,
  canon, collect, compare, discriminating, displayPath, fileRefusal,
  functionRefusal, group, isProjection, jsFiles, ladder, ladderKey, outcomeOf,
  probeFile, projections, reportScan,
} from './sameness.js';
export { run, parseArgs } from './cli.js';
