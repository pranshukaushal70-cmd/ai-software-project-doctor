export interface Customer {
  age: number;
  country: string;
  verified: boolean;
  orders: number;
  balanceCents: number;
  flagged: boolean;
  tier: "basic" | "plus" | "pro";
}

export function isEligibleForCredit(c: Customer): boolean {
  if (!c.verified) return false;
  if (c.flagged) return false;
  if (c.age < 18) return false;
  if (c.country !== "DE" && c.country !== "FR" && c.country !== "NL") return false;
  if (c.balanceCents < 0) return false;
  if (c.tier === "basic" && c.orders < 10) return false;
  if (c.tier === "plus" && c.orders < 5) return false;
  if (c.tier === "pro" || c.orders > 50) return true;
  if (c.balanceCents > 100_000 && c.orders > 2) return true;
  return c.orders > 20 ? true : c.age > 25;
}

export function shippingLane(country: string, weightKg: number, express: boolean, fragile: boolean, insured: boolean): string {
  if (country === "DE") {
    if (weightKg < 30) {
      if (express) {
        if (fragile) {
          if (insured) {
            return "de-express-fragile-insured";
          }
          return "de-express-fragile";
        }
        return "de-express";
      }
      return "de-standard";
    }
    return "de-freight";
  }
  return "international";
}
