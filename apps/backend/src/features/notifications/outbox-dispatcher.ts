import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { documentClient, getTableName } from "../../shared/dynamo";

const sqs = new SQSClient({});
const notificationQueueUrl = process.env.NOTIFICATION_QUEUE_URL;

export async function handler(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    if (record.eventName !== "INSERT" || image?.entityType?.S !== "NOTIFICATION_OUTBOX") continue;

    const notificationId = image.notificationId?.S;
    const familyId = image.familyId?.S;
    const recipientId = image.recipientId?.S;
    const notificationType = image.notificationType?.S;
    const referenceId = image.referenceId?.S;
    const createdAt = image.createdAt?.S;
    const pk = image.PK?.S;
    const sk = image.SK?.S;
    if (!notificationId || !familyId || !recipientId || !notificationType || !referenceId || !createdAt || !pk || !sk) {
      console.error(JSON.stringify({ event: "notification_outbox_invalid", sequenceNumber: record.dynamodb?.SequenceNumber }));
      if (record.dynamodb?.SequenceNumber) batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      continue;
    }
    if (!notificationQueueUrl) {
      console.error(JSON.stringify({ event: "notification_queue_not_configured" }));
      if (record.dynamodb?.SequenceNumber) batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      continue;
    }

    try {
      const current = await documentClient.send(new GetCommand({
        TableName: getTableName(),
        Key: { PK: pk, SK: sk },
        ConsistentRead: true,
      }));
      if (current.Item?.deliveryStatus !== "pending") continue;

      await sqs.send(new SendMessageCommand({
        QueueUrl: notificationQueueUrl,
        MessageBody: JSON.stringify({
          notificationId,
          familyId,
          recipientId,
          notificationType,
          referenceId,
          createdAt,
        }),
      }));
      await documentClient.send(new UpdateCommand({
        TableName: getTableName(),
        Key: { PK: pk, SK: sk },
        UpdateExpression: "SET deliveryStatus = :queued, queuedAt = :queuedAt",
        ConditionExpression: "deliveryStatus = :pending",
        ExpressionAttributeValues: {
          ":queued": "queued",
          ":pending": "pending",
          ":queuedAt": new Date().toISOString(),
        },
      }));
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error(JSON.stringify({
        event: "notification_outbox_dispatch_failed",
        notificationId,
        sequenceNumber: record.dynamodb?.SequenceNumber,
        errorName,
      }));
      if (record.dynamodb?.SequenceNumber) batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures };
}
