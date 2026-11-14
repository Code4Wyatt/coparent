import { createHash } from "node:crypto";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { documentClient, getTableName } from "../../shared/dynamo";

const billingEventSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(80),
  familyId: z.string().uuid(),
  revision: z.number().int().positive(),
  planId: z.string().trim().min(1).max(80),
  enabledFeatures: z.array(z.enum(["call_recording"])).max(20),
  occurredAt: z.string().datetime({ offset: true }),
});

type BillingEvent = z.infer<typeof billingEventSchema>;

function eventHash(event: BillingEvent) {
  return createHash("sha256").update(JSON.stringify({
    ...event,
    enabledFeatures: [...event.enabledFeatures].sort(),
  })).digest("hex");
}

function auditPut(event: BillingEvent, createdAt: string) {
  return {
    Put: {
      TableName: getTableName(),
      Item: {
        PK: `FAMILY#${event.familyId}`,
        SK: `AUDIT#${createdAt}#${event.eventId}`,
        entityType: "AUDIT_EVENT",
        familyId: event.familyId,
        actorId: `billing:${event.source}`,
        action: "ENTITLEMENTS_UPDATED",
        createdAt,
        details: { planId: event.planId, revision: String(event.revision) },
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    },
  };
}

async function applyEvent(event: BillingEvent) {
  const tableName = getTableName();
  const now = new Date().toISOString();
  const hash = eventHash(event);
  const eventKey = { PK: `FAMILY#${event.familyId}`, SK: `BILLING_EVENT#${event.eventId}` };

  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              ...eventKey,
              entityType: "BILLING_EVENT",
              familyId: event.familyId,
              eventId: event.eventId,
              source: event.source,
              revision: event.revision,
              eventHash: hash,
              outcome: "applied",
              receivedAt: now,
            },
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: { PK: `FAMILY#${event.familyId}`, SK: "ENTITLEMENTS" },
            UpdateExpression: "SET plan = :plan, enabledFeatures = :features, revision = :revision, sourceEventId = :eventId, updatedAt = :updatedAt",
            ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(revision) OR revision < :revision)",
            ExpressionAttributeValues: {
              ":plan": event.planId,
              ":features": [...new Set(event.enabledFeatures)],
              ":revision": event.revision,
              ":eventId": event.eventId,
              ":updatedAt": now,
            },
          },
        },
        auditPut(event, now),
      ],
    }));
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
  }

  const [priorEvent, entitlement] = await Promise.all([
    documentClient.send(new GetCommand({ TableName: tableName, Key: eventKey, ConsistentRead: true })),
    documentClient.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `FAMILY#${event.familyId}`, SK: "ENTITLEMENTS" },
      ConsistentRead: true,
    })),
  ]);
  if (priorEvent.Item) {
    if (priorEvent.Item.eventHash === hash) return;
    throw new Error("billing_event_id_conflict");
  }
  if (typeof entitlement.Item?.revision === "number" && entitlement.Item.revision >= event.revision) {
    await documentClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        ...eventKey,
        entityType: "BILLING_EVENT",
        familyId: event.familyId,
        eventId: event.eventId,
        source: event.source,
        revision: event.revision,
        eventHash: hash,
        outcome: "stale",
        receivedAt: now,
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    }));
    return;
  }
  throw new Error("billing_event_write_conflict");
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const input: unknown = JSON.parse(record.body);
      const parsed = billingEventSchema.safeParse(input);
      if (!parsed.success) throw new Error("billing_event_invalid");
      await applyEvent(parsed.data);
    } catch (error) {
      const errorName = error instanceof Error ? error.message : "billing_event_failed";
      console.error(JSON.stringify({ event: "billing_event_processing_failed", messageId: record.messageId, errorName }));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
