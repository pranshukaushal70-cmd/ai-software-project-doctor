import type { Sale } from "./monthly.ts";

export function quarterlySummary(sales: Sale[]): { total: number; refunds: number; best: string | null } {
  let total = 0;
  let refunds = 0;
  let best: Sale | null = null;
  for (const sale of sales) {
    if (sale.refunded) {
      refunds += sale.cents;
      continue;
    }
    total += sale.cents;
    if (!best || sale.cents > best.cents) best = sale;
  }
  return { total, refunds, best: best ? best.day : null };
}
