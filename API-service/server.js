// ============================
// API SERVICE (Producer - Pure Microservice)
// ============================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const axios = require("axios"); // kept because you used it before (not used here)
const QRCode = require("qrcode");
const { Pool } = require("pg");
const memjs = require("memjs");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib"); // kept for type parity (not used here)

// ---------- AWS ----------
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

// ---------- Constants / Clients ----------
const region = "ap-southeast-2";
const s3 = new S3Client({ region, forcePathStyle: false, endpoint: "https://s3.ap-southeast-2.amazonaws.com" });
const ssm = new SSMClient({ region });
const secretsClient = new SecretsManagerClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const cognito = new CognitoIdentityProviderClient({ region });
const sqs = new SQSClient({ region });

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
  user: process.env.DB_USER,      // set in .env or Parameter Store
  password: process.env.DB_PASS,  // set in .env or Parameter Store
  ssl: { rejectUnauthorized: false }
});

// ---------- Cognito ----------
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID,
});
function hashSecret(username) {
  return crypto
    .createHmac("SHA256", process.env.COGNITO_CLIENT_SECRET)
    .update(username + process.env.COGNITO_CLIENT_ID)
    .digest("base64");
}

// ---------- Express ----------
const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ------------------- AUTHENTICATION ----------------------------
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const payload = await verifier.verify(token);
    req.user = {
      ...payload,
      username: payload["cognito:username"] || payload.username || payload.sub
    };
    next();
  } catch (err) {
    console.error("JWT verify failed:", err);
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || !((req.user["cognito:groups"] || []).includes(role))) {
      return res.status(403).json({ error: "Forbidden: " + role + " only" });
    }
    next();
  };
}

// Cognito signup
app.post("/auth/signup", async (req, res) => {
  const { username, password, email, fullName } = req.body;
  try {
    const cmd = new SignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: username,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: fullName || username }
      ],
      SecretHash: hashSecret(username),
    });
    await cognito.send(cmd);
    res.json({ message: "Signup successful, check your email for the confirmation code" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cognito confirm
app.post("/auth/confirm", async (req, res) => {
  const { username, code } = req.body;
  try {
    const cmd = new ConfirmSignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: username,
      ConfirmationCode: code,
      SecretHash: hashSecret(username),
    });
    await cognito.send(cmd);
    res.json({ message: "User confirmed successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cognito login
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const cmd = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: hashSecret(username),
      },
    });
    const out = await cognito.send(cmd);
    if (out.ChallengeName === "SMS_MFA" || out.ChallengeName === "SOFTWARE_TOKEN_MFA") {
      return res.json({ challenge: out.ChallengeName, session: out.Session });
    }
    res.json({
      idToken: out.AuthenticationResult.IdToken,
      accessToken: out.AuthenticationResult.AccessToken,
    });
  } catch (err) {
    res.status(401).json({ error: "Login failed: " + err.message });
  }
});

