require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const axios = require("axios");


// AWS
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, InitiateAuthCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { RespondToAuthChallengeCommand } = require("@aws-sdk/client-cognito-identity-provider");
const secretsClient = new SecretsManagerClient({ region: "ap-southeast-2" });
const secretName = "n11621516-a2secret";


// AWS Clients 
const s3 = new S3Client({ region: "ap-southeast-2" });
const BUCKET = process.env.S3_BUCKET || "my-pdf-storage-sydney";

const { CognitoJwtVerifier } = require("aws-jwt-verify");
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: process.env.COGNITO_CLIENT_ID,
  clientId: process.env.COGNITO_CLIENT_ID,
});


const cognito = new CognitoIdentityProviderClient({ region: "ap-southeast-2" });

const crypto = require("crypto");

function hashSecret(username) {
  return crypto
    .createHmac("SHA256", process.env.COGNITO_CLIENT_SECRET)
    .update(username + process.env.COGNITO_CLIENT_ID)
    .digest("base64");
}
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

// confirm
const { AssociateSoftwareTokenCommand } = require("@aws-sdk/client-cognito-identity-provider");
const QRCode = require("qrcode");

// verify
const { VerifySoftwareTokenCommand } = require("@aws-sdk/client-cognito-identity-provider");

// MFA user
const { SetUserMFAPreferenceCommand } = require("@aws-sdk/client-cognito-identity-provider");

// File Upload config
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// ------------------- AUTHENTICATION ----------------------------

// Auth middleware
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const payload = await verifier.verify(token);
    req.user = payload; // contains username, sub, etc.
    next();
  } catch (err) { 
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

// Role checker
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user["cognito:groups"]?.[0] !== role) {
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
        { Name: "name", Value: fullName || username }  // required full name
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
      return res.json({
        challenge: out.ChallengeName,
        session: out.Session,
      });
    }

    // Normal login
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
  const { accessToken, username } = req.body; // need username for display
  try {
    const cmd = new AssociateSoftwareTokenCommand({ AccessToken: accessToken });
    const out = await cognito.send(cmd);

    const secret = out.SecretCode;

    // Build otpauth:// URI
    const issuer = "PDFConverter"; // your app name
    const uri = `otpauth://totp/${issuer}:${username}?secret=${secret}&issuer=${issuer}`;

    // Generate QR code as Data URL
    const qrCodeDataURL = await QRCode.toDataURL(uri);

    res.json({
      secret,
      uri,
      qrCode: qrCodeDataURL // can be displayed in browser or decoded by Hoppscotch
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verify OTP
app.post("/auth/verify-totp", async (req, res) => {
  const { accessToken, code } = req.body; // code = 6-digit from authenticator app
  try {
    const cmd = new VerifySoftwareTokenCommand({
      AccessToken: accessToken,
      UserCode: code,
    });
    const out = await cognito.send(cmd);
    res.json({ status: out.Status }); // "SUCCESS" if correct
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// MFA 
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
      SoftwareTokenMfaSettings: {
        Enabled: true,
        PreferredMfa: true,
      },
    });
    await cognito.send(cmd);
    res.json({ message: "MFA set to TOTP for this user" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// -------------------- CORE ROUTES ------------------------

// Health check 
app.get("/health", (_req, res) => res.json({ ok: true }));

// History logging
async function addHistory(username, action, details) {
  await ddb.send(
    new PutCommand({
      TableName: HISTORY_TABLE,
      Item: { username, timestamp: Date.now(), action, details, created_at: new Date().toISOString() },
    })
  );
}

// Get history
app.get("/history", requireAuth, async (req, res) => {
  try {
    let items = [];
    if (req.user["cognito:groups"]?.includes("admin")) {
      const data = await ddb.send(new ScanCommand({ TableName: HISTORY_TABLE }));
      items = data.Items || [];
    } else {
      const data = await ddb.send(
        new QueryCommand({
          TableName: HISTORY_TABLE,
          KeyConditionExpression: "username = :u",
          ExpressionAttributeValues: { ":u": req.user.username },
        })
      );
      items = data.Items || [];
    }
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ results: items });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// S3 upload helper
async function uploadToS3(buffer, key, contentType = "application/pdf") {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return `https://${BUCKET}.s3.ap-southeast-2.amazonaws.com/${key}`;
}

//  ------------------------ PDF ROUTES -----------------

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

//------------- BOOTSRAP ----------------

// Secrets Manager
async function loadSecrets() {
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
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

// Parameter Store
async function loadParameters() {
  try {
    const param = await ssm.send(new GetParameterCommand({ Name: "/n11621516/pdf_parameter" }));
    process.env.APP_URL = param.Parameter.Value;
    console.log("Parameter loaded from SSM ✅", process.env.APP_URL);
  } catch (err) {
    console.error("Failed to load parameter:", err);
  }
}

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
async function init() {
  await loadSecrets();
  await loadParameters();
  app.listen(PORT, () => console.log(`PDF converter running on port ${PORT}`));
}
init();