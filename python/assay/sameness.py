"""Do two functions answer the same question? Decided by EXECUTION.

A property suite is per-artifact and behavioural. Duplication is cross-artifact and
structural. Two implementations that both pass are two implementations that both pass,
and no amount of testing either one tells you the other exists. Correctness was never
the question duplication asks.

The usual instrument for comparing two implementations is a differential test, and it
works — but you have to know which two to compare. The pairing is declared, so it only
ever covers pairs somebody already suspected. This finds them instead.

HOW. Every comparable function is probed ONCE against one deterministic ladder of
inputs, producing an OUTCOME VECTOR. Two functions are candidates for being the same
function exactly when their vectors match — so discovery is a hash bucket rather than
a quadratic sweep, and the decider is execution rather than text. NAMES ARE NEVER
READ, which is the point: a textual or name-based detector cannot pair `isWordy` with
`_word`, and those turned out to be one function with two names.

THREE VERDICTS, and they are never mixed:

  differs   a WITNESS input on which the two disagree. This is the only verdict that
            is proof, and it is proof of DIFFERENCE, never of correctness.
  same      no input in the ladder told them apart, AND the ladder discriminated. It
            means "nothing here told them apart" — never "equivalent".
  look      could not be decided: not safely executable, no ladder for the shape, or
            the probe was vacuous.

THE VACUOUS-PROBE GUARD IS THE LOAD-BEARING PART. Two functions that raise TypeError
on every input agree perfectly, and so do two that return the same constant. Without
the guard, a scan of any codebase reports every one-argument function as everyone
else's twin. `discriminating()` therefore requires at least two DISTINCT RETURNED
VALUES, and rejects a vector that is a PROJECTION — a function handing back one of its
own arguments. Both halves exist because both mistakes were made:

  * Counting distinct OUTCOMES is not enough. One returned value plus one exception is
    two distinct outcomes, so a keyword predicate that returns False for every string
    in the ladder and raises on everything else satisfies it — the counting rewards a
    probe that found the function's TYPE ERRORS and never reached its behaviour.
  * Comparing whole vectors against the identity is not enough. A transform whose
    vocabulary the ladder lacks is the identity wherever it answers and raises
    everywhere else, so its vector differs from the projection at exactly the
    positions where the function refused to run. The question is about the positions
    where it ANSWERED.

The general form: a round trip is necessary and not sufficient, because an identity
program passes it.

TWO VECTORS ARE ONLY EVER COMPARED WHEN THEY CAME FROM THE SAME LADDER. Every vector
carries its `ladder_key`, and `compare()` refuses a mismatch rather than zipping two
different probes together. That branch is not defensive dressing: comparing a new
answer against the wrong earlier answer is precisely the defect a difference checker
exists to catch, and a comparer that can do it silently has the defect it audits for.

WHAT IT WILL RUN, stated because it runs your code. Only functions that pass
`purity()`: no I/O, no network, no clock, no randomness, no global mutation, no
generators, no methods, no decorators. Free names resolve ONLY from the same file's
literal constants, other functions in that file that also pass the gate, and a stdlib
allowlist of side-effect-free imports. Nothing else is imported and THE CONTAINING
MODULE IS NEVER IMPORTED — an import runs whatever the file does at import time, which
is the one thing this must not do. Everything else is `look`, with the reason named
and counted, because "we found none" and "we never looked" are different claims.
"""

import ast
import asyncio
import functools
import builtins
import hashlib
import inspect
import json
import os
import subprocess
import sys

from .verdicts import Report

MAX_PAIRS_PER_INPUT = 40      # stride sample of the cartesian product, per arity
MAX_ARITY = 3                 # above this there is no ladder; the shape is `look`
MIN_DISTINCT = 2              # distinct RETURNED values (see `discriminating`)
REPR_INLINE = 200             # longer values are compared by hash, never truncated
PROBE_TIMEOUT = 20            # seconds for one function's whole ladder
PER_INPUT_SECONDS = 1         # SIGALRM inside the worker, where available
HELPER_DEPTH = 3              # how far a free name may resolve into sibling functions
LADDER_VERSION = "v3"
# What a snippet read from stdin is called. It collides with nothing a
# tree can contain, so `search` excluding the query by REFERENCE needs no
# special case for it.
SNIPPET_PATH = "<stdin>"

