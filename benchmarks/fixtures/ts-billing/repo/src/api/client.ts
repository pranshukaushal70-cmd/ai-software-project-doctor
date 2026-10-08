export async function fetchRates(baseUrl: string): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${baseUrl}/rates`);
    return (await res.json()) as Record<string, number>;
  } catch {}
  return {};
}
