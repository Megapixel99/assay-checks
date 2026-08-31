// The JavaScript half of the same deliberately small target: every line is
// mutable, and every line is tested. Kept line-for-line parallel to the Python
// fixture so a difference in the report is a difference in the FRAMEWORK.

function clamp(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function score(hits, total) {
  if (total === 0) return 0.0;
  return hits / total;
}

function tally(values) {
  let out = 0;
  for (const v of values) {
    out = out + v;
  }
  return out;
}

module.exports = { clamp, score, tally };
