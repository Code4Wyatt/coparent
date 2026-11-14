import { createHash, randomUUID } from "node:crypto";
import { ComprehendClient, DetectToxicContentCommand } from "@aws-sdk/client-comprehend";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { documentClient, getTableName } from "../../shared/dynamo";
import {
  createHandler,
  getAuthenticatedUser,
  HttpError,
  jsonResponse,
  parseBody,
  publicRecord,
} from "../../shared/http";
import { getOtherFamilyMemberIds, requireFamilyMember } from "../../shared/family-access";
import { notificationOutboxPut } from "../../shared/notification-outbox";

const comprehend = new ComprehendClient({});
const messageSchema = z.object({
  text: z.string().trim().min(1).max(5_000),
});
const reportSchema = z.object({
  reason: z.string().trim().max(1_000).optional(),
});
const maxMessageBytes = 1_024;
const messagePageSizeDefault = 30;
const messagePageSizeMax = 100;

interface ModerationResult {
  score: number;
  labels: Array<{ name: string; score: number }>;
  decision: "allowed" | "blocked";
}

async function moderate(text: string): Promise<ModerationResult> {
  let result;
  try {
    result = await comprehend.send(new DetectToxicContentCommand({
      LanguageCode: "en",
      TextSegments: [{ Text: text }],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "UnsupportedLanguageException") {
      throw new HttpError(422, "unsupported_language", "Automated message moderation currently supports English text only.");
    }
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ event: "moderation_failed", errorName }));
    throw new HttpError(503, "moderation_unavailable", "Message moderation is temporarily unavailable.");
  }

  const analysis = result.ResultList?.[0];
  if (typeof analysis?.Toxicity !== "number") {
    throw new HttpError(503, "moderation_unavailable", "Message moderation returned no decision.");
  }

  const score = analysis.Toxicity;
  const labels = (analysis.Labels ?? [])
    .filter((label) => typeof label.Score === "number" && label.Score >= 0.25)
    .map((label) => ({ name: label.Name ?? "unknown", score: label.Score ?? 0 }));
  const configuredThreshold = Number(process.env.MODERATION_BLOCK_THRESHOLD ?? "0.85");
  const threshold = Number.isFinite(configuredThreshold) && configuredThreshold >= 0 && configuredThreshold <= 1
    ? configuredThreshold
    : 0.85;

  return {
    score,
    labels,
    decision: score >= threshold ? "blocked" : "allowed",
  };
}

function parsePageSize(value: string | undefined): number {
  if (!value) return messagePageSizeDefault;
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > messagePageSizeMax) {
    throw new HttpError(400, "invalid_page_size", `limit must be an integer from 1 to ${messagePageSizeMax}.`);
  }
  return pageSize;
}

function decodeCursor(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (value.length > 2_048) throw new HttpError(400, "invalid_cursor", "The pagination cursor is invalid.");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor");
    const keys = parsed as Record<string, unknown>;
    if (["PK", "SK", "GSI1PK", "GSI1SK"].some((key) => typeof keys[key] !== "string")) {
      throw new Error("Invalid cursor keys");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_cursor", "The pagination cursor is invalid.");
  }
}

function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;
}

function idempotentMessageId(userId: string, familyId: string, key: string | undefined): string {
  if (!key) return randomUUID();
  return createHash("sha256").update(`${userId}:${familyId}:${key}`).digest("hex");
}

function auditPut(familyId: string, actorId: string, action: string, createdAt: string, details: Record<string, string>) {
  return {
    Put: {
      TableName: getTableName(),
      Item: {
        PK: `FAMILY#${familyId}`,
        SK: `AUDIT#${createdAt}#${randomUUID()}`,
        entityType: "AUDIT_EVENT",
        familyId,
        actorId,
        action,
        createdAt,
        details,
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    },
  };
}

async function sendMessage(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);

  const { text } = parseBody(event, messageSchema);
  if (Buffer.byteLength(text, "utf8") > maxMessageBytes) {
    throw new HttpError(413, "message_too_large", "Messages must be no more than 1 KB of UTF-8 text.");
  }

  const idempotencyKey = event.headers["idempotency-key"] ?? event.headers["Idempotency-Key"];
  if (idempotencyKey && !/^[\w.-]{8,128}$/.test(idempotencyKey)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 128 letters, numbers, dots, underscores, or hyphens.");
  }

  const moderation = await moderate(text);
  const createdAt = new Date().toISOString();
  const messageId = idempotentMessageId(user.userId, familyId, idempotencyKey);
  const requestHash = createHash("sha256").update(text).digest("hex");
  const messageItem = {
    PK: `FAMILY#${familyId}`,
    SK: `MESSAGE#${messageId}`,
    GSI1PK: `FAMILY#${familyId}#MESSAGES`,
    GSI1SK: `MESSAGE#${createdAt}#${messageId}`,
    entityType: "MESSAGE",
    familyId,
    messageId,
    authorId: user.userId,
    text,
    status: "sent",
    createdAt,
    requestHash,
    moderation: {
      provider: "amazon-comprehend",
      policyVersion: process.env.MODERATION_POLICY_VERSION ?? "v1",
      score: moderation.score,
      labels: moderation.labels,
      decision: moderation.decision,
      checkedAt: createdAt,
    },
  };

  if (moderation.decision === "blocked") {
    await documentClient.send(new PutCommand({
      TableName: getTableName(),
      Item: {
        PK: `FAMILY#${familyId}`,
        SK: `MODERATION#${createdAt}#${messageId}`,
        entityType: "MODERATION_DECISION",
        familyId,
        messageId,
        actorId: user.userId,
        policyVersion: process.env.MODERATION_POLICY_VERSION ?? "v1",
        score: moderation.score,
        labels: moderation.labels,
        decision: moderation.decision,
        createdAt,
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    }));
    return jsonResponse(422, {
      error: "message_blocked",
      message: "This message was not sent because it did not pass the communication guidelines.",
      moderation: { decision: moderation.decision, score: moderation.score, labels: moderation.labels },
    });
  }

  try {
    const recipients = await getOtherFamilyMemberIds(user.userId, familyId);
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: getTableName(),
            Item: messageItem,
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
        auditPut(familyId, user.userId, "MESSAGE_SENT", createdAt, { messageId }),
        ...recipients.map((recipientId) => notificationOutboxPut(
          familyId,
          recipientId,
          "MESSAGE_CREATED",
          messageId,
          createdAt,
        )),
      ],
    }));
  } catch (error) {
    if (idempotencyKey && error instanceof Error && error.name === "TransactionCanceledException") {
      const previous = await documentClient.send(new GetCommand({
        TableName: getTableName(),
        Key: { PK: `FAMILY#${familyId}`, SK: `MESSAGE#${messageId}` },
        ConsistentRead: true,
      }));
      if (previous.Item?.authorId === user.userId && previous.Item?.requestHash === requestHash) {
        return jsonResponse(200, { message: publicRecord(previous.Item), replayed: true });
      }
      throw new HttpError(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
    }
    throw error;
  }

  return jsonResponse(201, { message: publicRecord(messageItem) });
}

