const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const BASE = process.env.BASE || "http://localhost:3000";
const TOKEN = process.env.TOKEN;
const IMAGE = process.env.IMAGE;
const PARALLEL = parseInt(process.env.PARALLEL || "10"); 


if (!TOKEN || !IMAGE) {
  console.error("Usage: TOKEN=your_token IMAGE=path/to/file node loadtest2.js");
  process.exit(1);
}

// Read file once at startup
const fileBuffer = fs.readFileSync(IMAGE);

async function runBatch() {
  const requests = [];

  for (let i = 0; i < PARALLEL; i++) {
    const form = new FormData();
    form.append("files", fileBuffer, "sample.pdf");

    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      ...form.getHeaders(),
    };

    requests.push(
      axios.post(`${BASE}/watermark-heavy`, form, { headers })
        .catch(err => console.error("Error:", err.response?.status || err.message))
    );
  }

  await Promise.all(requests);
  console.log(`Batch complete (${PARALLEL} requests)`);
}


setInterval(runBatch, 500);

