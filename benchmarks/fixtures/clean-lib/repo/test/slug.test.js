"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { slugify } = require("../src/slug");

test("slugify removes accents and punctuation", () => {
  assert.equal(slugify("Crème Brûlée, Please!"), "creme-brulee-please");
});
