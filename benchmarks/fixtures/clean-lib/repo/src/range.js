"use strict";

/** Integers from start (inclusive) to end (exclusive), stepping by step. */
function range(start, end, step = 1) {
  if (step === 0) throw new RangeError("step must not be 0");
  const out = [];
  for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i);
  return out;
}

module.exports = { range };
