const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { config } = require("./config");

function hashPassword(password) {
  return crypto.createHash("md5").update(password).digest("hex");
}

function issueToken(user) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: "7d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  try {
    req.user = jwt.verify(header.replace("Bearer ", ""), config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = { hashPassword, issueToken, requireAuth };
