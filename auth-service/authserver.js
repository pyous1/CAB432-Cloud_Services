const express = require("express");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

// Login route
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body;

  // Hardcoded users (example)
  const users = [
    { username: "Admin", password: "Admin123" },
    { username: "TestUser", password: "Test123" }
  ];

  const user = users.find(
    (u) => u.username === username && u.password === password
  );
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: "2h" });
  res.json({ token });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Auth service running on ${PORT}`));
