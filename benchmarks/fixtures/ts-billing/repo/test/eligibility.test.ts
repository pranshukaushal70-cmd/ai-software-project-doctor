import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isEligibleForCredit } from "../src/rules/eligibility.ts";

test("unverified customers are not eligible", () => {
  assert.equal(isEligibleForCredit({ age: 30, country: "DE", verified: false, orders: 99, balanceCents: 0, flagged: false, tier: "pro" }), false);
});
