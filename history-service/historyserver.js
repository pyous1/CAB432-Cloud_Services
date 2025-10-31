// ============================
// HISTORY SERVICE (Public)
// ============================
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(morgan("dev"));

const region = "ap-southeast-2";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const pg = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: 5432,
  ssl: { rejectUnauthorized: false },
});

// ---------------- HEALTH CHECK ----------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// ========================================================
// DYNAMODB HISTORY ENDPOINTS
// ========================================================

// Get history for a specific user (DynamoDB)
app.get("/history/dynamo/:username", async (req, res) => {
  try {
    const data = await ddb.send(
      new QueryCommand({
        TableName: process.env.HISTORY_TABLE,
        KeyConditionExpression: "username = :u",
        ExpressionAttributeValues: { ":u": req.params.username },
      })
    );
    res.json({ results: data.Items || [] });
  } catch (err) {
    console.error("❌ DynamoDB query failed:", err.message);
    res.status(500).json({ error: "Failed to fetch DynamoDB history" });
  }
});

// Get all history items (for debugging / admin)
app.get("/history/dynamo", async (_req, res) => {
  try {
    const data = await ddb.send(
      new ScanCommand({ TableName: process.env.HISTORY_TABLE, Limit: 200 })
    );
    res.json({ results: data.Items || [] });
  } catch (err) {
    console.error("❌ DynamoDB scan failed:", err.message);
    res.status(500).json({ error: "Failed to scan DynamoDB history" });
  }
});

// ========================================================
// RDS HISTORY ENDPOINTS
// ========================================================

// Get RDS history for a given username
app.get("/history/rds/:username", async (req, res) => {
  try {
    const result = await pg.query(
      "SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC",
      [req.params.username]
    );
    res.json({ results: result.rows });
  } catch (err) {
    console.error("❌ RDS user history failed:", err.message);
    res.status(500).json({ error: "Failed to fetch RDS user history" });
  }
});

// Get RDS summary aggregated by user
app.get("/history/rds/summary", async (_req, res) => {
  try {
    const result = await pg.query(`
      SELECT user_id, COUNT(*) AS total_jobs
      FROM jobs
      GROUP BY user_id
      ORDER BY total_jobs DESC;
    `);
    res.json({ summary: result.rows });
  } catch (err) {
    console.error("❌ RDS summary failed:", err.message);
    res.status(500).json({ error: "Failed to fetch RDS summary" });
  }
});

// Get RDS jobs filtered by action (?action=merge-pdfs)
app.get("/history/rds/filter", async (req, res) => {
  let { action } = req.query;
  if (!action) return res.status(400).json({ error: "Please provide ?action=..." });

  action = action.trim().replace(/^"+|"+$/g, "").toLowerCase();

  try {
    const result = await pg.query(
      "SELECT * FROM jobs WHERE LOWER(action) = $1 ORDER BY created_at DESC",
      [action]
    );
    res.json({ results: result.rows });
  } catch (err) {
    console.error("❌ RDS filter failed:", err.message);
    res.status(500).json({ error: "Failed to fetch filtered RDS jobs" });
  }
});

// ========================================================
// START SERVER
// ========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`History service running on port ${PORT}`));
