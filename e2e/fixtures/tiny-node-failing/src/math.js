"use strict";

/** Sum of two numbers. */
function add(a, b) {
  return a + b;
}

/** Difference of two numbers. Planted bug: it adds instead of subtracting. */
function subtract(a, b) {
  return a + b;
}

module.exports = { add, subtract };
