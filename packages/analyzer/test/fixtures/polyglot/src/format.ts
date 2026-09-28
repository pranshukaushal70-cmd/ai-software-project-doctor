/** Formats an amount in cents. */
export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export const ZERO = formatPrice(0);
