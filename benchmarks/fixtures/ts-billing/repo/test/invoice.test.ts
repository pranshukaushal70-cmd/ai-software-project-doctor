import { strict as assert } from "node:assert";
import { test } from "node:test";
import { invoiceTotal } from "../src/billing/invoice.ts";

test("adds tax per region", () => {
  assert.equal(invoiceTotal([{ sku: "a", quantity: 1, unitCents: 1000, region: "US" }]), 1070);
});
