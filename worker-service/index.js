const {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} = require("@aws-sdk/client-sqs");

const region = "ap-southeast-2";
const sqsQueueUrl = " https://sqs.ap-southeast-2.amazonaws.com/901444280953/n11621516-pdf-jobs";

const sqs = new SQSClient({ region });

async function main() {
  await sqs.send(new SendMessageCommand({
    QueueUrl: sqsQueueUrl,
    MessageBody: JSON.stringify({ task: "test", file: "dummy.pdf" }),
  }));
  console.log("✅ Message sent");

  const { Messages } = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: sqsQueueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 5,
  }));

  if (Messages) {
    console.log("📥 Received:", Messages[0].Body);
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: sqsQueueUrl,
      ReceiptHandle: Messages[0].ReceiptHandle,
    }));
    console.log("🗑️ Deleted message");
  }
}

main();
