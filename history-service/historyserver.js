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

app.get("/health", (_req, res) => res.json({ ok: true }));

// ========================================================
// DYNAMODB HISTORY ENDPOINTS
// ========================================================

// DynamoDB history (single user)
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
    res.status(500).json({ error: err.message });
  }
});

// DynamoDB all (admin/debug)
app.get("/history/dynamo", async (_req, res) => {
  try {
    const data = await ddb.send(
      new ScanCommand({ TableName: process.env.HISTORY_TABLE, Limit: 200 })
    );
    res.json({ results: data.Items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================================================
// RDS HISTORY ENDPOINTS
// ========================================================

// RDS history by username
app.get("/history/rds/:username", async (req, res) => {
  try {
    const result = await pg.query(
      "SELECT * FROM jobs WHERE user_id = $1 ORDER BY created_at DESC",
      [req.params.username]
    );
    res.json({ results: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RDS summary endpoint (aggregate by user)
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
    console.error("❌ Failed to fetch RDS summary:", err.message);
    res.status(500).json({ error: "Failed to fetch RDS summary" });
  }
});

// RDS filter-by-action endpoint (?action=merge-pdfs)
app.get("/history/rds/filter", async (req, res) => {
  let { action } = req.query;
  if (!action) {
    return res.status(400).json({ error: "Please provide ?action=..." });
  }

  console.log("🔎 Raw action param:", JSON.stringify(action));
  action = action.trim().replace(/^"+|"+$/g, "").toLowerCase();

  try {
    const result = await pg.query(
      "SELECT * FROM jobs WHERE LOWER(action) = $1 ORDER BY created_at DESC",
      [action]
    );
    console.log("✅ Query executed with param:", action);
    console.log("✅ Rows returned:", result.rows.length);
    res.json({ results: result.rows });
  } catch (err) {
    console.error("❌ Failed to fetch RDS filtered jobs:", err.message);
    res.status(500).json({ error: "Failed to fetch RDS filtered jobs" });
  }
});

// ========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`History service running on ${PORT}`)
);
