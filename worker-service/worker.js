// ============================
// WORKER SERVICE (Consumer)
// ============================
require("dotenv").config();

const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { EventBridgeClient, PutEventsCommand } = require("@aws-sdk/client-eventbridge");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const HISTORY_TABLE = process.env.HISTORY_TABLE;

const region = "ap-southeast-2";
const sqs = new SQSClient({ region });
const s3  = new S3Client({ region });
const eb  = new EventBridgeClient({ region });

const sqsUrl = process.env.SQS_QUEUE_URL || process.env.SQS_URL;
const bucket = process.env.S3_BUCKET;
// Use your custom bus name (confirmed)
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "n11621516-pdf-event-bus";

if (!sqsUrl) { console.error("❌ Missing SQS_QUEUE_URL (.env)"); process.exit(1); }
if (!bucket) { console.error("❌ Missing S3_BUCKET (.env)"); process.exit(1); }

async function uploadResult(buffer, key, contentType = "application/pdf") {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
  console.log("⬆️  Uploaded:", key);
}

// ========== Job handlers ==========
async function handleConvertImages(job) {
  const pdfDoc = await PDFDocument.create();
  const A4 = { w: 595.28, h: 841.89 };
  for (const f of job.files) {
    const imgBytes = Buffer.from(f.buffer, "base64");
    const mime = (f.mimetype || "").toLowerCase();
    const isPng = mime.includes("png") || f.name.toLowerCase().endsWith(".png");
    const image = isPng ? await pdfDoc.embedPng(imgBytes) : await pdfDoc.embedJpg(imgBytes);
    const iw = image.width, ih = image.height;
    const page = pdfDoc.addPage([A4.w, A4.h]);
    const scale = Math.min(A4.w / iw, A4.h / ih);
    const w = iw * scale, h = ih * scale;
    const x = (A4.w - w) / 2, y = (A4.h - h) / 2;
    page.drawImage(image, { x, y, width: w, height: h });
  }
  const pdfBytes = await pdfDoc.save();
  const key = `results/${job.username}-images-${Date.now()}.pdf`;
  await uploadResult(Buffer.from(pdfBytes), key);
  return key;
}
async function handleMergePDFs(job) {
  const merged = await PDFDocument.create();
  for (const f of job.files) {
    const src = await PDFDocument.load(Buffer.from(f.buffer, "base64"));
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  const pdfBytes = await merged.save();
  const key = `results/${job.username}-merged-${Date.now()}.pdf`;
  await uploadResult(Buffer.from(pdfBytes), key);
  return key;
}
async function handleWatermark(job) {
  const srcBytes = Buffer.from(job.files[0].buffer, "base64");
  const pdfDoc = await PDFDocument.load(srcBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  pages.forEach(page => {
    const { width, height } = page.getSize();
    page.drawText("CONFIDENTIAL", {
      x: width / 4, y: height / 2, size: 50, font,
      color: rgb(0.95, 0.1, 0.1), rotate: { type: "degrees", angle: 45 }, opacity: 0.3,
    });
  });
  const watermarked = await pdfDoc.save();
  const key = `results/${job.username}-watermarked-${Date.now()}.pdf`;
  await uploadResult(Buffer.from(watermarked), key);
  return key;
}
async function handleLatex(job) {
  const texBuffer = Buffer.from(job.file.buffer, "base64");
  const texPath = path.join("/tmp", `input-${Date.now()}.tex`);
  const outDir  = "/tmp";
  const pdfPath = path.join(outDir, "input.pdf");
  fs.writeFileSync(texPath, texBuffer);

  await new Promise((resolve, reject) => {
    exec(`pdflatex -interaction=nonstopmode -output-directory=${outDir} ${texPath}`, (err) => {
      if (err || !fs.existsSync(pdfPath)) return reject(new Error("LaTeX compilation failed"));
      resolve();
    });
  });

  const pdfBytes = fs.readFileSync(pdfPath);
  const key = `results/${job.username}-latex-${Date.now()}.pdf`;
  await uploadResult(pdfBytes, key);

  try { fs.unlinkSync(texPath); } catch {}
  try { fs.unlinkSync(pdfPath); } catch {}
  return key;
}
async function handleExternalFetch(job) {
  const pdfUrl = job.url || "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
  const response = await axios.get(pdfUrl, { responseType: "arraybuffer" });
  const key = `results/${job.username}-external-${Date.now()}.pdf`;
  await uploadResult(Buffer.from(response.data), key);
  return key;
}

async function addHistory(username, action, details) {
  if (!HISTORY_TABLE) return;
  try {
    await ddb.send(new PutCommand({
      TableName: HISTORY_TABLE,
      Item: {
        username,
        timestamp: Date.now(),
        action,
        details,
        created_at: new Date().toISOString(),
      },
    }));
  } catch (e) {
    console.error("⚠️ DDB history write failed:", e.message);
  }
}

// ========== Dispatcher ==========
async function processJob(job) {
  try {
    // 🟢 1. Mark job as started (goes into DynamoDB history)
    await addHistory(job.username, "worker: IN_PROGRESS", {
      jobId: job.jobId,
      type: job.type,
    });

    console.log(`🔧 Processing ${job.type} for ${job.username} (jobId=${job.jobId || "n/a"})`);

    // 🧩 2. Run the correct handler based on job type
    let resultKey = null;
    switch (job.type) {
      case "convert-images":
        resultKey = await handleConvertImages(job);
        break;
      case "merge-pdfs":
        resultKey = await handleMergePDFs(job);
        break;
      case "watermark-heavy":
        resultKey = await handleWatermark(job);
        break;
      case "latex->pdf":
        resultKey = await handleLatex(job);
        break;
      case "external-fetch":
        resultKey = await handleExternalFetch(job);
        break;
      default:
        console.warn("⚠️ Unknown job type:", job.type);
        return;
    }

    // 🟢 3. Mark job as completed (after handler finishes)
    if (resultKey) {
      await addHistory(job.username, "worker: COMPLETED", {
        jobId: job.jobId,
        type: job.type,
        resultKey,
      });
      console.log(`✅ Job completed (${job.type}) -> ${resultKey}`);
    } else {
      console.warn(`⚠️ No resultKey returned for ${job.jobId}`);
    }
  } catch (err) {
    console.error(`❌ Error processing job ${job.jobId}:`, err);
    // You can optionally add a "FAILED" history entry here
    await addHistory(job.username, "worker: FAILED", {
      jobId: job.jobId,
      type: job.type,
      error: err.message,
    });
  }
}


// ========== EventBridge notify ==========
async function notifyJobComplete(job, resultKey) {
  const entry = {
    Source: "pdf.worker",
    DetailType: "PDFJobCompleted",
    Detail: JSON.stringify({
      jobId: job.jobId || null,
      username: job.username,
      type: job.type,
      resultKey,
      timestamp: new Date().toISOString()
    }),
    EventBusName: EVENT_BUS_NAME
  };
  const resp = await eb.send(new PutEventsCommand({ Entries: [entry] }));
  console.log("📨 EventBridge PutEvents response:", JSON.stringify(resp));
}

// ========== Poll loop ==========
async function poll() {
  console.log("📡 Worker polling SQS:", sqsUrl);
  while (true) {
    const data = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: sqsUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 120,
    }));

    if (!data.Messages) continue;

    for (const m of data.Messages) {
      try {
        const job = JSON.parse(m.Body);
        const resultKey = await processJob(job);
        console.log("✅ Job processed:", { jobId: job.jobId, resultKey });

        // Notify EventBridge AFTER success
        await notifyJobComplete(job, resultKey);

        // Delete from queue
        await sqs.send(new DeleteMessageCommand({ QueueUrl: sqsUrl, ReceiptHandle: m.ReceiptHandle }));
        console.log("🧹 SQS message deleted");
      } catch (err) {
        console.error("❌ Job failed:", err.message);
        // Let SQS redrive / DLQ handle failures if configured
      }
    }
  }
}
poll();
