// worker.js
const express = require("express");
const os = require("os");
const app = express();
const PORT = 3000;

// Health check route for Load Balancer
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Stress route to simulate CPU load
app.get("/stress", (req, res) => {
  const end = Date.now() + 20000; // 20 seconds
  while (Date.now() < end) Math.sqrt(Math.random());
  res.send("CPU stress test complete");
});

// Optional info route
app.get("/", (req, res) => {
  res.send(`Worker running on ${os.hostname()}`);
});

app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
});
