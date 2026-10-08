export function formatAddress(name: string, street: string, number: string, postcode: string, city: string, country: string, phone: string): string {
  return [name, `${street} ${number}`, `${postcode} ${city}`, country, phone].join("\n");
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
