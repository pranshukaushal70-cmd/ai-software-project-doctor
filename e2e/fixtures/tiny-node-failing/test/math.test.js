"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { add, subtract } = require("../src/math");

test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract takes the second number from the first", () => {
  assert.equal(subtract(5, 3), 2);
});
