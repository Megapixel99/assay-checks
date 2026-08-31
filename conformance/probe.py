#!/usr/bin/env python3
"""Watch a mutation-testing run from outside it, and interrupt it at the worst moment.

Runs INSIDE the framework's container, in the fixture tree, with nothing but the
standard library. It hashes the tree, starts the framework in its own process
group, polls until a source file is observably mutated ON DISK, delivers a signal
at that instant, and hashes the tree again.

The instant matters. A blind timeout can land between two mutants, where every
framework looks clean; landing it while a mutant is applied is the case the
harness cannot defend against and the invoker has to. Killing on the observation
rather than on a stopwatch removes "you got unlucky with timing" as an answer in
either direction -- if the tree is never observed mutated, that is reported as
what it is, and no signal is credited with having kept it clean.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import signal
import subprocess
import sys
import time

POLL = 0.05  # seconds between tree reads
GRACE = 0.5  # seconds to let a killed process group stop writing before the last hash

# Never counted as tree state: the framework's own installation and VCS internals.
# Anything else a run leaves behind is a finding, not noise.
PRUNE_DIRS = {".git", "__pycache__", "node_modules", ".venv"}


def walk(root, prune=PRUNE_DIRS):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in prune)
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            yield os.path.relpath(full, root)


def digest(path):
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(65536), b""):
                h.update(block)
    except OSError:
        return "UNREADABLE"
    return h.hexdigest()


def snapshot(root):
    return {rel: digest(os.path.join(root, rel)) for rel in walk(root)}


def watched(snap, patterns):
    return {
        rel: h
        for rel, h in snap.items()
        if any(fnmatch.fnmatch(rel, p) for p in patterns)
    }


def diff(before, after):
    """What the run did to the tree, in the three categories that mean different things."""
    return {
        "modified": sorted(k for k in before if k in after and before[k] != after[k]),
        "deleted": sorted(k for k in before if k not in after),
        "added": sorted(k for k in after if k not in before),
    }


def deliver(proc, sig, target):
    """Signal the whole process group, or only the process we started.

    Both are real. A CI cancel and a Ctrl-C reach the group; `timeout` and
    `subprocess.run(..., timeout=...)` reach the leader alone. A framework that
    unwinds correctly when its leader is asked to stop, and leaves the tree
    mutated when its worker is, has told you something specific -- and a report
    that only ever signalled one of the two could not say which had happened.
    """
    try:
        if target == "group":
            os.killpg(os.getpgid(proc.pid), sig)
        else:
            proc.send_signal(sig)
    except (ProcessLookupError, PermissionError):
        pass


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def run(args):
    root = os.path.abspath(args.root)
    pristine = snapshot(root)
    pristine_src = watched(pristine, args.watch)
    if not pristine_src:
        return {
            "label": args.label,
            "error": "no file under %s matched --watch %s; the probe would be "
            "watching nothing" % (root, args.watch),
        }

    started = time.monotonic()
    proc = subprocess.Popen(
        args.command,
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,  # its own process group, so a signal reaches children
    )
    pgid = os.getpgid(proc.pid)

    signalled = None   # what we delivered, when, and why
    in_place = None    # first on-disk mutation seen, whether or not we act on it
    polls = 0

    while True:
        elapsed = time.monotonic() - started
        if proc.poll() is not None:
            break

        current = watched(snapshot(root), args.watch)
        polls += 1
        changed = sorted(k for k in pristine_src if current.get(k) != pristine_src[k])
        if changed and in_place is None:
            in_place = {"at": round(elapsed, 3), "files": changed}

        if signalled is None:
            reason = None
            if args.signal != "none" and changed:
                reason = "source file observed mutated on disk"
            elif args.signal != "none" and elapsed >= args.fallback_after > 0:
                # A framework that mutates a sandbox never trips the sharp
                # trigger. It still gets killed mid-run, because "we never
                # managed to interrupt it" is not the same finding as "it
                # survived being interrupted", and the report has to tell them
                # apart rather than print the same word for both.
                reason = (
                    "no in-place mutation observed; killed mid-run at %.2fs"
                    % elapsed
                )
            elif elapsed >= args.deadline:
                reason = (
                    "deadline reached without the run finishing"
                    if args.signal == "none"
                    else "deadline reached with no in-place mutation observed"
                )
            if reason:
                name = "KILL" if args.signal == "none" else args.signal.upper()
                deliver(proc, getattr(signal, "SIG" + name), args.signal_target)
                signalled = {
                    "signal": name,
                    "target": args.signal_target,
                    "at": round(elapsed, 3),
                    "reason": reason,
                    "files": changed,
                }
                if name == "KILL":
                    break
        else:
            # A catchable signal is owed its handler. Still there after the settle
            # window means it was never going to unwind on its own.
            if elapsed - signalled["at"] > args.settle:
                deliver(proc, signal.SIGKILL, "group")
                signalled["escalated_to_sigkill_after"] = args.settle
                break

        time.sleep(POLL)

    # The leader exiting is not the run ending. `sh -c "a && b"` makes the SHELL
    # the leader, so a leader-only signal can orphan the framework and let it
    # finish -- and hashing then would credit the signal with a restore the
    # framework did on its own, unwatched. Wait for the group to go quiet, and
    # say so in the report when it did not.
    orphans = group_alive(pgid) if proc.poll() is not None else False
    quiet_after = None
    if orphans:
        waited = 0.0
        while waited < args.settle and group_alive(pgid):
            time.sleep(POLL)
            waited += POLL
        if group_alive(pgid):
            deliver(proc, signal.SIGKILL, "group")
            quiet_after = "never -- group SIGKILLed after %.1fs" % waited
        else:
            quiet_after = round(waited, 2)

    time.sleep(GRACE)
    try:
        out = proc.communicate(timeout=10)[0]
    except subprocess.TimeoutExpired:
        proc.kill()
        out = proc.communicate()[0]
    output = (out or b"").decode("utf-8", "replace")

    after = snapshot(root)
    return {
        "label": args.label,
        "command": args.command,
        "watch": args.watch,
        "signal_requested": args.signal,
        "signal_target": args.signal_target,
        "fallback_after": args.fallback_after,
        "exit_code": proc.returncode,
        "wall_seconds": round(time.monotonic() - started, 2),
        "polls": polls,
        "orphans_outlived_leader": orphans,
        "group_quiet_after": quiet_after,
        "in_place_mutation_observed": in_place,
        "signal_delivered": signalled,
        "source_after": diff(pristine_src, watched(after, args.watch)),
        "tree_after": diff(pristine, after),
        "output_tail": output[-4000:],
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default=".", help="the fixture tree to hash")
    p.add_argument("--label", required=True)
    p.add_argument(
        "--watch",
        action="append",
        required=True,
        help="glob (relative to --root) for the code under test; a change here is a mutation",
    )
    p.add_argument(
        "--signal",
        default="none",
        choices=["none", "kill", "term", "int"],
        help="what to deliver when a mutation is observed; 'none' is the baseline run",
    )
    p.add_argument(
        "--signal-target",
        default="group",
        choices=["group", "leader"],
        help="'group' is a CI cancel or a Ctrl-C; 'leader' is what `timeout` does",
    )
    p.add_argument("--deadline", type=float, default=180.0)
    p.add_argument(
        "--fallback-after",
        type=float,
        default=0.0,
        help="if no in-place mutation is seen by this many seconds, signal anyway; "
        "0 disables, and the run is then only interrupted by --deadline",
    )
    p.add_argument(
        "--settle",
        type=float,
        default=15.0,
        help="how long a catchable signal is given to unwind before SIGKILL",
    )
    p.add_argument("command", nargs=argparse.REMAINDER)
    args = p.parse_args()
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        p.error("no command given")

    sys.stdout.write("\n__PROBE_JSON__" + json.dumps(run(args)) + "\n")


if __name__ == "__main__":
    main()
