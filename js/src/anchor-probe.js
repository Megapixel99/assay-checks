/**
 * The anchor-table subprocess: a path in, one JSON line on fd 3, out.
 *
 * IT IMPORTS THE HARNESS, and that is the whole difference from the Python half.
 * There, `ast` lifts the table out of the source and nothing is executed; here the
 * table is a JavaScript value and reading it as data means the module that builds it
 * has to have run. A regex over source was the alternative and it is worse: a regex
 * cannot tell a label from an anchor, and a check reporting confident nonsense about
 * which strings are anchors is worse than the gap it fills.
 *
 * TWO THINGS MAKE THAT AFFORDABLE, and they are requirements on the harness rather
 * than tricks here:
 *
 *   1. The table is EXPORTED — `export const MUTATIONS = [...]`. Reading it is then a
 *      property access, with no parser and no approximation anywhere in the path.
 *   2. The harness guards its own `main()` behind the entry-point check every
 *      JavaScript program in this package already carries, so importing it defines
 *      the table and runs nothing else.
 *
 * The residue is stated rather than hidden: a harness that does work at IMPORT time
 * will do that work. This runs in a child process, so a crash or a hang costs the
 * probe rather than the audit — but a harness that mutates the tree on the way in
 * mutates the tree, and no child process undoes that. If yours does, `anchor_exempt`
 * is the table for saying so, with the reason.
 *
 * The answer travels on fd 3 rather than stdout for the reason every other answer in
 * this package does: the module being imported is free to print, and an answer sharing
 * a channel with arbitrary output is an answer that output can destroy.
 */

import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ANSWER_FD } from './sameness.js';

/** One JSON line on fd 3. `writeSync` loops because a pipe may accept a partial write. */
function say(payload) {
  const buf = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(ANSWER_FD, buf, off, buf.length - off);
}

/**
 * Every exported table whose name says it is one, flattened, in name order.
 *
 * `MUTATIONS`, `MUTATIONS_JS`, `MUTATION_TABLE` — the same rule the Python half uses
 * on assignment targets, so a harness renaming its table is read by both halves or by
 * neither. Sorted so two runs of the same file produce the same list.
 */
export function tablesIn(namespace) {
  const names = Object.keys(namespace)
    .filter((name) => name.toUpperCase().startsWith('MUTATION'))
    .sort();
  const out = [];
  for (const name of names) {
    if (Array.isArray(namespace[name])) out.push(...namespace[name]);
  }
  return { named: names.length > 0, entries: out };
}

/**
 * Each entry reduced to its STRINGS, in order, and nothing else crosses the pipe.
 *
 * An entry is free to carry a function, a regexp or an object; none of those is an
 * anchor, none of them survives `JSON.stringify` intact, and sending a mangled version
 * of one would be data this audit invented. The strings are the whole of what the rule
 * is about — see `anchorsOf` for why the ANCHOR is the second-to-last of them.
 */
export function stringsOf(entries) {
  return entries
    .filter((entry) => Array.isArray(entry))
    .map((entry) => entry.filter((cell) => typeof cell === 'string'));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { file } = JSON.parse(raw);
  let namespace;
  try {
    namespace = await import(pathToFileURL(file).href);
  } catch (err) {
    say({ error: `could not import (${(err && err.message) || err})`.slice(0, 140) });
    return;
  }
  const { named, entries } = tablesIn(namespace);
  // ABSENT AND EMPTY ARE DIFFERENT CLAIMS. A harness that exports no table has not
  // opted into being read this way and is a `look`; one that exports an empty table
  // has, and zero anchors is a fact about it.
  if (!named) { say({ absent: true }); return; }
  say({ table: stringsOf(entries) });
}

// Only when invoked as a program. The tests call the pieces directly.
//
// IT EXITS RATHER THAN WAITING FOR THE EVENT LOOP TO DRAIN, for the reason `probe.js`
// does: the handles belong to the code that was just imported, and a harness that
// opened one on the way in would otherwise hold this child to the wall timeout. The
// answer is written with `writeSync`, so it is on the wire before this runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (err) => {
      // A failure here is the probe's own, not the harness's, and saying nothing would
      // reach the parent as `silent` — a reason that names nothing.
      say({ error: `probe crashed (${(err && err.message) || err})`.slice(0, 140) });
      process.exit(0);
    },
  );
}
