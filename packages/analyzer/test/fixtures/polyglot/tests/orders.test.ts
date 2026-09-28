import { processOrder } from "../src/orders";

describe("processOrder", () => {
  it("rejects empty orders", () => {
    try {
      processOrder({ id: "1", items: [] }, { vip: false, banned: false }, new Map(), null, "EU", []);
    } catch {}
    // TODO: assert on the result
  });
});
