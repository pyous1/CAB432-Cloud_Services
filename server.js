// Imports
const jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "dev-secret";
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const axios = require("axios");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

// AWS Clients 
const s3 = new S3Client({ region: "ap-southeast-2" });
const BUCKET = process.env.S3_BUCKET || "my-pdf-storage-sydney";
const ssm = new SSMClient({ region: "ap-southeast-2" });

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "ap-southeast-2" })
);
const HISTORY_TABLE = process.env.HISTORY_TABLE || "pdf-history";

// Express setup 
const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

// File Upload config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Auth middleware 
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = decoded; // { username, role }
    next();
  });
}

// Role checker
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: "Forbidden: Admins only" });
    }
    next();
  };
}

// Health check 
app.get("/health", (_req, res) => res.json({ ok: true }));

// History helpers
async function addHistory(username, action, details) {
  await ddb.send(
    new PutCommand({
      TableName: HISTORY_TABLE,
      Item: {
        username,                               // partition key
        timestamp: Date.now(),      // sort key
        action,
        details,
        created_at: new Date().toISOString()
      }
    })
  );
}

// GET history (admin sees all, users see their own)
app.get("/history", requireAuth, async (req, res) => {
  try {
    let items = [];

    if (req.user.role === "admin") {
      const data = await ddb.send(new ScanCommand({ TableName: HISTORY_TABLE }));
      items = data.Items || [];
    } else {
      const data = await ddb.send(
        new QueryCommand({
          TableName: HISTORY_TABLE,
          KeyConditionExpression: "username = :u",
          ExpressionAttributeValues: { ":u": req.user.username }
        })
      );
      items = data.Items || [];
    }

    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ results: items });
  } catch (err) {
    console.error("History fetch error:", err);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// S3 Helper
async function uploadToS3(buffer, key, contentType = "application/pdf") {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType
    })
  );
  return `https://${BUCKET}.s3.ap-southeast-2.amazonaws.com/${key}`;
}

// Convert images into PDF
app.post("/convert/images", requireAuth, upload.array("files", 50), async (req, res) => {
  await addHistory(req.user.username, "images->pdf", {
    files: req.files.map(f => f.originalname)
  });

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Upload at least one image as 'files'." });
    }

    const pdfDoc = await PDFDocument.create();
    const A4 = { w: 595.28, h: 841.89 };

    for (const f of req.files) {
      const type = f.mimetype.toLowerCase();
      const img = type.includes("png")
        ? await pdfDoc.embedPng(f.buffer)
        : await pdfDoc.embedJpg(f.buffer);

      const iw = img.width, ih = img.height;
      const page = pdfDoc.addPage([A4.w, A4.h]);
      const scale = Math.min(A4.w / iw, A4.h / ih);
      const w = iw * scale, h = ih * scale;
      const x = (A4.w - w) / 2, y = (A4.h - h) / 2;

      page.drawImage(img, { x, y, width: w, height: h });
    }

    const pdfBytes = await pdfDoc.save();
    const key = `images/${Date.now()}-images.pdf`;
    const url = await uploadToS3(Buffer.from(pdfBytes), key);

    res.json({ message: "PDF uploaded to S3", url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Image-to-PDF conversion failed." });
  }
});

// Merge PDFs
app.post("/merge", requireAuth, upload.array("files", 50), async (req, res) => {
  await addHistory(req.user.username, "merge", {
    files: req.files.map(f => f.originalname)
  });

  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "Upload at least two PDFs as 'files'." });
    }

    const out = await PDFDocument.create();

    for (const f of req.files) {
      const src = await PDFDocument.load(f.buffer);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    }

    const pdfBytes = await out.save();
    const key = `merge/${Date.now()}-merged.pdf`;
    const url = await uploadToS3(Buffer.from(pdfBytes), key);

    res.json({ message: "Merged PDF uploaded to S3", url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF merge failed." });
  }
});