# IMPORTS WITH NO SIDE EFFECT AND NO AMBIENT STATE. `random` and `time` are absent on
# purpose: both import cleanly and both make a function's outcome depend on something
# the ladder does not control, so a `differs` from either would be noise and a `same`
# would be luck.
ALLOWED_IMPORTS = frozenset("""
math re string itertools functools collections json decimal fractions
textwrap unicodedata operator heapq bisect statistics hashlib base64
binascii struct copy enum dataclasses typing numbers array types abc
""".split())

IMPURE_NAMES = frozenset("""
open input exec eval compile __import__ breakpoint exit quit globals locals vars
memoryview
""".split())

IMPURE_MODULES = frozenset("""
os sys subprocess socket shutil urllib requests random time datetime calendar
threading multiprocessing asyncio pathlib tempfile http sqlite3 pickle shelve
ctypes signal atexit io secrets uuid logging argparse platform getpass webbrowser
inspect gc resource select ssl smtplib ftplib email sched queue
""".split())

SKIP_DIRS = {"node_modules", "__pycache__", "venv", ".venv", "dist", "build"}


class Func:
    """One candidate: a module-level, undecorated, non-generator function."""

    def __init__(self, path, node, module):
        self.path = path
        self.node = node
        self.name = node.name
        self.lineno = node.lineno
        self.module = module
        self.params = [a.arg for a in node.args.args]
        self.required = len(self.params) - len(node.args.defaults)

    @property
    def ref(self):
        rel = os.path.relpath(self.path)
        return "%s::%s" % (self.path if rel.startswith("..") else rel, self.name)

    def __repr__(self):                                       # pragma: no cover
        return "<Func %s>" % self.ref


class Module:
    """A parsed file: its functions, its literal constants, its import names."""

    def __init__(self, path, tree):
        self.path = path
        self.tree = tree
        self.imports = {}        # bound name -> root module it comes from
        self.import_stmts = {}   # bound name -> the source line to replay
        self.constants = {}      # bound name -> the source line to replay
        self.funcs = {}          # name -> Func
        for node in tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    bound = alias.asname or alias.name.split(".")[0]
                    self.imports[bound] = alias.name.split(".")[0]
                    self.import_stmts[bound] = "import %s%s" % (
                        alias.name, " as %s" % alias.asname if alias.asname else "")
            elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
                root = node.module.split(".")[0]
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    bound = alias.asname or alias.name
                    self.imports[bound] = root
                    self.import_stmts[bound] = "from %s import %s%s" % (
                        node.module, alias.name,
                        " as %s" % alias.asname if alias.asname else "")
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 \
                    and isinstance(node.targets[0], ast.Name):
                try:
                    ast.literal_eval(node.value)
                except (ValueError, SyntaxError, TypeError):
                    continue
                name = node.targets[0].id
                self.constants[name] = "%s = %s" % (name, ast.unparse(node.value))
            # BOTH forms, and an `async def` is NOT a subclass of the sync one. Missing
            # it did not refuse those functions, it never saw them: they appeared in no
            # count at all — not probed, not skipped, not in the census — so a file of
            # `async def` reported zero of everything, which reads as a clean sweep.
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.funcs[node.name] = Func(path, node, self)


def parse_source(text, path):
    """A Module built from source TEXT, or None if it does not parse.

    Split out from `parse` so a snippet that never became a file can be probed by the
    same machinery a file is. `path` is carried only for display: nothing here opens
    it, and for a snippet it is not a path at all.
    """
    try:
        return Module(path, ast.parse(text))
    except (SyntaxError, ValueError):
        return None


def parse(path):
    """A Module, or None if the file does not parse. Never imports anything."""
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return parse_source(text, path)


