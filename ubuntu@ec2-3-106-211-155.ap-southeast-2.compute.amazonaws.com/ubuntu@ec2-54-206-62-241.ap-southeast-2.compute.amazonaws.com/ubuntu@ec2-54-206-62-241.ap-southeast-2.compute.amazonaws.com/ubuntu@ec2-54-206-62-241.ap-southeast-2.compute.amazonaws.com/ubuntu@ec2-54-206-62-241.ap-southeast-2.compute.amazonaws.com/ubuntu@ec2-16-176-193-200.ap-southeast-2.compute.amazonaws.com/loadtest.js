const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

const BASE = "http://ec2-3-26-37-175.ap-southeast-2.compute.amazonaws.com:3000";
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzU2OTYzNDgzLCJleHAiOjE3NTY5NjcwODN9.wah2iIPvK_GeYv1bulbjlXBJtdNbZE844on7hBn12YQ";
const FILE_PATH = "/home/ubuntu/pdf-converter/sample_1.pdf";// upload a test file

async function runBatch() {
  const file = fs.readFileSync(FILE_PATH);
  const form = new FormData();
  form.append("files", file, "sample.pdf");

  const headers = { 
    Authorization: `Bearer ${TOKEN}`,
    ...form.getHeaders()
  };

  const requests = [];
  for (let i = 0; i < 5; i++) { // 5 parallel requests per batch
    requests.push(
      axios.post(`${BASE}/watermark`, form, { headers })
        .catch(err => console.error("Error:", err.response?.status || err.message))
    );
  }

  await Promise.all(requests);
  console.log("Batch complete");
}

setInterval(runBatch, 2000); // every 2 seconds