// Setup OTP
app.post("/auth/setup-totp", async (req, res) => {
  const { accessToken, username } = req.body;
  try {
    const cmd = new AssociateSoftwareTokenCommand({ AccessToken: accessToken });
    const out = await cognito.send(cmd);
    const secret = out.SecretCode;

    const issuer = "PDFConverter";
    const uri = `otpauth://totp/${issuer}:${username}?secret=${secret}&issuer=${issuer}`;
    const qrCodeDataURL = await QRCode.toDataURL(uri);

    res.json({ secret, uri, qrCode: qrCodeDataURL });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verify OTP
app.post("/auth/verify-totp", async (req, res) => {
  const { accessToken, code } = req.body;
  try {
    const cmd = new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: code });
    const out = await cognito.send(cmd);
    res.json({ status: out.Status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// MFA challenge
app.post("/auth/mfa", async (req, res) => {
  const { username, session, code } = req.body;
  try {
    const cmd = new RespondToAuthChallengeCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: session,
      ChallengeResponses: {
        USERNAME: username,
        SOFTWARE_TOKEN_MFA_CODE: code,
        SECRET_HASH: hashSecret(username),
      },
    });
    const out = await cognito.send(cmd);
    res.json({
      idToken: out.AuthenticationResult.IdToken,
      accessToken: out.AuthenticationResult.AccessToken,
    });
  } catch (err) {
    res.status(400).json({ error: "MFA failed: " + err.message });
  }
});

// Set MFA preference
app.post("/auth/set-mfa", async (req, res) => {
  const { accessToken } = req.body;
  try {
    const cmd = new SetUserMFAPreferenceCommand({
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    });
    await cognito.send(cmd);
    res.json({ message: "MFA set to TOTP for this user" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// google authentication (kept as-is)
app.post("/auth/google", async (req, res) => {
  const { idToken } = req.body;
  try {
    const decoded = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8"));
    const googleSub = decoded.sub;

    const cmd = new InitiateAuthCommand({
      AuthFlow: "USER_SRP_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: {
        PROVIDER: "Google",
        TOKEN: idToken,
        SECRET_HASH: hashSecret(googleSub),
      },
    });

    const out = await cognito.send(cmd);
    res.json({
      idToken: out.AuthenticationResult.IdToken,
      accessToken: out.AuthenticationResult.AccessToken,
    });
  } catch (err) {
    res.status(401).json({ error: "Google login failed: " + err.message });
  }
});

// -------------------- CORE ROUTES ------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// elasticache - memcache
async function getOrCache(key, fetchFn) {
  const cached = await cache.get(key);
  if (cached.value) {
    console.log("Cache hit:", key);
    return JSON.parse(cached.value.toString());
  }
  console.log("Cache miss:", key);
  const fresh = await fetchFn();
  await cache.set(key, JSON.stringify(fresh), { expires: 60 });
  return fresh;
}

// History logging (DynamoDB)
async function addHistory(username, action, details) {
  try {
    await ddb.send(new PutCommand({
      TableName: HISTORY_TABLE,
      Item: { username, timestamp: Date.now(), action, details, created_at: new Date().toISOString() },
    }));
  } catch (err) {
    console.error("⚠️ Failed to write to DynamoDB:", err.message);
  }
}

// History logging for RDS
async function saveJob(userId, filename, action, status) {
  try {
    await pgPool.query(
      "insert into jobs(user_id, filename, action, status) values ($1, $2, $3, $4)",
      [userId, filename, action, status]
    );
  } catch (err) {
    console.error("❌ Failed to save job to RDS:", err.message);
  }
}

// Get history (DynamoDB)
app.get("/history", requireAuth, async (req, res) => {
  try {
    const data = await getOrCache(`history:${req.user.username}`, async () => {
      if ((req.user["cognito:groups"] || []).includes("Admins")) {
        const result = await ddb.send(new ScanCommand({ TableName: HISTORY_TABLE }));
        return result.Items || [];
      } else {
        const result = await ddb.send(new QueryCommand({
          TableName: HISTORY_TABLE,
          KeyConditionExpression: "username = :u",
          ExpressionAttributeValues: { ":u": req.user.username },
        }));
        return result.Items || [];
      }
    });
    res.json({ results: data });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// Admin-only: list all S3 files
app.get("/admin/files", requireAuth, requireRole("Admins"), async (_req, res) => {
  try {
    const data = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 50 }));
    const files = (data.Contents || []).map(obj => ({
      key: obj.Key, size: obj.Size, lastModified: obj.LastModified
    }));
    res.json({ files });
  } catch (err) {
    console.error("❌ Failed to list S3 files:", err);
    res.status(500).json({ error: "Failed to list S3 files" });
  }
});

// RDS summary endpoint (aggregate query)
app.get("/history/rds/summary", requireAuth, requireRole("Admins"), async (_req, res) => {
  try {
    const result = await pgPool.query(`
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

// RDS filter-by-action endpoint
app.get("/history/rds/filter", requireAuth, async (req, res) => {
  let { action } = req.query;
  if (!action) return res.status(400).json({ error: "Please provide ?action=..." });
  action = action.trim().replace(/^"+|"+$/g, "").toLowerCase();
  try {
    const result = await pgPool.query(
      "SELECT * FROM jobs WHERE LOWER(action) = $1 ORDER BY created_at DESC",
      [action]
    );
    res.json({ results: result.rows });
  } catch (err) {
    console.error("❌ Failed to fetch RDS filtered jobs:", err.message);
    res.status(500).json({ error: "Failed to fetch RDS filtered jobs" });
  }
});

// RDS history endpoint (current user)
app.get("/history/rds/me", requireAuth, async (req, res) => {
  try {
    const result = await pgPool.query(
      "select * from jobs where user_id = $1 order by created_at desc",
      [req.user.username]
    );
    res.json({ results: result.rows });
  } catch (err) {
    console.error("❌ Failed to fetch RDS history:", err.message);
    res.status(500).json({ error: "Failed to fetch RDS history" });
  }
});

// ------------------------ S3 SIGNED URL HELPERS -----------------
async function signDownload(key) {
  return await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
}

app.get("/s3/upload-url", requireAuth, async (req, res) => {
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

app.get("/s3/download-url", requireAuth, async (req, res) => {
  try {
    const key = req.query.key;
    const url = await signDownload(key);
    res.json({ downloadUrl: url });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate pre-signed URL" });
  }
});

// =======================================================
// ==============  QUEUE-BASED ROUTES  ===================
// (Pure microservice: enqueue jobs; worker does work)
// =======================================================

// Convert images → PDF (queued)
app.post("/convert/images", requireAuth, upload.array("files", 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Upload at least one image" });

    const job = {
      type: "convert-images",
      username: req.user.username,
      files: req.files.map(f => ({ name: f.originalname, buffer: f.buffer.toString("base64"), mimetype: f.mimetype })),
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await addHistory(req.user.username, "queued: images->pdf", { count: req.files.length, names: req.files.map(f => f.originalname) });

    res.status(202).json({ message: "Job queued", jobType: job.type });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to queue images->pdf" });
  }
});

// Merge PDFs (queued)
app.post("/merge", requireAuth, upload.array("files", 50), async (req, res) => {
  try {
    if (!req.files || req.files.length < 2) return res.status(400).json({ error: "Upload at least two PDFs" });

    const job = {
      type: "merge-pdfs",
      username: req.user.username,
      files: req.files.map(f => ({ name: f.originalname, buffer: f.buffer.toString("base64") })),
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await addHistory(req.user.username, "queued: merge", { count: req.files.length, names: req.files.map(f => f.originalname) });

    res.status(202).json({ message: "Job queued", jobType: job.type });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to queue merge" });
  }
});

// LaTeX → PDF (queued)
app.post("/convert/latex", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No .tex file uploaded" });

    const job = {
      type: "latex->pdf",
      username: req.user.username,
      file: { name: req.file.originalname, buffer: req.file.buffer.toString("base64") },
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await addHistory(req.user.username, "queued: latex->pdf", { file: req.file.originalname });

    res.status(202).json({ message: "Job queued", jobType: job.type });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to queue LaTeX job" });
  }
});

// Heavy watermark (queued)
app.post("/watermark-heavy", requireAuth, upload.array("files", 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No PDF uploaded" });

    const job = {
      type: "watermark-heavy",
      username: req.user.username,
      files: req.files.map(f => ({ name: f.originalname, buffer: f.buffer.toString("base64") })),
    };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await addHistory(req.user.username, "queued: watermark-heavy", { count: req.files.length, names: req.files.map(f => f.originalname) });

    res.status(202).json({ message: "Job queued", jobType: job.type });
  } catch (err) {
    console.error("Heavy watermark queue error:", err);
    res.status(500).json({ error: "Failed to queue watermark job" });
  }
});

// External PDF fetch (queued) — optional url param
app.post("/external/fetchpdf", requireAuth, async (req, res) => {
  try {
    const urlParam = req.body?.url || "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
    const job = { type: "external-fetch", username: req.user.username, url: urlParam };

    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(job) }));
    await addHistory(req.user.username, "queued: external-fetch", { url: urlParam });

    res.status(202).json({ message: "Job queued", jobType: job.type });
  } catch (err) {
    console.error("External fetch queue error:", err.message);
    res.status(500).json({ error: "Failed to queue external fetch" });
  }
});

// ------------- BOOTSTRAP ----------------
async function loadSecrets() {
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: "n11621516-a2secret" }));
    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString);
      if (secret.JWT_SECRET) process.env.JWT_SECRET = secret.JWT_SECRET;
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
      "/n11621516/COGNITO_USER_POOL_ID",
      "/n11621516/COGNITO_CLIENT_ID",
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

// ----------- static & start ----------------
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
async function init() {
  await loadSecrets();
  await loadParameters();
  app.listen(PORT, () => console.log(`PDF converter API (producer) running on port ${PORT}`));
}
init();