def python_files(paths):
    """Every .py under the given files/directories, sorted, deterministic."""
    out = []
    for target in paths:
        if os.path.isfile(target):
            out.append(os.path.abspath(target))
            continue
        for base, dirs, files in os.walk(target):
            dirs[:] = sorted(d for d in dirs
                             if not d.startswith(".") and d not in SKIP_DIRS)
            for name in sorted(files):
                if name.endswith(".py"):
                    out.append(os.path.abspath(os.path.join(base, name)))
    return sorted(set(out))


# --------------------------------------------------------------------------- #
# purity() — why a function may NOT be executed. A reason, or None.
# --------------------------------------------------------------------------- #

def _bound_names(node):
    """Every name the function body binds: params, assignments, comprehensions."""
    names = set(a.arg for a in node.args.args)
    names |= set(a.arg for a in node.args.kwonlyargs)
    for arg in (node.args.vararg, node.args.kwarg):
        if arg:
            names.add(arg.arg)
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and isinstance(sub.ctx, (ast.Store, ast.Del)):
            names.add(sub.id)
        elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(sub.name)
        elif isinstance(sub, ast.ExceptHandler) and sub.name:
            names.add(sub.name)
        elif isinstance(sub, (ast.Import, ast.ImportFrom)):
            for alias in sub.names:
                names.add(alias.asname or alias.name.split(".")[0])
    return names


def free_names(node):
    """Names the function READS and does not bind. Builtins are not free."""
    bound = _bound_names(node)
    known = set(dir(builtins))
    out = set()
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Load):
            if sub.id not in bound and sub.id not in known:
                out.add(sub.id)
    return out


def purity(func):
    """None if this function may be executed, else the reason it may not be.

    Every branch is a REFUSAL, not a guess. This executes code out of somebody's tree,
    so what it will run is enumerated rather than assumed safe.
    """
    node = func.node
    if node.decorator_list:
        return "decorated"
    if node.args.vararg or node.args.kwarg or node.args.kwonlyargs:
        return "star or keyword-only args"
    if func.params and func.params[0] in ("self", "cls"):
        return "method"
    if not func.params:
        return "no arguments (a ladder cannot discriminate)"
    if len(func.params) > MAX_ARITY:
        return "arity %d (no ladder above %d)" % (len(func.params), MAX_ARITY)
    for sub in ast.walk(node):
        if isinstance(sub, (ast.Global, ast.Nonlocal)):
            return "mutates module state"
        if isinstance(sub, (ast.Yield, ast.YieldFrom)):
            return "generator"
        # `await` is sequencing, not reach: an `async def` that only computes is as
        # pure as the `def` beside it, and `outcome_of` runs it to the value it settles
        # on. `async for` and `async with` are a different matter — both drive an
        # object's protocol methods, which is behaviour the ladder cannot supply.
        if isinstance(sub, (ast.AsyncFor, ast.AsyncWith)):
            return "async iteration"
        if isinstance(sub, ast.Name) and sub.id in IMPURE_NAMES:
            return "calls %s()" % sub.id
        if isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name):
            root = func.module.imports.get(sub.value.id, sub.value.id)
            if root in IMPURE_MODULES:
                return "touches %s" % root
        if isinstance(sub, (ast.Import, ast.ImportFrom)):
            for alias in sub.names:
                root = (alias.name if isinstance(sub, ast.Import)
                        else (sub.module or "")).split(".")[0]
                if root not in ALLOWED_IMPORTS:
                    return "imports %s" % (root or "relatively")
    return None


