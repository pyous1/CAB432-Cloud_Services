// ============================
// API SERVICE (Producer) - No Authentication
// ============================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const path = require("path");
const { Pool } = require("pg");
const memjs = require("memjs");

// ---------- AWS ----------
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");

// ---------- Constants / Clients ----------
const region = "ap-southeast-2";
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });
const secretsClient = new SecretsManagerClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const sqs = new SQSClient({ region });
const cloudwatch = new CloudWatchClient({ region });

const BUCKET = process.env.S3_BUCKET;
const HISTORY_TABLE = process.env.HISTORY_TABLE;
const QUEUE_URL = process.env.SQS_QUEUE_URL;

const cache = memjs.Client.create(
  process.env.CACHE_ENDPOINT || "pdfconverter.km2jzi.cfg.apse2.cache.amazonaws.com:11211"
);

const pgPool = new Pool({
  host: "database-1-instance-1.ce2haupt2cta.ap-southeast-2.rds.amazonaws.com",
  port: 5432,
  database: "cohort_2025",
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl: { rejectUnauthorized: false }
});

// ---------- Express ----------
const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ------------------- HEALTH ----------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// -------------------- HELPERS ------------------------
async function addHistory(username, action, details) {
  try {
    await ddb.send(new PutCommand({
      TableName: HISTORY_TABLE,
      Item: {
        username,
        timestamp: Date.now(),
        action,
        details,
        created_at: new Date().toISOString()
      },
    }));
  } catch (err) {
    console.error("⚠️ Failed to write to DynamoDB:", err.message);
  }
}

// ------------------------ S3 SIGNED URL HELPERS -----------------
async function signDownload(key) {
  return await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
}

app.get("/s3/upload-url", async (req, res) => {
  try {
    const key = `uploads/${Date.now()}-${req.query.filename}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: req.query.contentType || "application/octet-stream",
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    res.json({ uploadUrl: url, key });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate pre-signed URL" });
  }
});

app.get("/s3/download-url", async (req, res) => {
  try {
    const key = req.query.key;
    const url = await signDownload(key);
    res.json({ downloadUrl: url });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate pre-signed URL" });
  }
});

// ------------------------ QUEUE-BASED ROUTES --------------------
function makeJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Convert images → PDF
app.post("/convert/images", upload.array("files", 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "Upload at least one image" });

    const jobId = makeJobId();
    const job = {
      jobId,
      type: "convert-images",
      username: "public-user",
      files: req.files.map(f => ({
        name: f.originalname,
        buffer: f.buffer.toString("base64"),
        mimetype: f.mimetype
      })),
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await publishCustomMetric("PendingNotifications", 1);
    await addHistory("public-user", "queued: images->pdf", { jobId, count: req.files.length });

    res.status(202).json({ message: "Job queued", jobType: job.type, jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to queue images->pdf" });
  }
});

// Merge PDFs
app.post("/merge", upload.array("files", 50), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2)
      return res.status(400).json({ error: "Upload at least two PDFs" });

    const jobId = makeJobId();
    const job = {
      jobId,
      type: "merge-pdfs",
      username: "public-user",
      files: req.files.map(f => ({
        name: f.originalname,
        buffer: f.buffer.toString("base64")
      })),
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await publishCustomMetric("PendingNotifications", 1);
    await addHistory("public-user", "queued: merge", { jobId, count: req.files.length });

    res.status(202).json({ message: "Job queued", jobType: job.type, jobId });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue merge" });
  }
});

// LaTeX → PDF
app.post("/convert/latex", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No .tex file uploaded" });

    const jobId = makeJobId();
    const job = {
      jobId,
      type: "latex->pdf",
      username: "public-user",
      file: { name: req.file.originalname, buffer: req.file.buffer.toString("base64") },
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await publishCustomMetric("PendingNotifications", 1);
    await addHistory("public-user", "queued: latex->pdf", { jobId, file: req.file.originalname });

    res.status(202).json({ message: "Job queued", jobType: job.type, jobId });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue LaTeX job" });
  }
});

// Heavy watermark
app.post("/watermark-heavy", upload.array("files", 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "No PDF uploaded" });

    const jobId = makeJobId();
    const job = {
      jobId,
      type: "watermark-heavy",
      username: "public-user",
      files: req.files.map(f => ({
        name: f.originalname,
        buffer: f.buffer.toString("base64")
      })),
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await publishCustomMetric("PendingNotifications", 1);
    await addHistory("public-user", "queued: watermark-heavy", { jobId, count: req.files.length });

    res.status(202).json({ message: "Job queued", jobType: job.type, jobId });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue watermark job" });
  }
});

// External fetch
app.post("/external/fetchpdf", async (req, res) => {
  try {
    const jobId = makeJobId();
    const urlParam = req.body?.url || "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
    const job = { jobId, type: "external-fetch", username: "public-user", url: urlParam };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await publishCustomMetric("PendingNotifications", 1);
    await addHistory("public-user", "queued: external-fetch", { jobId, url: urlParam });

    res.status(202).json({ message: "Job queued", jobType: job.type, jobId });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue external fetch" });
  }
});

// ---------------- CUSTOM CLOUDWATCH METRIC ----------------
async function publishCustomMetric(metricName, value) {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: "PDFConverterApp",
      MetricData: [{
        MetricName: metricName,
        Unit: "Count",
        Value: value,
        Dimensions: [
          { Name: "Service", Value: "PDFWorker" },
          { Name: "Environment", Value: "Prod" }
        ]
      }]
    }));
  } catch (err) {
    console.error("❌ Failed to publish CloudWatch metric:", err);
  }
}

// -------------------- SERVERLESS NOTIFICATION ENDPOINT ------------------------
app.post("/api/notify", async (req, res) => {
  const { bucket, key } = req.body;
  if (!bucket || !key) return res.status(400).json({ error: "Missing bucket or key" });

  try {
    await addHistory("lambda-system", "lambda-notify", { bucket, key });
    await publishCustomMetric("PendingNotifications", 1);
    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ bucket, key, timestamp: Date.now() })
    }));
    res.json({ message: "Job queued successfully", bucket, key });
  } catch (err) {
    res.status(500).json({ error: "Failed to queue job", details: err.message });
  }
});

// ----------- static & start ----------------
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
async function loadSecrets() {
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: "n11621516-a2secret" }));
    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString);
      if (secret.DB_PASSWORD) process.env.DB_PASSWORD = secret.DB_PASSWORD;
      console.log("Secrets loaded from Secrets Manager ✅");
    }
  } catch (err) {
    console.error("Failed to load secrets:", err);
  }
}
async function loadParameters() {
  try {
    const paramsToLoad = [
      "/n11621516/pdf_parameter",
      "/n11621516/HISTORY_TABLE",
      "/n11621516/S3_BUCKET"
    ];
    for (const name of paramsToLoad) {
      const resp = await ssm.send(new GetParameterCommand({ Name: name }));
      const key = name.split("/").pop();
      process.env[key] = resp.Parameter.Value;
      console.log(`Parameter loaded from SSM ✅ ${key}=${process.env[key]}`);
    }
  } catch (err) {
    console.error("Failed to load parameters:", err);
  }
}

async function init() {
  await loadSecrets();
  await loadParameters();
  app.listen(PORT, () => console.log(`PDF Converter API running on port ${PORT}`));
}
init();
