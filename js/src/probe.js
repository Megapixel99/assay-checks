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

import { writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ANSWER_FD, functionRefusal, outcomeOf } from './sameness.js';

/**
 * Every exported function of a module, with its exported name — each function ONCE.
 *
 * Deduping is BY IDENTITY, and the name is why it has to be. A CommonJS module whose
 * export is a function arrives through the ESM bridge under two keys, `default` and
 * `module.exports`, both pointing at the same object. Keyed by name they are two
 * exports; they are one function, and reporting them as two made every
 * `module.exports = fn` file in a tree duplicate ITSELF — eleven of fourteen findings
 * on the first real project this was pointed at. A finding a person has to dismiss is
 * the failure this tool is built to avoid, so it must not manufacture them.
 *
 * `inherited` carries the same rule ACROSS files. A barrel module that re-exports its
 * helpers hands back the very objects its dependencies defined, so the helper is one
 * function reachable by two paths — `registry.js::truncate` and `truncate.js::default`
 * were reported as answering the same question, which is true and useless. Skipping
 * them here names each function once, under the file that DEFINES it.
 */
export function exportedFunctions(namespace, inherited = new Set()) {
  const out = [];
  const seen = new Set(inherited);
  const add = (name, value) => {
    if (typeof value !== 'function' || seen.has(value)) return;
    seen.add(value);
    out.push([name, value]);
  };
  for (const name of Object.keys(namespace).sort()) add(name, namespace[name]);
  // A CommonJS module loaded through the ESM bridge arrives under `default`, and its
  // functions are properties of that object. Missing this reports "0 functions" for
  // every CJS file in a project, which reads as nothing to find rather than as a
  // shape the tool did not handle.
  const fallback = namespace.default;
  if (fallback && typeof fallback === 'object') {
    for (const name of Object.keys(fallback).sort()) {
      if (!out.some(([n]) => n === name)) add(name, fallback[name]);
    }
  }
  return out;
}

/**
 * The answer, on its own descriptor.
 *
 * Not stdout: the module this process just loaded may have printed there, and an
 * answer sharing a channel with arbitrary output is an answer that can be corrupted by
 * it. `writeSync` loops because a pipe is free to accept a partial write.
 */
function answer(payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(ANSWER_FD, buf, off, buf.length - off);
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

/**
 * Load a module, and treat a `.js` file holding ESM syntax as ESM on every supported
 * runtime rather than only on the newest ones.
 *
 * Node decides a `.js` file's format from the nearest `package.json`: no `"type":
 * "module"` means CommonJS, and `export function f() {}` is then a SyntaxError. Node
 * 22.7 and later paper over this by SNIFFING the source, so the same file that loads
 * on 24 fails on 18 — and `engines` here says `>=18`. Without this fallback the tool
 * silently reports "could not load" for every ESM file in a package that has not
 * opted in, which reads as a clean tree rather than as a scan that never ran.
 *
 * The retry re-enters the source as a `data:` URL, which is unambiguously a module.
 * A file with RELATIVE imports cannot resolve them from a `data:` URL and is reported
 * as unloadable — the same verdict it already got, never a wrong one — so the
 * ORIGINAL error is what gets reported when the retry fails too.
 */
async function loadModule(file, source) {
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    if (!source || !(err instanceof SyntaxError)) throw err;
    try {
      const encoded = Buffer.from(source, 'utf8').toString('base64');
      return await import(`data:text/javascript;base64,${encoded}`);
    } catch {
      throw err;
    }
  }
}

/** Relative specifiers this source imports or requires. Never bare package names. */
export function relativeSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\brequire\s*\(\s*['"](\.[^'"]*)['"]/g,
    /\bfrom\s+['"](\.[^'"]*)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]*)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) found.add(m[1]);
  }
  return [...found];
}

/**
 * Every function object this file's own dependencies export.
 *
 * They are already loaded — the module under probe pulled them in — so importing them
 * again is a cache hit and runs no new top-level code. A specifier that will not
 * resolve is skipped rather than reported: failing to spot a re-export costs one
 * dismissible finding, and guessing at one would hide a real function.
 */
async function inheritedFunctions(file, source) {
  const out = new Set();
  const base = path.dirname(file);
  for (const spec of relativeSpecifiers(source)) {
    const target = path.resolve(base, spec);
    const candidates = [target, `${target}.js`, `${target}.mjs`,
      path.join(target, 'index.js')];
    for (const candidate of candidates) {
      let dep;
      try {
        // eslint-disable-next-line no-await-in-loop
        dep = await import(pathToFileURL(candidate).href);
      } catch {
        continue;
      }
      for (const [, fn] of exportedFunctions(dep)) out.add(fn);
      break;
    }
  }
  return out;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const request = JSON.parse(raw);
  let namespace;
  try {
    namespace = await loadModule(request.file, request.source);
  } catch (err) {
    answer({ error: `could not load (${(err && err.message) || err})`.slice(0, 120) });
    return;
  }
  let inherited = new Set();
  try {
    inherited = await inheritedFunctions(request.file, request.source || '');
  } catch {
    inherited = new Set();
  }
  const functions = exportedFunctions(namespace, inherited)
    .map(([name, fn]) => probeFunction(fn, name, request.ladders));
  answer({ functions });
}

// Only run when invoked as a program. Imported by the tests, which call the pieces
// directly rather than through a pipe.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
