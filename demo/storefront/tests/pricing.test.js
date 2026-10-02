const { describe, it, expect } = require("vitest");
const { discountFor } = require("../src/pricing");

describe("discountFor", () => {
  it("gives bulk discounts on books", () => {
    expect(discountFor({ category: "books", quantity: 12 }, {})).toBe(0.15);
  });

  it.skip("caps discounts at 50%", () => {
    expect(discountFor({ category: "food", expiresInDays: 1 }, { coupon: "VIP1" })).toBe(0.5);
  });
});
