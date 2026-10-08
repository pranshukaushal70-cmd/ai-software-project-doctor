"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { add, multiply } = require("../src/math");

test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("multiply multiplies two numbers", () => {
  assert.equal(multiply(4, 5), 20);
});
