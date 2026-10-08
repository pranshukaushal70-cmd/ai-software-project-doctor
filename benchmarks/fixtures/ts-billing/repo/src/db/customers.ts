export interface Queryable {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

export async function customerById(db: Queryable, id: string): Promise<unknown> {
  const result = await db.query("SELECT id, name FROM customers WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}
