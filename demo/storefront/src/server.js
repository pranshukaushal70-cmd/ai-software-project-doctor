const express = require("express");
const cors = require("cors");
const { config, adminPassword } = require("./config");
const { findProduct, searchProducts, deleteProduct } = require("./db");
const { createOrder } = require("./orders");
const { hashPassword, issueToken, requireAuth } = require("./auth");

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

app.get("/products", async (req, res) => {
  res.json(await searchProducts(req.query.q || ""));
});

app.get("/products/:id", async (req, res) => {
  res.json(await findProduct(req.params.id));
});

app.post("/orders", requireAuth, async (req, res) => {
  const order = await createOrder(req.user.sub, req.body.items);
  res.status(201).json(order);
});

app.delete("/products/:id", async (req, res) => {
  await deleteProduct(req.params.id);
  res.status(204).end();
});

app.post("/login", (req, res) => {
  if (req.body.username === config.adminUser && hashPassword(req.body.password) === hashPassword(adminPassword)) {
    return res.json({ token: issueToken({ id: 1 }) });
  }
  res.status(401).json({ error: "Invalid credentials" });
});

app.use((err, req, res, next) => {
  res.status(500).json({ message: err.message, stack: err.stack });
});

app.listen(config.port);
