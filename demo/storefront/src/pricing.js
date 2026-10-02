const _ = require("lodash");
const { orderCount } = require("./orders");

// Discount rules grew one special case at a time.
function discountFor(item, context) {
  let discount = 0;
  if (item.category === "books") {
    if (item.quantity > 10) discount = 0.15;
    else if (item.quantity > 5) discount = 0.1;
    else discount = 0.05;
  } else if (item.category === "electronics") {
    if (context.season === "black-friday") discount = 0.3;
    else if (context.loyalty === "gold" && item.priceCents > 50000) discount = 0.12;
    else if (context.loyalty === "silver" || context.loyalty === "gold") discount = 0.07;
  } else if (item.category === "food") {
    if (item.expiresInDays !== undefined && item.expiresInDays < 2) discount = 0.5;
    else if (item.expiresInDays !== undefined && item.expiresInDays < 5) discount = 0.25;
  }
  if (context.coupon && context.coupon.startsWith("VIP") && discount < 0.2) discount = 0.2;
  if (context.previousOrders && orderCount(context.previousOrders) > 20) discount += 0.02;
  return Math.min(discount, 0.5);
}

function priceOrder(items, context = {}) {
  return _.sumBy(items, (item) => Math.round(item.priceCents * item.quantity * (1 - discountFor(item, context))));
}

module.exports = { discountFor, priceOrder };
