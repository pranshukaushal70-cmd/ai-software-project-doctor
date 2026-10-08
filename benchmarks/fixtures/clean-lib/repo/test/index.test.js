"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../src/index");

test("index exports every helper", () => {
  assert.deepEqual(Object.keys(lib).sort(), ["range", "slugify"]);
});
