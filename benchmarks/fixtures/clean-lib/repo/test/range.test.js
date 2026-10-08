"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { range } = require("../src/range");

test("range counts up and down", () => {
  assert.deepEqual(range(0, 3), [0, 1, 2]);
  assert.deepEqual(range(3, 0, -1), [3, 2, 1]);
});

test("range refuses a zero step", () => {
  assert.throws(() => range(0, 1, 0), RangeError);
});
