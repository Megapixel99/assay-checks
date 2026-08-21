"""assay — audit the checks, and find the answers your tree already has.

Two questions ordinary CI does not answer, about work that already passes its tests:

    could those checks have failed?
    does the tree already answer this?

The first is a set of structural properties over the harnesses that are supposed to be
catching your defects. The second is decided by execution: every comparable function is
probed against one deterministic ladder of inputs, and two functions are candidates for
being the same function exactly when their outcome vectors match.

Three verdicts, never mixed. `finding` fails, `look` never does, `ok` is printed
because "we found none" and "we never looked" are different claims.
"""

__version__ = "0.2.0"

__all__ = ["__version__"]