// Convert LaTeX into PDF
app.post("/convert/latex", requireAuth, upload.single("file"), (req, res) => {
  addHistory(req.user.username, "latex->pdf", { file: req.file?.originalname });

  if (!req.file) {
    return res.status(400).json({ error: "No .tex file uploaded" });
  }

  const texPath = path.join("/tmp", "input.tex");
  const pdfPath = path.join("/tmp", "input.pdf");
  fs.writeFileSync(texPath, req.file.buffer);

  exec(
    `pdflatex -interaction=nonstopmode -output-directory=/tmp ${texPath}`,
    async (err) => {
      if (err || !fs.existsSync(pdfPath)) {
        return res.status(500).json({ error: "LaTeX compilation failed" });
      }

      const buffer = fs.readFileSync(pdfPath);
      const key = `latex/${Date.now()}-latex.pdf`;
      const url = await uploadToS3(buffer, key);

      res.json({ message: "LaTeX PDF uploaded to S3", url });

      try { fs.unlinkSync(texPath); } catch {}
      try { fs.unlinkSync(pdfPath); } catch {}
    }
  );
});

// Watermark
async function addWatermarkBuffer(pdfBuffer, text = "WATERMARK", repeat = 100) {
  let pdfDoc;
  for (let i = 0; i < repeat; i++) {
    pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    pages.forEach(page => {
      const { width, height } = page.getSize();
      page.drawText(text, {
        x: width / 4,
        y: height / 2,
        size: 50,
        font,
        color: rgb(0.95, 0.1, 0.1),
        rotate: { type: "degrees", angle: 45 },
        opacity: 0.3
      });
    });
    pdfBuffer = await pdfDoc.save();
  }
  return Buffer.from(pdfBuffer);
}

app.post("/watermark-heavy", requireAuth, upload.array("files", 5), async (req, res) => {
  await addHistory(req.user.username, "watermark-heavy", {
    files: req.files.map(f => f.originalname)
  });

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const processed = await Promise.all(
      req.files.map(f => addWatermarkBuffer(f.buffer, "CONFIDENTIAL", 1000))
    );

    const key = `watermark-heavy/${Date.now()}-heavy.pdf`;
    const url = await uploadToS3(processed[0], key);

    res.json({ message: "Heavy watermark PDF uploaded to S3", url });
  } catch (err) {
    console.error("Heavy watermark error:", err);
    res.status(500).json({
      error: "Heavy watermarking failed",
      details: err.message
    });
  }
});

// External PDF fetch
app.get("/external/fetchpdf", requireAuth, async (req, res) => {
  try {
    const pdfUrl =
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
    const response = await axios.get(pdfUrl, { responseType: "arraybuffer" });

    const key = `external/${Date.now()}-external.pdf`;
    const url = await uploadToS3(Buffer.from(response.data), key);

    res.json({ message: "External PDF uploaded to S3", url });
  } catch (err) {
    console.error("External PDF fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch external PDF" });
  }
});

// Local USERS + Login
const USERS = [
  { username: "admin", password: "admin123", role: "admin" },
  { username: "Grace", password: "Grace123", role: "user" },
  { username: "Max", password: "Max123", role: "user" }
];

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const found = USERS.find(
    (u) => u.username === username && u.password === password
  );
  if (!found) return res.status(401).json({ error: "Invalid username or password" });

  const token = jwt.sign(
    { username: found.username, role: found.role },
    SECRET,
    { expiresIn: "1h" }
  );
  res.json({ token });
});

// secrets manager 
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const secretName = "n11621516-a2secret";  // use your actual secret name
const secretsClient = new SecretsManagerClient({ region: "ap-southeast-2" });

async function loadSecrets() {
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

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

// paramter manager 
async function loadParameters() {
  try {
    const param = await ssm.send(
      new GetParameterCommand({
        Name: "/n11621516/pdf_parameter"
      })
    );

    process.env.APP_URL = param.Parameter.Value;
    console.log("Parameter loaded from SSM ✅", process.env.APP_URL);
  } catch (err) {
    console.error("Failed to load parameter:", err);
  }
}


// static files
app.use(express.static(path.join(__dirname, "public")));

// Start server 
const PORT = process.env.PORT || 3000;

async function init() {
  await loadSecrets();     // Secrets Manager (JWT_SECRET etc.)
  await loadParameters();  // Parameter Store (app URL etc.)

  app.listen(PORT, () =>
    console.log(`PDF converter running on port ${PORT}`)
  );
}

init();
