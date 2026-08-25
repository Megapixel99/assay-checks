/**
 * The three verdicts, and the rule that they are never mixed.
 *
 * Both halves of this tool answer a question about work that already passes its
 * tests, and both can be wrong in the same two directions: claiming a problem that is
 * not one, or staying quiet about one that is. Keeping the verdicts separate is what
 * stops either from happening silently.
 *
 *   finding   something was CHECKED and is wrong. Fails the run.
 *   look      a rule applies here and this tool CANNOT decide. NEVER fails the run.
 *   ok        checked and fine. Printed rather than left silent, because "we found
 *             none" and "we never looked" are different claims.
 *
 * `look` never failing is a deliberate limit, not timidity. A check that reports
 * things a person then has to dismiss stops being read, and an unread check occupies
 * the place where a working one would go.
 */

export const FINDING = 'finding';
export const LOOK = 'look';
export const OK = 'ok';

const VERDICTS = new Set([FINDING, LOOK, OK]);

export class Item {
  constructor(verdict, message, where = null, detail = null) {
    if (!VERDICTS.has(verdict)) {
      throw new TypeError(`unknown verdict ${JSON.stringify(verdict)}`);
    }
    this.verdict = verdict;
    this.message = message;
    this.where = where;
    this.detail = detail;
  }
}

/**
 * Everything one run found, held as data so callers can read it without stdout.
 *
 * A tool whose results exist only as printed text cannot be tested except by parsing
 * its own output, and a parser of your own output is one more thing that can be wrong
 * about what happened.
 */
export class Report {
  constructor(title = null) {
    this.title = title;
    this.items = [];
    this.sections = [];
  }

  add(verdict, message, where = null, detail = null) {
    this.items.push(new Item(verdict, message, where, detail));
    return this;
  }

  finding(message, where, detail) { return this.add(FINDING, message, where, detail); }
  look(message, where, detail) { return this.add(LOOK, message, where, detail); }
  ok(message, where, detail) { return this.add(OK, message, where, detail); }

  note(text) { this.sections.push(text); return this; }

  extend(other) {
    this.items.push(...other.items);
    this.sections.push(...other.sections);
    return this;
  }

  of(verdict) { return this.items.filter((i) => i.verdict === verdict); }

  get findings() { return this.of(FINDING); }
  get looks() { return this.of(LOOK); }
  get oks() { return this.of(OK); }

  /**
   * 0 = nothing to read, 1 = at least one finding. `look` never contributes.
   *
   * A caller that could not run at all returns 2 without building a Report, so "the
   * tool failed" and "the tool found something" stay distinguishable. Every command
   * uses the same three codes, and scripts depend on that more than on anything
   * printed.
   */
  exitCode() { return this.findings.length ? 1 : 0; }
}

/** Print a Report. The only place in this package that writes to a stream. */
export function render(report, write, { verbose = true, showOk = true } = {}) {
  if (report.title && verbose) write(`${report.title}\n`);
  if (verbose) for (const text of report.sections) write(`${text}\n`);
  if (showOk && verbose) {
    for (const item of report.oks) write(`  ok       ${item.message}\n`);
  }
  const looks = report.looks;
  if (looks.length && verbose) {
    write(`\nLOOK — ${looks.length} item(s) a rule applies to and this tool CANNOT decide.\n`);
    write('       These never fail the run. A check that cries wolf is one\n');
    write('       nobody runs, and an unread check is worse than none.\n');
    for (const item of looks) {
      write(`  look     ${item.message}\n`);
      // A LOOK'S DETAIL IS PRINTED, exactly as a finding's is. A `look` says the tool
      // cannot decide; the detail is where it says what it DID find out on the way to
      // not deciding, and dropping it left `assay why` reporting the gate's name with
      // the reason it gave silently discarded.
      if (item.detail) write(`           ${item.detail}\n`);
    }
  }
  const findings = report.findings;
  if (findings.length) {
    write(`\nFINDINGS — ${findings.length}, each checked rather than guessed:\n`);
    for (const item of findings) {
      write(`  finding  ${item.message}\n`);
      if (item.detail && verbose) write(`           ${item.detail}\n`);
    }
  } else if (verbose) {
    write('\nno findings.\n');
  }
  return report.exitCode();
}
