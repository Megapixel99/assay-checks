const assert = require('assert');
const { clamp, score, tally } = require('../src/calc');

// EVERY test sleeps, for the reason given in the Python fixture: the suite has
// to be slow enough that a run can be killed WHILE A MUTANT IS APPLIED rather
// than between two of them.
const DWELL = 400;
const dwell = () => new Promise((r) => setTimeout(r, DWELL));

describe('calc', function () {
  this.timeout(10000);

  it('clamps', async () => {
    await dwell();
    assert.strictEqual(clamp(5, 0, 10), 5);
    assert.strictEqual(clamp(-1, 0, 10), 0);
    assert.strictEqual(clamp(11, 0, 10), 10);
  });

  it('scores', async () => {
    await dwell();
    assert.strictEqual(score(1, 2), 0.5);
    assert.strictEqual(score(0, 0), 0.0);
  });

  it('tallies', async () => {
    await dwell();
    assert.strictEqual(tally([1, 2, 3]), 6);
    assert.strictEqual(tally([]), 0);
  });
});
