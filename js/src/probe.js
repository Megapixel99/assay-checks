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

import { readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ANSWER_FD, crossOutcome, declaredArity, functionRefusal, loadRefusal, moduleBindings,
  PER_INPUT_MS, probeOutcome, reachRefusal,
} from './sameness.js';

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
/**
 * One NDJSON line on fd 3, written and flushed before the next one is computed.
 *
 * INCREMENTAL BECAUSE A KILL IS NOT AN ERROR PATH THE CHILD GETS TO HANDLE. A probed
 * function may never return — a `while (true)` has no interrupt in synchronous
 * JavaScript, which is why the parent bounds it with a wall clock and SIGKILL. A child
 * that answers once at the end loses everything it had already computed when that
 * happens: one non-terminating function turned a whole file into `probe failed`, and
 * a file of twenty functions reported nothing about the nineteen that were fine.
 *
 * A line at a time, the kill costs only the function that hung. `writeSync` loops
 * because a pipe is free to accept a partial write, and each line lands before the
 * next function is even started.
 */
function say(payload) {
  const buf = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(ANSWER_FD, buf, off, buf.length - off);
}

export async function probeFunction(fn, name, ladders, cross = false, mod = null,
  perInput = PER_INPUT_MS, resolve = null) {
  let source = '';
  try {
    source = Function.prototype.toString.call(fn);
  } catch {
    return { name, skip: 'source unavailable' };
  }
  // THE DECLARED PARAMETER LIST, never `fn.length` — see `declaredArity`. Choosing the
  // ladder by `fn.length` probes a two-parameter function as a one-parameter one and
  // reports it as answering the same question as something that genuinely takes one.
  const arity = declaredArity(source);
  if (arity === null) return { name, skip: 'cannot read the parameter list' };
  // CHECKED, NOT TRUSTED. `fn.length` counts parameters up to the first default or
  // rest, so it is a LOWER BOUND on the declared count and can never exceed it. If the
  // text parse comes back under that bound it misread the list, and a misread arity is
  // the wrong answer this function exists to stop rather than a smaller one.
  if (arity < fn.length) {
    return { name, skip: `parameter list disagrees with fn.length (${arity} < ${fn.length})` };
  }
  const why = functionRefusal(source, arity);
  if (why) return { name, skip: why };
  // WHAT THIS FUNCTION CAN REACH, which its own text cannot answer. `functionRefusal`
  // read the body; a free name resolves in the module scope around it, and a helper
  // three lines down calling `writeFileSync` is reached by a body that mentions none of
  // the gated words. Probing CALLS the function, so this is the last gate before a real
  // side effect on a real path.
  // `mod` ABSENT MEANS NO MODULE WAS OFFERED, not that one was unreadable. A caller
  // probing a function it already holds — `assay probe`, the suite — has no module
  // scope to resolve against and is not asking this question. The child, which always
  // has one, refuses BY NAME when it cannot be read rather than passing null here.
  const unreachable = mod ? reachRefusal(source, mod, resolve) : null;
  if (unreachable) return { name, skip: unreachable };
  const inputs = ladders[String(arity)];
  if (!inputs) return { name, skip: `no ladder for arity ${arity}` };
  // TWO MODES, and only the inputs and the rendering differ. In `cross` mode the rungs
  // arrive as VALUES — the two languages share no source syntax, which is the reason
  // that ladder exists — and the outcomes are rendered in the interlingua. Same gate,
  // same child, same timeouts, so a function this half refuses is refused for the same
  // reason either way.
  if (cross) {
    const crossVector = [];
    for (const args of inputs) {
      // eslint-disable-next-line no-await-in-loop
      crossVector.push(await crossOutcome(fn, args, perInput));
    }
    return { name, arity, vector: crossVector };
  }
  // ONE RUNG AT A TIME, never `Promise.all`. The ladder is a fixed sequence and the
  // vector has to come back in it; running the rungs concurrently would also let one
  // function's pending work overlap the next rung's, so a probe that hangs would take
  // an unrelated rung's answer down with it.
  const vector = [];
  for (const src of inputs) {
    // eslint-disable-next-line no-await-in-loop
    vector.push(await probeOutcome(fn, JSON.parse(src), perInput));
  }
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
 * Every function this file's dependencies export, mapped to the refusal of the file
 * that DEFINES it — `null` when that file is one the gate would let us load.
 *
 * THE DEFINING FILE'S GATE HAS TO TRAVEL WITH THE FUNCTION, and a barrel is why. The
 * gate is applied by `collect` to the file it is ABOUT to probe, so `config.js` —
 * which imports `node:fs` — is refused and `writeBaseline` is never probed there. But
 * `index.js` re-exports `writeBaseline` and imports no core module of its own, so it
 * passes the same gate, and loading it hands the child the very function the gate just
 * refused. Nothing in `functionRefusal` catches it either: that gate looks for IMPORT
 * statements, and a function body never contains one — `writeFileSync` is a free name
 * resolved from a module scope the gate cannot see.
 *
 * What stood in the way was the de-duplication skip below, which exists to name each
 * function once and had no idea it was also the last thing between the probe and a
 * real `writeFileSync` on a real path. Two mutations remove it, and the probe wrote
 * ten files named after the ladder's string rungs into the repository root.
 *
 * They are already loaded — the module under probe pulled them in — so importing them
 * again is a cache hit and runs no new top-level code. A specifier that will not
 * resolve is skipped rather than reported: failing to spot a re-export costs one
 * dismissible finding, and guessing at one would hide a real function.
 */
async function dependencyExports(file, source) {
  const out = new Map();
  const base = path.dirname(file);
  for (const spec of relativeSpecifiers(source)) {
    const target = path.resolve(base, spec);
    const candidates = [target, `${target}.js`, `${target}.mjs`,
      path.join(target, 'index.js')];
    for (const candidate of candidates) {
      let dep;
      let text;
      try {
        text = readFileSync(candidate, 'utf8');
        // eslint-disable-next-line no-await-in-loop
        dep = await import(pathToFileURL(candidate).href);
      } catch {
        continue;
      }
      // The bytes that were READ are the bytes that get judged. Asking the loaded
      // module what file it came from would be asking the thing under test.
      // THE SAME QUESTION `collect` ASKED, asked the same way. A dependency whose
      // impurity is confined to a body is one this tool would have loaded, so marking
      // its exports refused here would contradict the gate one directory over.
      const refusal = loadRefusal(text);
      for (const [, fn] of exportedFunctions(dep)) {
        if (!out.has(fn)) out.set(fn, refusal);
      }
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
    say({ error: `could not load (${(err && err.message) || err})`.slice(0, 120) });
    return;
  }
  let origins = new Map();
  try {
    origins = await dependencyExports(request.file, request.source || '');
  } catch {
    origins = new Map();
  }
  // ONLY THE ALLOWED ORIGINS ARE DE-DUPLICATED AWAY. A function defined in a file the
  // gate refuses is deliberately left IN, so it reaches the loop below and is skipped
  // there BY NAME. Seeding it here too would make the refusal unreachable — a guard
  // nothing can arrive at is a guard nothing checks, and the census would go on
  // saying nothing about a function the tool declined to run.
  const inherited = new Set();
  for (const [fn, refusal] of origins) if (!refusal) inherited.add(fn);
  // THE MODULE'S OWN SHAPE, read once. A function's free names resolve in a scope
  // `functionRefusal` cannot see, and this is that scope. `null` when the source could
  // not be read, and every function is then refused rather than probed on a guess.
  const mod = moduleBindings(request.source || '', request.file);
  // FOLLOWING AN IMPORT NEEDS THE FILESYSTEM, which is why the resolver is built here
  // and not inside the gate. `sameness.js` answers from text alone and stays testable
  // that way; this hands it the one thing it cannot go and get.
  //
  // ONLY RELATIVE SPECIFIERS ARE FOLLOWED. A bare specifier is somebody else's package
  // — resolving it means walking `node_modules` and reasoning about `exports` maps, and
  // guessing wrong there is a probed function reaching a real side effect. It refuses
  // instead, and the census says which name did it.
  const resolveCache = new Map();
  const resolveImport = (spec, fromId) => {
    if (!spec || !spec.startsWith('.') || !fromId) return null;
    const key = `${path.dirname(fromId)}\u0000${spec}`;
    if (resolveCache.has(key)) return resolveCache.get(key);
    let answer = null;
    const target = path.resolve(path.dirname(fromId), spec);
    for (const candidate of [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`,
      path.join(target, 'index.js')]) {
      let text;
      try {
        text = readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
      // The bytes that were READ are the bytes that get judged, and the question asked
      // of them is the one `collect` asks: would this module have been loaded at all?
      const refusal = loadRefusal(text);
      answer = refusal
        ? { refusal }
        : { mod: moduleBindings(text, candidate) };
      break;
    }
    resolveCache.set(key, answer);
    return answer;
  };
  const found = exportedFunctions(namespace, inherited);
  // THE ROSTER FIRST, so a function that never answers can be told from one that was
  // never there. Without it a killed probe and an empty module look identical, and
  // "we found none" and "we never looked" are different claims.
  say({ roster: found.map(([name]) => name) });
  for (const [name, fn] of found) {
    // A MODULE THAT COULD NOT BE READ REFUSES EVERY FUNCTION IN IT. The call gate
    // resolves free names against this scope, so without it there is no gate — and a
    // file the lexer lost the thread on is the last one to probe on a guess.
    if (mod === null) {
      say({ entry: { name, skip: 'module scope could not be read' } });
      continue;
    }
    // THE DEFINING FILE'S REFUSAL, CHECKED BEFORE THE FUNCTION IS CALLED. Reaching a
    // function through a barrel must not launder the gate its own file failed; see
    // `dependencyExports`. A `skip` rather than a silent drop, because "we declined to
    // run this" and "there was nothing here" are the two claims this tool exists to
    // keep apart.
    const elsewhere = origins.get(fn);
    if (elsewhere) {
      say({ entry: { name, skip: `defined in a file that ${elsewhere}` } });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    say({
      entry: await probeFunction(fn, name, request.ladders, request.cross === true,
        mod,
        // A request from an older caller carries no budget; the shared default is
        // then the same number it would have read from this module anyway.
        typeof request.perInput === 'number' ? request.perInput : PER_INPUT_MS,
        resolveImport),
    });
  }
}

// Only run when invoked as a program. Imported by the tests, which call the pieces
// directly rather than through a pipe.
//
// IT EXITS RATHER THAN WAITING FOR THE EVENT LOOP TO DRAIN, and that is the larger
// half of what made probing cost what it did. Node keeps a process alive while any
// handle is open, and the handles here belong to the code under test: a module that
// opens a pool, a socket or an interval AT IMPORT TIME keeps this child alive long
// after it has written its last answer. Every such file then cost the full wall
// timeout — twenty seconds of idle waiting for work that had finished in a fraction
// of a second, and on one real tree seventeen minutes over a directory of controllers.
//
// This is not an async problem and never was: a file of ordinary synchronous functions
// pays it too, as long as its module opened something on the way in. Answers travel by
// `writeSync`, so they are on the wire before this runs and nothing is truncated.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      // A failure here is the probe's own, not the probed code's, and saying nothing
      // would reach the parent as `silent` — a reason that names nothing.
      say({ error: `probe crashed (${(err && err.message) || err})`.slice(0, 120) });
      process.exit(0);
    },
  );
}
