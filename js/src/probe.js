/**
 * The probe subprocess: stdin JSON in, stdout JSON out.
 *
 * Isolated in its own process for three reasons, all of which have teeth:
 *
 *   * Loading a module runs its top-level code. In a child that cannot reach the
 *     caller's state, and a module that throws on load costs one probe rather than
 *     the whole run.
 *   * A probed function can loop forever or exhaust memory. A dead child is a `look`;
 *     a dead parent is a tool that cannot report anything at all.
 *   * The parent stays free to time the child out, which is the only reliable way to
 *     bound synchronous JavaScript — there is no interrupt to deliver to a spinning
 *     loop from inside its own process.
 *
 * It reports one entry per exported function: either an outcome vector, or the reason
 * that function was skipped. Skipping is never silent, because a census that omits
 * what it never looked at reads exactly like a clean sweep.
 */

import { pathToFileURL } from 'node:url';

import { functionRefusal, outcomeOf } from './sameness.js';

/** Every exported function of a module, with its exported name. */
export function exportedFunctions(namespace) {
  const out = [];
  for (const name of Object.keys(namespace).sort()) {
    const value = namespace[name];
    if (typeof value === 'function') out.push([name, value]);
  }
  // A CommonJS module loaded through the ESM bridge arrives under `default`, and its
  // functions are properties of that object. Missing this reports "0 functions" for
  // every CJS file in a project, which reads as nothing to find rather than as a
  // shape the tool did not handle.
  const fallback = namespace.default;
  if (fallback && typeof fallback === 'object') {
    for (const name of Object.keys(fallback).sort()) {
      if (typeof fallback[name] === 'function' && !out.some(([n]) => n === name)) {
        out.push([name, fallback[name]]);
      }
    }
  }
  return out;
}

export function probeFunction(fn, name, ladders) {
  const arity = fn.length;
  let source = '';
  try {
    source = Function.prototype.toString.call(fn);
  } catch {
    return { name, skip: 'source unavailable' };
  }
  const why = functionRefusal(source, arity);
  if (why) return { name, skip: why };
  const inputs = ladders[String(arity)];
  if (!inputs) return { name, skip: `no ladder for arity ${arity}` };
  const vector = inputs.map((src) => outcomeOf(fn, JSON.parse(src)));
  return { name, arity, vector };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const request = JSON.parse(raw);
  let namespace;
  try {
    namespace = await import(pathToFileURL(request.file).href);
  } catch (err) {
    process.stdout.write(JSON.stringify({
      error: `could not load (${(err && err.message) || err})`.slice(0, 120),
    }));
    return;
  }
  const functions = exportedFunctions(namespace)
    .map(([name, fn]) => probeFunction(fn, name, request.ladders));
  process.stdout.write(JSON.stringify({ functions }));
}

// Only run when invoked as a program. Imported by the tests, which call the pieces
// directly rather than through a pipe.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