def preamble_for(func, depth=HELPER_DEPTH, seen=None):
    """Source that must run before this function, or (None, reason)."""
    seen = seen if seen is not None else set()
    if func.name in seen:
        return "", None
    seen.add(func.name)
    lines, mod = [], func.module
    for name in sorted(free_names(func.node)):
        if name in mod.imports:
            root = mod.imports[name]
            if root not in ALLOWED_IMPORTS:
                return None, "needs %s" % root
            lines.append(mod.import_stmts[name])
        elif name in mod.constants:
            lines.append(mod.constants[name])
        elif name in mod.funcs:
            if depth <= 0:
                return None, "helper chain deeper than %d" % HELPER_DEPTH
            helper = mod.funcs[name]
            why = purity(helper)
            if why:
                return None, "helper %s: %s" % (name, why)
            sub, reason = preamble_for(helper, depth - 1, seen)
            if sub is None:
                return None, reason
            lines.append(sub)
            lines.append(ast.unparse(helper.node))
        else:
            return None, "free name %s" % name
    return "\n".join(x for x in lines if x), None


# --------------------------------------------------------------------------- #
# The ladder. Deterministic, shared by every function of the same arity, so two
# vectors are comparable by construction.
# --------------------------------------------------------------------------- #
# Hand-written rather than random: two runs must be byte-identical, and a seeded RNG
# makes the ladder a function of the seed rather than of the question. Values cover the
# shapes ordinary code takes, plus the EMPTY case of each — the empty case is where two
# implementations of one function most often stop agreeing.
BASE_VALUES = [
    "0", "1", "2", "-1", "7", "255",
    "3.5", "-0.5",
    "True", "False", "None",
    "''", "'a'", "'abc'", "'Hello, World!'", "'ATTACK AT DAWN, at dawn!'",
    "'  padded  '", "'10'", "'aeiou'",
    # Ask what characters your inputs NEVER contain, then add them. Without these
    # three, a predicate written as `isalpha() or _ or isdigit()` and one written as
    # `isalnum() or _` agree on every value in the ladder — and they are not the same
    # function, because `isalnum` is a strict superset that also covers numerics.
    # One character turned that `same` into a `differs` with a witness.
    "'\\u00bd'", "'\\u00e9'", "'\\t\\n'",
    "[]", "[1, 2, 3]", "[3, 1, 2]", "['a', 'b']",
    "()", "(1, 2)",
    "{}", "{'a': 1}", "{'a': 1, 'b': 2}",
]


def ladder(arity):
    """The input tuples for `arity`, as source strings. Deterministic and shared."""
    if arity == 1:
        return ["(%s,)" % v for v in BASE_VALUES]
    n = len(BASE_VALUES)
    combos = []
    # A stride walk rather than the full product: the product at arity 3 is tens of
    # thousands of cells, and a probe nobody waits for is a probe nobody runs. The walk
    # is fixed, so every function of this arity sees the identical list.
    for i in range(MAX_PAIRS_PER_INPUT):
        idx = [(i * (k + 1) + k * 5) % n for k in range(arity)]
        combos.append("(%s,)" % ", ".join(BASE_VALUES[j] for j in idx))
    for i in range(n):                       # plus the diagonal, for symmetry cases
        combos.append("(%s,)" % ", ".join([BASE_VALUES[i]] * arity))
    seen, out = set(), []
    for combo in combos:
        if combo not in seen:
            seen.add(combo)
            out.append(combo)
    return out


def ladder_key(func):
    """What makes two vectors comparable. Carried on every vector and CHECKED."""
    return "arity%d/%s" % (len(func.params), LADDER_VERSION)


# --------------------------------------------------------------------------- #
# probe() — run one function over the ladder in a subprocess.
# --------------------------------------------------------------------------- #

