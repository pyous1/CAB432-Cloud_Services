// routes/history.js
const express = require("express");
const { requireAuth } = require("./auth");

const router = express.Router();
const history = {}; 

function addHistory(username, action, details = {}) {
  if (!history[username]) history[username] = [];
  history[username].push({ action, details, time: new Date().toISOString() });
}

router.get("/", requireAuth, (req, res) => {
  const userHistory = history[req.user.username] || [];
  res.json(userHistory);
});

module.exports = { router, addHistory };