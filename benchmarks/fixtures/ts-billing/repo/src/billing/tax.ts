import { subtotal, type Line } from "./invoice.ts";

const RATES: Record<string, number> = { EU: 0.2, UK: 0.2, US: 0.07 };

export function taxFor(line: Line): number {
  return Math.round(subtotal([line]) * (RATES[line.region] ?? 0));
}
