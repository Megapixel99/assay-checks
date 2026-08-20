"""The probe subprocess: stdin JSON in, stdout JSON out. Never imports a tree.

Isolated in its own process for three reasons, all of which have teeth:

  * A probed function can loop forever. A per-input alarm turns that into an outcome
    rather than a hang, and the parent's wall timeout backstops the alarm.
  * A probed function can exhaust the stack or the heap. A dead child is a `look`; a
    dead parent is a tool that cannot report anything at all.
  * The namespace it builds must contain only what was gated. Executing in the parent
    would put the caller's imports within reach of the code being probed.

It executes a PREAMBLE and one function's source, both assembled by the caller from
material that has already passed the purity gate. It never imports the module the
function came from, because an import runs whatever that file does at import time.
"""

import ast
import json
import os
import sys

try:
    from .sameness import outcome_of
except ImportError:                                       # pragma: no cover
    # Run as a plain file path rather than `-m assay.worker`, so the parent process
    # does not have to know whether the package is installed or merely on the path.
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from assay.sameness import outcome_of

RECURSION_LIMIT = 300


def run(request, out=None):
    """Probe one function over its ladder. Returns the list of outcome strings."""
    namespace = {}
    source = request["preamble"] + "\n" + request["source"]
    exec(compile(source, "<assay-probe>", "exec"), namespace)   # noqa: S102
    fn = namespace[request["name"]]
    per_input = request.get("per_input") or 0

    alarm = signal = None
    try:
        import signal as signal_module
        signal = signal_module

        def _timed_out(*_args):
            raise TimeoutError("per-input limit")

        signal.signal(signal.SIGALRM, _timed_out)
        alarm = signal.setitimer
    except (ImportError, AttributeError, ValueError):     # pragma: no cover
        alarm = None                                      # no SIGALRM on this platform

    sys.setrecursionlimit(RECURSION_LIMIT)
    outcomes = []
    for src in request["inputs"]:
        args = ast.literal_eval(src)
        if alarm:
            alarm(signal.ITIMER_REAL, per_input)
        try:
            outcomes.append(outcome_of(fn, args))
        finally:
            if alarm:
                alarm(signal.ITIMER_REAL, 0)
    if out is not None:
        json.dump({"outcomes": outcomes}, out)
    return outcomes


def main():
    run(json.load(sys.stdin), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
