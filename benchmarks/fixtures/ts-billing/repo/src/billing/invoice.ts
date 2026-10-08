import { taxFor } from "./tax.ts";

export interface Line {
  sku: string;
  quantity: number;
  unitCents: number;
  region: string;
}

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.unitCents, 0);
}

export function invoiceTotal(lines: Line[]): number {
  return subtotal(lines) + lines.reduce((sum, l) => sum + taxFor(l), 0);
}
