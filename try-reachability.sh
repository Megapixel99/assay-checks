#!/bin/sh
# Exercise the reachability gate by hand. Run from the repo root.
#
#   sh try-reachability.sh          the three cases that motivated it
#   sh try-reachability.sh DIR      before/after on a tree of your own
#
# `before` is whatever is committed at HEAD, extracted to a temp dir, so the comparison
# is against the shipped gate rather than against a description of it.
set -e
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
git archive HEAD | tar -x -C "$W"

if [ -n "$1" ]; then
  echo "=== BEFORE (HEAD $(git rev-parse --short HEAD)) ==="
  node "$W/js/src/cli.js" scan "$1" 2>&1 | sed -n '/files,/,/never looked/p'
  echo "=== AFTER (working tree) ==="
  node js/src/cli.js scan "$1" 2>&1 | sed -n '/files,/,/never looked/p'
  exit 0
fi

F="$W/fixtures"; mkdir -p "$F"; echo '{"type":"commonjs"}' > "$F/package.json"

echo "--- 1. a barrel: one clock helper used to refuse every pure helper beside it"
cat > "$F/helpers.js" <<'JS'
function sizeHuman(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
function formatBytes(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
function formatDate(v) { return new Date(v).toISOString(); }
module.exports = { sizeHuman, formatBytes, formatDate };
JS
echo "  BEFORE:"; node "$W/js/src/cli.js" scan "$F/helpers.js" 2>&1 | sed -n '/files,/,/never looked/p' | sed 's/^/    /'
echo "  AFTER:";  node js/src/cli.js scan "$F/helpers.js" 2>&1 | sed -n '/files,/,/never looked/p' | sed 's/^/    /'

echo
echo "--- 2. a clean body reaching an impure helper BY FREE NAME (must not be probed)"
cat > "$F/transitive.js" <<'JS'
function slugA(s) { return stamp(s); }
function slugB(s) { return stamp(s); }
function stamp(s) {
  require('fs').writeFileSync('/tmp/assay-escape-proof.txt', String(s));
  return String(s).toLowerCase();
}
module.exports = { slugA, slugB };
JS
rm -f /tmp/assay-escape-proof.txt
node js/src/cli.js scan "$F/transitive.js" 2>&1 | sed -n '/files,/,/never looked/p' | sed 's/^/    /'
echo "    wrote a file? $([ -f /tmp/assay-escape-proof.txt ] && echo 'YES — the gate failed' || echo no)"

echo
echo "--- 3. calling an IMPORTED impure function (a hole that is open at HEAD)"
mkdir -p "$F/x"; echo '{"type":"module"}' > "$F/x/package.json"
cat > "$F/x/io.js" <<'JS'
import { writeFileSync } from 'node:fs';
export function writeIt(x) { writeFileSync('/tmp/assay-xfile-proof.txt', String(x)); return String(x); }
JS
cat > "$F/x/main.js" <<'JS'
import { writeIt } from './io.js';
export function saveA(x) { return writeIt(x); }
export function saveB(x) { return writeIt(x); }
JS
rm -f /tmp/assay-xfile-proof.txt
echo "  BEFORE:"; node "$W/js/src/cli.js" scan "$F/x" >/dev/null 2>&1 || true
echo "    wrote a file? $([ -f /tmp/assay-xfile-proof.txt ] && echo 'YES — probing called it' || echo no)"
rm -f /tmp/assay-xfile-proof.txt
echo "  AFTER:"; node js/src/cli.js scan "$F/x" 2>&1 | sed -n '/files,/,/never looked/p' | sed 's/^/    /'
echo "    wrote a file? $([ -f /tmp/assay-xfile-proof.txt ] && echo 'YES — the gate failed' || echo no)"
