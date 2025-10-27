// worker.js
const express = require("express");
const os = require("os");
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const QUEUE_URL = "https://sqs.ap-southeast-2.amazonaws.com/901444280953/n11621516-pdf-jobs";

const sqs = new SQSClient({ region: "ap-southeast-2" });
const s3 = new S3Client({ region: "ap-southeast-2" });

// ------------------- HEALTH ENDPOINTS (for ECS/ALB) -------------------
app.get("/health", (_req, res) => res.status(200).send("OK"));
app.get("/", (_req, res) => res.send(`PDF worker running on ${os.hostname()}`));

// ------------------- JOB POLLING LOOP -------------------
async function pollJobs() {
  console.log("🧾 PDF Worker started. Polling SQS for jobs...");
  while (true) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: QUEUE_URL,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 10, // long polling
        })
      );

      if (response.Messages && response.Messages.length > 0) {
        const msg = response.Messages[0];
        const job = JSON.parse(msg.Body);
        console.log(`📄 Received job: ${job.key}`);

        // Example: simulate PDF processing (you could add watermark, merge, etc.)
        const filePath = path.join("/tmp", `${Date.now()}-${path.basename(job.key)}`);
        console.log(`⬇️ Downloading ${job.key} from S3...`);

        const s3Obj = await s3.send(new GetObjectCommand({ Bucket: job.bucket, Key: job.key }));
        const fileStream = fs.createWriteStream(filePath);
        await new Promise((resolve, reject) => {
          s3Obj.Body.pipe(fileStream);
          s3Obj.Body.on("error", reject);
          fileStream.on("finish", resolve);
        });

        console.log(`✅ Processed job: ${filePath}`);

        // Delete message from queue to mark complete
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: msg.ReceiptHandle,
          })
        );
        console.log(`🗑️ Job deleted from queue`);
      }
    } catch (err) {
      console.error("❌ Worker error:", err.message);
      await new Promise((r) => setTimeout(r, 5000)); // backoff before retry
    }
  }
}

// ------------------- STARTUP -------------------
app.listen(PORT, () => {
  console.log(`Worker listening on port ${PORT}`);
  pollJobs();
});

