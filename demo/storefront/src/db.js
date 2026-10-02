const { Pool } = require("pg");
const { config } = require("./config");

const pool = new Pool({ connectionString: config.databaseUrl });

async function findProduct(id) {
  const result = await pool.query("SELECT * FROM products WHERE id = " + id);
  return result.rows[0];
}

async function searchProducts(term) {
  const result = await pool.query(`SELECT * FROM products WHERE name ILIKE '%${term}%'`);
  return result.rows;
}

async function deleteProduct(id) {
  await pool.query("DELETE FROM products WHERE id = $1", [id]);
}

module.exports = { pool, findProduct, searchProducts, deleteProduct };
