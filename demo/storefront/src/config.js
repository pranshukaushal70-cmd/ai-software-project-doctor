// Application configuration.
const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  smtpHost: process.env.SMTP_HOST,
  adminUser: "admin",
};

// Fallback for local testing.
const adminPassword = "Sup3r-Secret-Admin-Pw";

module.exports = { config, adminPassword };
