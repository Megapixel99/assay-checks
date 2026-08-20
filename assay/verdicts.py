"""The three verdicts, and the rule that they are never mixed.

Both halves of this tool answer a question about work that already passes its tests,
and both can be wrong in the same two directions: claiming a problem that is not one,
or staying quiet about one that is. Keeping the verdicts separate is what stops either
from happening silently.

  finding   something was CHECKED and is wrong. Fails the run.
  look      a rule applies here and this tool CANNOT decide. NEVER fails the run.
  ok        checked and fine. Printed rather than left silent, because "we found none"
            and "we never looked" are different claims and only one of them is
            evidence.

`look` never failing is a deliberate limit, not timidity. A check that reports things
a person then has to dismiss stops being read, and a check nobody reads is worse than
no check at all — it occupies the place where a working one would go. Anything this
tool cannot settle by looking at the code is offered for a human to settle.
"""

FINDING = "finding"
LOOK = "look"
OK = "ok"

ORDER = {FINDING: 0, LOOK: 1, OK: 2}


class Item:
    """One line of a report: a verdict, what it is about, and where."""

    def __init__(self, verdict, message, where=None, detail=None):
        if verdict not in ORDER:
            raise ValueError("unknown verdict %r" % (verdict,))
        self.verdict = verdict
        self.message = message
        self.where = where
        self.detail = detail

    def __repr__(self):                                       # pragma: no cover
        return "<Item %s %s>" % (self.verdict, self.message[:40])

    def __eq__(self, other):
        return (isinstance(other, Item)
                and (self.verdict, self.message, self.where, self.detail)
                == (other.verdict, other.message, other.where, other.detail))


class Report:
    """Everything one run found, held as data so callers can read it without stdout.

    A tool whose results exist only as printed text cannot be tested except by parsing
    its own output, and a parser of your own output is one more thing that can be
    wrong about what happened. Every command here builds a Report and the renderer is
    the only thing that prints.
    """

    def __init__(self, title=None):
        self.title = title
        self.items = []
        self.sections = []

    def add(self, verdict, message, where=None, detail=None):
        self.items.append(Item(verdict, message, where, detail))
        return self

    def finding(self, message, where=None, detail=None):
        return self.add(FINDING, message, where, detail)

    def look(self, message, where=None, detail=None):
        return self.add(LOOK, message, where, detail)

    def ok(self, message, where=None, detail=None):
        return self.add(OK, message, where, detail)

    def extend(self, other):
        """Fold another report in, keeping its notes."""
        self.items.extend(other.items)
        self.sections.extend(other.sections)
        return self

    def note(self, text):
        """Free text that is not a verdict — counts, tables, census lines."""
        self.sections.append(text)
        return self

    def of(self, verdict):
        return [i for i in self.items if i.verdict == verdict]

    @property
    def findings(self):
        return self.of(FINDING)

    @property
    def looks(self):
        return self.of(LOOK)

    @property
    def oks(self):
        return self.of(OK)

    def exit_code(self):
        """0 = nothing to read, 1 = at least one finding. `look` never contributes.

        A caller that could not run at all returns 2 without building a Report, so
        "the tool failed" and "the tool found something" stay distinguishable. Every
        command in this package uses the same three codes, and scripts depend on that
        more than on anything printed.
        """
        return 1 if self.findings else 0


def render(report, out, verbose=True, show_ok=True):
    """Print a Report. The only place in this package that writes to a stream."""
    if report.title and verbose:
        out.write("%s\n" % report.title)
    for text in report.sections:
        if verbose:
            out.write("%s\n" % text)
    if show_ok and verbose:
        for item in report.oks:
            out.write("  ok       %s\n" % item.message)
    looks = report.looks
    if looks and verbose:
        out.write("\nLOOK — %d item(s) a rule applies to and this tool CANNOT decide.\n"
                  % len(looks))
        out.write("       These never fail the run. A check that cries wolf is one\n")
        out.write("       nobody runs, and an unread check is worse than none.\n")
        for item in looks:
            out.write("  look     %s\n" % item.message)
    findings = report.findings
    if findings:
        out.write("\nFINDINGS — %d, each checked rather than guessed:\n" % len(findings))
        for item in findings:
            out.write("  finding  %s\n" % item.message)
            if item.detail and verbose:
                out.write("           %s\n" % item.detail)
    elif verbose:
        out.write("\nno findings.\n")
    return report.exit_code()
