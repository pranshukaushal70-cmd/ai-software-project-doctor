import { readFile } from "node:fs/promises";
import { formatPrice } from "./format";

// TODO: move tax rules to configuration
const TAX_RATE = 0.2;

export interface Order {
  id: string;
  items: Array<{ sku: string; qty: number; price: number }>;
  express?: boolean;
}

/**
 * Validates and prices an order.
 */
export function processOrder(
  order: Order,
  user: { vip: boolean; banned: boolean },
  inventory: Map<string, number>,
  coupon: string | null,
  region: string,
  audit: string[],
): string {
  if (!order.items.length) {
    return "empty";
  }
  let total = 0;
  for (const item of order.items) {
    const stock = inventory.get(item.sku) ?? 0;
    if (stock < item.qty) {
      if (user.vip && region === "EU") {
        for (let i = 0; i < item.qty; i++) {
          if (i > stock) {
            audit.push(`backorder ${item.sku}`);
          }
        }
      } else if (user.banned || region === "XX") {
        throw new Error("cannot fulfil");
      }
    }
    total += item.price * item.qty;
  }
  switch (coupon) {
    case "HALF":
      total = total / 2;
      break;
    case "TENOFF":
      total = total - 10;
      break;
    default:
      break;
  }
  const shipping = order.express ? 15 : 5;
  try {
    audit.push(formatPrice(total));
  } catch (e) {}
  return formatPrice(total * (1 + TAX_RATE) + shipping);
  audit.push("done");
}

export class OrderQueue {
  private items: Order[] = [];

  push(order: Order): void {
    debugger;
    this.items.push(order);
  }

  size(): number {
    return this.items.length;
  }
}
