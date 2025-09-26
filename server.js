require("dotenv").config();

const jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "dev-secret";
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { router: historyRouter, addHistory } = require("./routes/history");
const { requireAuth } = require("./routes/auth");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const axios = require("axios");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: "ap-southeast-2" });
const BUCKET = process.env.S3_BUCKET || "my-pdf-storage-sydney";

const { CognitoIdentityProviderClient, SignUpCommand, ConfirmSignUpCommand, InitiateAuthCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { CognitoJwtVerifier } = require("aws-jwt-verify");

const { RespondToAuthChallengeCommand } = require("@aws-sdk/client-cognito-identity-provider");

const cognito = new CognitoIdentityProviderClient({ region: "ap-southeast-2" });

const crypto = require("crypto");

function hashSecret(username) {
  return crypto
    .createHmac("SHA256", process.env.COGNITO_CLIENT_SECRET)
    .update(username + process.env.COGNITO_CLIENT_ID)
    .digest("base64");
}

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

// confirm
const { AssociateSoftwareTokenCommand } = require("@aws-sdk/client-cognito-identity-provider");
const QRCode = require("qrcode");

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


// verify
const { VerifySoftwareTokenCommand } = require("@aws-sdk/client-cognito-identity-provider");

// Endpoint: /auth/verify-totp
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

// MFA user
const { SetUserMFAPreferenceCommand } = require("@aws-sdk/client-cognito-identity-provider");

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

// Upload config 
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

//Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Middleware: role checker
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: "Forbidden: Admins only" });
    }
    next();
  };
}

// History route
app.use("/history", requireAuth, requireRole("admin"), historyRouter);

// Helper 
async function uploadToS3(buffer, key, contentType = "application/pdf") {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
  return `https://${BUCKET}.s3.ap-southeast-2.amazonaws.com/${key}`;
}

// Convert images into PDF 
app.post("/convert/images", requireAuth, upload.array("files", 50), async (req, res) => {
  addHistory(req.user.username, "images->pdf", { files: req.files.map(f => f.originalname) });

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
  addHistory(req.user.username, "merge", { files: req.files.map(f => f.originalname) });

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

  exec(`pdflatex -interaction=nonstopmode -output-directory=/tmp ${texPath}`, async (err) => {
    if (err || !fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: "LaTeX compilation failed" });
    }

    const buffer = fs.readFileSync(pdfPath);
    const key = `latex/${Date.now()}-latex.pdf`;
    const url = await uploadToS3(buffer, key);

    res.json({ message: "LaTeX PDF uploaded to S3", url });

    try { fs.unlinkSync(texPath); } catch {}
    try { fs.unlinkSync(pdfPath); } catch {}
  });
});

// Watermark function
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
        opacity: 0.3,
      });
    });
    pdfBuffer = await pdfDoc.save();
  }
  return Buffer.from(pdfBuffer);
}

// Watermark endpoint
app.post("/watermark-heavy", requireAuth, upload.array("files", 5), async (req, res) => {
  addHistory(req.user.username, "watermark-heavy", { files: req.files.map(f => f.originalname) });

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
    res.status(500).json({ error: "Heavy watermarking failed", details: err.message });
  }
});

// Fetch external PDF
app.get("/external/fetchpdf", requireAuth, async (req, res) => {
  try {
    const pdfUrl = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
    const response = await axios.get(pdfUrl, { responseType: "arraybuffer" });

    const key = `external/${Date.now()}-external.pdf`;
    const url = await uploadToS3(Buffer.from(response.data), key);

    res.json({ message: "External PDF uploaded to S3", url });
  } catch (err) {
    console.error("External PDF fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch external PDF" });
  }
});

const USERS = [
  { username: "admin", password: "admin123", role: "admin" },
  { username: "Grace", password: "Grace123", role: "user" },
  { username: "Max", password: "Max123", role: "user" }
];

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

    // Handle MFA challenges
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


// Web client server
app.use(express.static(path.join(__dirname, "public")));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF converter running on port ${PORT}`));

