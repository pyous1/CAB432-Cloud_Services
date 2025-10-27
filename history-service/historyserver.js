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
  ssl: { rejectUnauthorized: false }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// DynamoDB history (single user)
app.get("/history/dynamo/:username", async (req, res) => {
  try {
    const data = await ddb.send(new QueryCommand({
      TableName: process.env.HISTORY_TABLE,
      KeyConditionExpression: "username = :u",
      ExpressionAttributeValues: { ":u": req.params.username }
    }));
    res.json({ results: data.Items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DynamoDB all (admin/debug)
app.get("/history/dynamo", async (_req, res) => {
  try {
    const data = await ddb.send(new ScanCommand({ TableName: process.env.HISTORY_TABLE, Limit: 200 }));
    res.json({ results: data.Items || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RDS history by user
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`History service running on ${PORT}`));