def probe(func, python=None):
    """(vector, None) or (None, reason). A vector is a list of outcome strings.

    One subprocess per FUNCTION, not per pair: n probes and then a hash bucket, rather
    than n-squared executions.
    """
    why = purity(func)
    if why:
        return None, why
    pre, why = preamble_for(func)
    if pre is None:
        return None, why
    inputs = ladder(len(func.params))
    payload = {"preamble": pre, "source": ast.unparse(func.node),
               "name": func.name, "inputs": inputs,
               "per_input": PER_INPUT_SECONDS}
    worker_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.py")
    try:
        proc = subprocess.run([python or sys.executable, worker_path],
                              input=json.dumps(payload), capture_output=True,
                              text=True, timeout=PROBE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, "probe timed out"
    if proc.returncode != 0:
        tail = (proc.stderr.strip().splitlines() or ["silent"])[-1][:70]
        return None, "probe failed (%s)" % tail
    try:
        return json.loads(proc.stdout)["outcomes"], None
    except (ValueError, KeyError):
        return None, "probe returned nothing readable"


def canon(value, _depth=0):
    """A stable, order-insensitive rendering. Longer than REPR_INLINE -> a hash.

    Dicts and sets are sorted so that two implementations differing only in insertion
    order are not reported as differing. Floats keep their exact repr: a floating-point
    difference IS a difference, and rounding it away would be the tool deciding the
    thing it exists to report.
    """
    if _depth > 6:
        return "..."
    if isinstance(value, dict):
        body = ", ".join("%s: %s" % (canon(k, _depth + 1), canon(v, _depth + 1))
                         for k, v in sorted(value.items(), key=lambda kv: repr(kv[0])))
        return "{%s}" % body
    if isinstance(value, (set, frozenset)):
        return "{%s}" % ", ".join(sorted(canon(v, _depth + 1) for v in value))
    if isinstance(value, list):
        return "[%s]" % ", ".join(canon(v, _depth + 1) for v in value)
    if isinstance(value, tuple):
        return "(%s)" % ", ".join(canon(v, _depth + 1) for v in value)
    return repr(value)


def outcome_of(fn, args):
    """'V:<canon>' | 'V#<sha1>' | 'E:<ExcType>'. Exception TYPE, never its message.

    Messages legitimately differ between two correct implementations of one function —
    they carry the function's own name — so comparing them would make every pair
    `differs` and the tool useless, in the way that looks most like working correctly.

    A COROUTINE IS RUN TO THE VALUE IT SETTLES ON. `async def f(x): return x * 2` and
    `def g(x): return x * 2` answer the same question, and reading the coroutine object
    instead of its result makes the first unprobeable — which put every `async def` in a
    modern codebase permanently out of reach. A raise inside the coroutine is the same
    outcome as a raise outside one, by type and never by message, for the same reason
    every other outcome here is.

    Unlike the JavaScript half, this needs no second entry point: `asyncio.run` is
    callable from synchronous code, so awaiting does not turn every caller into a
    coroutine the way `await` would there.
    """
    try:
        value = fn(*args)
        if inspect.iscoroutine(value):
            value = asyncio.run(value)
    except BaseException as exc:                              # noqa: BLE001
        return "E:%s" % type(exc).__name__
    text = canon(value)
    if len(text) > REPR_INLINE:
        return "V#%s" % hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
    return "V:%s" % text


# --------------------------------------------------------------------------- #
# The decisions.
# --------------------------------------------------------------------------- #

def projections(inputs):
    """For each parameter, the vectors a function that does NOTHING WITH IT gives.

    Returning the argument is the obvious one. COPYING it is the same emptiness wearing
    a different shape, and it was measured on a real tree: two unrelated query-param
    transforms, one renaming keys and one splitting a `sort` value, agreed on every rung
    because the ladder holds no key either of them recognises — so both degraded to
    "copy the mapping through" and were reported as the same function. A copy is not
    behaviour the ladder reached; it is behaviour the ladder missed.

    ONLY the mapping copy, not a sequence one. Rejecting too much is safe in the sense
    that costs a `look` rather than a wrong finding — but it is still coverage spent,
    and `list(d)` would swallow honest functions like `sorted`. The measured defect was
    object-to-object; that is what this rejects.
    """
    out = []
    # `dict` UNGUARDED, because the point is to mirror what the function under test
    # does — `dict(q)` answers `{}` for an empty list and raises for an int, and a
    # candidate that raised where the real one answered would never match it.
    vacuous = (
        lambda *a, _i=0: a[_i],
        lambda *a, _i=0: dict(a[_i]),
    )
    for i in range(len(ast.literal_eval(inputs[0])) if inputs else 0):
        for make in vacuous:
            fn = functools.partial(make, _i=i)
            out.append([outcome_of(fn, ast.literal_eval(src)) for src in inputs])
    return out


def is_projection(vector, inputs):
    """Is this vector a projection ON EVERY INPUT IT ANSWERED?

    Comparing whole vectors is not enough: a transform whose vocabulary the ladder
    lacks raises on every non-string, so its vector differs from the projection at
    exactly the positions where the function refused to run. The question is about the
    positions where it DID run — everywhere it answered, did it hand back one of its
    arguments?
    """
    live = [i for i, o in enumerate(vector) if not o.startswith("E:")]
    if not live:
        return True
    for proj in projections(inputs):
        if all(vector[i] == proj[i] for i in live):
            return True
    return False


def discriminating(vector, inputs=None):
    """Did this ladder tell this function apart from a constant? (counts, or None.)

    THERE IS ONE THRESHOLD, NOT TWO, and a mutation runner is why. An earlier version
    also carried a minimum count of returned values, and no mutation of it could ever
    be caught: `len(set(returned)) >= 2` already implies `len(returned) >= 2`, so the
    second constant could take any value at or below the first without changing a
    single verdict. Two constants answering one question, inside the tool written to
    find that shape.

    THE DISTINCT COUNT IS OVER RETURNED VALUES, NOT OVER OUTCOMES. Two distinct
    outcomes is satisfied by one return plus one exception, which rewards a probe that
    found the function's type errors and never reached its behaviour.
    """
    returned = [o for o in vector if not o.startswith("E:")]
    distinct = len(set(returned))
    if distinct < MIN_DISTINCT:
        return None
    if inputs and is_projection(vector, inputs):
        return None
    return (len(returned), distinct)


def compare(a_vec, b_vec, a_key, b_key, inputs):
    """('same'|'differs'|'look', detail). Refuses two vectors from different ladders."""
    if a_key != b_key:
        return "look", "not comparable: %s vs %s" % (a_key, b_key)
    if len(a_vec) != len(b_vec) or len(a_vec) != len(inputs):
        return "look", "vector length disagrees with the ladder"
    for i, (x, y) in enumerate(zip(a_vec, b_vec)):
        if x != y:
            return "differs", "%s -> %s vs %s" % (inputs[i], x, y)
    if discriminating(a_vec, inputs) is None:
        return "look", "not discriminated by the ladder"
    return "same", "no input in %d told them apart" % len(inputs)


class Scan:
    """What a scan found. Held as data so callers can read it without stdout."""

    def __init__(self):
        self.probed = {}         # ref -> vector
        self.keys = {}           # ref -> ladder key
        self.skipped = {}        # ref -> reason        (FUNCTIONS)
        self.unloadable = {}     # path -> reason       (FILES)
        self.groups = []         # [[ref, ...]] — same-answer candidates
        self.files = 0
        self.functions = 0

    @staticmethod
    def _tally(reasons):
        counts = {}
        for why in reasons:
            key = why.split("(")[0].split(":")[0].strip()
            counts[key] = counts.get(key, 0) + 1
        return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    def census(self):
        """Reasons FUNCTIONS were not probed. Never a finding, always shown."""
        return self._tally(self.skipped.values())

    def to_dict(self):
        """The census as data, so a consumer never has to parse the printed equation.

        `probed + not_probed` equals `functions`, and FILES ARE A SEPARATE POPULATION:
        a file nobody opened holds an unknown number of functions, so adding the two
        totals together prints a number nobody measured. Both halves are here with
        their own totals, which is what makes that checkable rather than stated.
        """
        return {
            "files": self.files,
            "unloadable": dict(self.file_census()),
            "functions": self.functions,
            "probed": len(self.probed),
            "not_probed": len(self.skipped),
            "skipped": dict(self.census()),
        }

    def file_census(self):
        """Reasons a FILE was never opened — a different population, kept apart.

        A file that does not parse used to be dropped before `files` was even
        incremented, so it appeared in no number at all and a directory of broken
        files reported zero of everything. That reads exactly like a clean sweep.
        """
        return self._tally(self.unloadable.values())


def collect(paths, python=None, scan=None):
    """Probe every function under `paths`. Returns a Scan."""
    out = scan or Scan()
    for path in python_files(paths):
        out.files += 1
        mod = parse(path)
        if mod is None:
            out.unloadable[path] = "could not parse"
            continue
        for name in sorted(mod.funcs):
            func = mod.funcs[name]
            out.functions += 1
            vector, why = probe(func, python)
            if vector is None:
                out.skipped[func.ref] = why
                continue
            if discriminating(vector, ladder(len(func.params))) is None:
                out.skipped[func.ref] = "not discriminated by the ladder"
                continue
            out.probed[func.ref] = vector
            out.keys[func.ref] = ladder_key(func)
    return out


def group(scan):
    """Bucket probed functions by (ladder key, outcome vector). Sets scan.groups."""
    buckets = {}
    for ref, vector in scan.probed.items():
        buckets.setdefault((scan.keys[ref], tuple(vector)), []).append(ref)
    scan.groups = sorted((sorted(v) for v in buckets.values() if len(v) > 1),
                         key=lambda g: g[0])
    return scan.groups


def resolve(ref):
    """'file.py::name' -> Func, or None."""
    if "::" not in ref:
        return None
    path, _, name = ref.rpartition("::")
    mod = parse(path)
    return mod.funcs.get(name) if mod else None


def resolve_source(text, name=None):
    """A snippet on its way to being written -> (Func, None) or (None, reason).

    A SNIPPET IS PARSED AS A MODULE, not as a function, because a function alone
    cannot carry what it needs: `preamble_for` resolves free names from the file's own
    constants, its other gated functions and the stdlib allowlist, and a bare `def`
    has none of those. So the text may hold the imports and helpers the function
    depends on, exactly as the file it is about to become would.

    WHICH FUNCTION IS NEVER GUESSED. One definition is unambiguous; several without
    `name` is a question this cannot answer, and picking the last one would make the
    tool answer about code nobody asked about. That is a refusal, not a default.
    """
    mod = parse_source(text, SNIPPET_PATH)
    if mod is None:
        return None, "the snippet does not parse"
    if not mod.funcs:
        return None, "the snippet defines no top-level function"
    if name is not None:
        func = mod.funcs.get(name)
        if func is None:
            return None, ("the snippet defines no function named %s (it defines %s)"
                          % (name, ", ".join(sorted(mod.funcs))))
        return func, None
    if len(mod.funcs) > 1:
        return None, ("the snippet defines %d functions (%s) — name one with --name"
                      % (len(mod.funcs), ", ".join(sorted(mod.funcs))))
    return next(iter(mod.funcs.values())), None


def report_scan(scan, report=None):
    """A Scan rendered into the shared verdict vocabulary.

    A `same` group is a FINDING: something a person must read. It is not an assertion
    that the duplication is wrong — only one flavour of duplication is a defect, and
    telling them apart is a judgment about what the two pieces of code are FOR, which
    no execution can make.
    """
    rep = report or Report()
    for grp in scan.groups:
        rep.finding("same answer (%s): %s" % (scan.keys[grp[0]], ", ".join(grp)),
                    grp[0],
                    "no input in the ladder told them apart — READ them; only a "
                    "person decides whether the duplication is a defect")
    rep.note("\n%d files, %d not loaded" % (scan.files, len(scan.unloadable)))
    for why, count in scan.file_census():
        rep.note("  %-44s %d" % (why, count))
    rep.note("%d functions, %d probed, %d not probed"
             % (scan.functions, len(scan.probed), len(scan.skipped)))
    for why, count in scan.census():
        rep.note("  %-44s %d" % (why, count))
    rep.note("  (a not-probed function is a `look`, never a finding — "
             "\"we found none\" and \"we never looked\" are different claims)")
    return rep
