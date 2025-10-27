import axios from "axios";

export const handler = async (event) => {
  console.log("📦 S3 event:", JSON.stringify(event, null, 2));

  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  const apiUrl = "https://pdfworker.cab432.com/api/notify";

  try {
    const response = await axios.post(apiUrl, { bucket, key });
    console.log("✅ API call successful:", response.data);
  } catch (err) {
    console.error("❌ API call failed:", err.message);
  }

  return { statusCode: 200, body: "Lambda notification sent." };
};