async function listMessages(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);

  const result = await documentClient.send(new QueryCommand({
    TableName: getTableName(),
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :familyMessages AND begins_with(GSI1SK, :messagePrefix)",
    ExpressionAttributeValues: {
      ":familyMessages": `FAMILY#${familyId}#MESSAGES`,
      ":messagePrefix": "MESSAGE#",
    },
    ExclusiveStartKey: decodeCursor(event.queryStringParameters?.cursor),
    Limit: parsePageSize(event.queryStringParameters?.limit),
    ScanIndexForward: false,
  }));

  const messages = (result.Items ?? []).map((message) => publicRecord(message));
  return jsonResponse(200, { messages, nextCursor: encodeCursor(result.LastEvaluatedKey) });
}

async function markRead(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const messageId = event.pathParameters?.messageId;
  if (!familyId || !messageId) throw new HttpError(400, "invalid_request", "Family and message IDs are required.");
  await requireFamilyMember(user.userId, familyId);

  const message = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: `FAMILY#${familyId}`, SK: `MESSAGE#${messageId}` },
    ConsistentRead: true,
  }));
  if (!message.Item) throw new HttpError(404, "message_not_found", "The message was not found.");
  if (message.Item.authorId === user.userId) {
    throw new HttpError(400, "invalid_read_receipt", "A sender cannot mark their own message as read.");
  }

  const readAt = new Date().toISOString();
  await documentClient.send(new UpdateCommand({
    TableName: getTableName(),
    Key: { PK: `FAMILY#${familyId}`, SK: `MESSAGE_READ#${messageId}#${user.userId}` },
    UpdateExpression: "SET entityType = :type, familyId = :familyId, messageId = :messageId, readerId = :readerId, readAt = if_not_exists(readAt, :readAt)",
    ExpressionAttributeValues: {
      ":type": "MESSAGE_READ_RECEIPT",
      ":familyId": familyId,
      ":messageId": messageId,
      ":readerId": user.userId,
      ":readAt": readAt,
    },
  }));

  return jsonResponse(200, { messageId, readAt });
}

async function reportMessage(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const messageId = event.pathParameters?.messageId;
  if (!familyId || !messageId) throw new HttpError(400, "invalid_request", "Family and message IDs are required.");
  await requireFamilyMember(user.userId, familyId);

  const { reason } = parseBody(event, reportSchema);
  const message = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: `FAMILY#${familyId}`, SK: `MESSAGE#${messageId}` },
    ConsistentRead: true,
  }));
  if (!message.Item) throw new HttpError(404, "message_not_found", "The message was not found.");

  const reportId = randomUUID();
  const createdAt = new Date().toISOString();
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: getTableName(),
          Item: {
            PK: `FAMILY#${familyId}`,
            SK: `MESSAGE_REPORT#${createdAt}#${reportId}`,
            entityType: "MESSAGE_REPORT",
            familyId,
            reportId,
            messageId,
            messageAuthorId: message.Item.authorId,
            reporterId: user.userId,
            reason,
            status: "open",
            createdAt,
          },
        },
      },
      auditPut(familyId, user.userId, "MESSAGE_REPORTED", createdAt, { messageId, reportId }),
    ],
  }));

  return jsonResponse(201, { reportId, messageId, status: "open", createdAt });
}

export const handler = createHandler(async (event) => {
  const route = `${event.httpMethod} ${event.resource}`;
  switch (route) {
    case "POST /families/{familyId}/messages":
      return sendMessage(event);
    case "GET /families/{familyId}/messages":
      return listMessages(event);
    case "POST /families/{familyId}/messages/{messageId}/read":
      return markRead(event);
    case "POST /families/{familyId}/messages/{messageId}/reports":
      return reportMessage(event);
    default:
      throw new HttpError(404, "route_not_found", "The requested route was not found.");
  }
});
