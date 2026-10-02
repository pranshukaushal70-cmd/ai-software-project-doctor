const { pool } = require("./db");
const { priceOrder } = require("./pricing");

async function createOrder(customerId, items) {
  const total = priceOrder(items, { customerId });
  const result = await pool.query("INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2) RETURNING id", [customerId, total]);
  return { id: result.rows[0].id, total };
}

function orderCount(orders) {
  return orders.length;
}

module.exports = { createOrder, orderCount };
