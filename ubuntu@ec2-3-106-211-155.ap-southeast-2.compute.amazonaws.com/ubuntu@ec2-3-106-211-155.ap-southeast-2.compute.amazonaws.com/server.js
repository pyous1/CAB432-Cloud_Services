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



const USERS = [
  { username: "admin", password: "admin123", role: "admin" },
  { username: "Grace", password: "Grace123", role: "user" },
  { username: "Max", password: "Max123", role: "user" }
];

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "10mb" }));

// Upload config (keep files in memory, max 25MB each)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Middleware: role checker ---
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: "Forbidden: Admins only" });
    }
    next();
  };
}

// --- History route (admins only) ---
app.use("/history", requireAuth, requireRole("admin"), historyRouter);

app.get("/history", requireAuth, requireRole("admin"), (req, res) => {
  const { page = 1, limit = 10, action, sort = "created_at", order = "DESC" } = req.query;

  let query = "SELECT * FROM history";
  const params = [];

  if (action) {
    query += " WHERE action = ?";
    params.push(action);
  }

  query += ` ORDER BY ${sort} ${order.toUpperCase() === "ASC" ? "ASC" : "DESC"}`;
  query += " LIMIT ? OFFSET ?";
  params.push(Number(limit), (Number(page) - 1) * Number(limit));

  const rows = db.prepare(query).all(...params);
  res.json({
    page: Number(page),
    limit: Number(limit),
    sort,
    order,
    results: rows
  });
});



// Convert multiple images (JPG/PNG) into a single PDF
app.post("/convert/images", requireAuth, upload.array("files", 50), async (req, res) => {
  addHistory(req.user.username, "images->pdf", { files: req.files.map(f => f.originalname) });
  console.log(`User ${req.user.username} is converting images`);

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Upload at least one image as 'files'." });
    }

    const pdfDoc = await PDFDocument.create();
    const A4 = { w: 595.28, h: 841.89 }; // A4 size in points

    for (const f of req.files) {
      const type = f.mimetype.toLowerCase();
      const isPng = type.includes("png");
      const isJpeg = type.includes("jpeg") || type.includes("jpg");
      if (!isPng && !isJpeg) {
        return res.status(400).json({ error: `Unsupported type ${f.mimetype}. Only PNG/JPG allowed.` });
      }

      const img = isPng ? await pdfDoc.embedPng(f.buffer) : await pdfDoc.embedJpg(f.buffer);
      const iw = img.width, ih = img.height;

      const page = pdfDoc.addPage([A4.w, A4.h]);
      const scale = Math.min(A4.w / iw, A4.h / ih);
      const w = iw * scale, h = ih * scale;
      const x = (A4.w - w) / 2, y = (A4.h - h) / 2;

      page.drawImage(img, { x, y, width: w, height: h });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="images.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Image-to-PDF conversion failed." });
  }
});

// Merge multiple PDFs into one
app.post("/merge", requireAuth, upload.array("files", 50), async (req, res) => {
  addHistory(req.user.username, "merge", { files: req.files.map(f => f.originalname) });
  console.log(`User ${req.user.username} is merging PDFs`);

  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: "Upload at least two PDFs as 'files'." });
    }

    const out = await PDFDocument.create();

    for (const f of req.files) {
      if (!f.mimetype.toLowerCase().includes("pdf")) {
        return res.status(400).json({ error: `Unsupported type ${f.mimetype}. Only PDFs allowed.` });
      }
      const src = await PDFDocument.load(f.buffer);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    }

    const pdfBytes = await out.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="merged.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF merge failed." });
  }
});

// Convert LaTeX into PDF
app.post("/convert/latex", requireAuth, upload.single("file"), (req, res) => {
  addHistory(req.user.username, "latex->pdf", { file: req.file?.originalname });
  console.log(`User ${req.user.username} is converting LaTeX`);

  if (!req.file) {
    return res.status(400).json({ error: "No .tex file uploaded" });
  }

  const texPath = path.join("/tmp", "input.tex");
  const pdfPath = path.join("/tmp", "input.pdf");

  fs.writeFileSync(texPath, req.file.buffer);

  exec(`pdflatex -interaction=nonstopmode -output-directory=/tmp ${texPath}`, (err, stdout, stderr) => {
    if (err) {
      console.error("LaTeX compilation error:", stderr);
      return res.status(500).json({ error: "LaTeX compilation failed", details: stderr });
    }

    if (!fs.existsSync(pdfPath)) {
      return res.status(500).json({ error: "PDF not generated" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.download(pdfPath, "output.pdf", () => {
      try { fs.unlinkSync(texPath); } catch {}
      try { fs.unlinkSync(pdfPath); } catch {}
    });
  });
});

// Watermark Function (unchanged, default repeat = 100)
async function addWatermarkBuffer(pdfBuffer, text = "WATERMARK", repeat = 100) {
  let pdfDoc;

  for (let i = 0; i < repeat; i++) {
    pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    pages.forEach((page) => {
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

    // Export back to buffer each loop
    pdfBuffer = await pdfDoc.save();
  }

  return Buffer.from(pdfBuffer);
}



// Watermark endpoint (multiple PDFs, parallel)
app.post("/watermark", requireAuth, upload.array("files", 10), async (req, res) => {
  console.log("Received files:", req.files?.map(f => f.originalname));

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    // Process ALL PDFs in parallel, each with repeat=100
    const processed = await Promise.all(
      req.files.map(f => addWatermarkBuffer(f.buffer, "CONFIDENTIAL", 100))
    );

    // For simplicity, just return the first processed file
    // (you could also merge them if required)
    const watermarkedPdf = processed[0];

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="watermarked.pdf"');
    res.send(watermarkedPdf);

  } catch (err) {
    console.error("Watermark error:", err);
    res.status(500).json({ error: "Watermarking failed", details: err.message });
  }
});

// Function to fetch a PDF from a URL
async function fetchExternalPDF(pdfUrl, saveToFile = false) {
  try {
    const response = await axios.get(pdfUrl, { responseType: "arraybuffer" });

    if (saveToFile) {
      const outputPath = path.join("/tmp", "external.pdf");
      fs.writeFileSync(outputPath, response.data);
      console.log("PDF saved to:", outputPath);
      return outputPath;
    }

    // Return the buffer for further processing
    return Buffer.from(response.data);

  } catch (error) {
    console.error("Error fetching PDF:", error.message);
    throw new Error("Failed to fetch external PDF");
  }
}

// 
app.get("/external/fetchpdf", requireAuth, async (req, res) => {
  try {
    // Example public PDF URL
    const pdfUrl = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

    // Fetch the PDF as a Buffer
    const pdfBuffer = await fetchExternalPDF(pdfUrl);

    // Send it back to the user as a file download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="external.pdf"');
    res.send(pdfBuffer);

  } catch (err) {
    console.error("External PDF fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch external PDF" });
  }
});





// Login endpoint
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const found = USERS.find(u => u.username === username && u.password === password);
  if (!found) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  // Make a token
  const token = jwt.sign(
    { username: found.username, role: found.role },
    SECRET,
    { expiresIn: "1h" }
  );

  res.json({ token });
});

// WEB client 
app.use(express.static(path.join(__dirname, "public")));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF converter running on port ${PORT}`));



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

