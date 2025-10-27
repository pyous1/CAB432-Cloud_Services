const jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "dev-secret";

function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });

  const token = authHeader.split(" ")[1]; // "Bearer <token>"
  jwt.verify(token, SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token" });
    req.user = user;
    next();
  });
}

module.exports = { requireAuth };