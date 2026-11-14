import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
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

const dateTimeSchema = z.string().refine((value) =>
  Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value),
"Use an ISO 8601 date-time with an explicit UTC offset.");

const eventInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(2_000).optional(),
  startAt: dateTimeSchema,
  endAt: dateTimeSchema,
  timeZone: z.string().min(1).max(100),
}).superRefine((event, context) => {
  if (Date.parse(event.endAt) <= Date.parse(event.startAt)) {
    context.addIssue({ code: "custom", path: ["endAt"], message: "endAt must be after startAt." });
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: event.timeZone });
  } catch {
    context.addIssue({ code: "custom", path: ["timeZone"], message: "timeZone must be a valid IANA time zone." });
  }
});

const createProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), event: eventInputSchema }),
  z.object({ kind: z.literal("change"), eventId: z.string().uuid(), event: eventInputSchema }),
  z.object({ kind: z.literal("cancel"), eventId: z.string().uuid() }),
]);

const respondSchema = z.object({ decision: z.enum(["accept", "decline"]) });
const maxCalendarRangeMs = 366 * 24 * 60 * 60 * 1_000;
const maxEventDurationMs = 366 * 24 * 60 * 60 * 1_000;
const defaultPageSize = 200;
const maxPageSize = 500;

function eventKey(familyId: string, eventId: string) {
  return { PK: `FAMILY#${familyId}`, SK: `EVENT#${eventId}` };
}

function proposalKey(familyId: string, proposalId: string) {
  return { PK: `FAMILY#${familyId}`, SK: `PROPOSAL#${proposalId}` };
}

function normalizeEvent<T extends z.infer<typeof eventInputSchema>>(event: T) {
  const normalized = {
    ...event,
    startAt: new Date(event.startAt).toISOString(),
    endAt: new Date(event.endAt).toISOString(),
  };
  if (Date.parse(normalized.endAt) - Date.parse(normalized.startAt) > maxEventDurationMs) {
    throw new HttpError(400, "event_too_long", "Calendar events cannot be longer than 366 days.");
  }
  return normalized;
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

function eventRevisionPut(
  familyId: string,
  event: Record<string, unknown>,
  revision: number,
  actorId: string,
  changedAt: string,
) {
  const eventId = String(event.eventId);
  return {
    Put: {
      TableName: getTableName(),
      Item: {
        PK: `FAMILY#${familyId}`,
        SK: `EVENT_REVISION#${eventId}#${String(revision).padStart(8, "0")}`,
        entityType: "CALENDAR_EVENT_REVISION",
        familyId,
        eventId,
        revision,
        actorId,
        changedAt,
        snapshot: {
          title: event.title,
          notes: event.notes,
          startAt: event.startAt,
          endAt: event.endAt,
          timeZone: event.timeZone,
          status: event.status,
          createdBy: event.createdBy,
          createdAt: event.createdAt,
        },
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    },
  };
}

function parsePageSize(value: string | undefined): number {
  if (!value) return defaultPageSize;
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw new HttpError(400, "invalid_page_size", `limit must be an integer from 1 to ${maxPageSize}.`);
  }
  return pageSize;
}

function decodeCursor(value: string | undefined, requiredKeys: string[]): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (value.length > 2_048) throw new HttpError(400, "invalid_cursor", "The pagination cursor is invalid.");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor");
    const cursor = parsed as Record<string, unknown>;
    if (requiredKeys.some((key) => typeof cursor[key] !== "string")) throw new Error("Invalid cursor keys");
    return cursor;
  } catch {
    throw new HttpError(400, "invalid_cursor", "The pagination cursor is invalid.");
  }
}

function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;
}

function queryRange(event: APIGatewayProxyEvent) {
  const fromRaw = event.queryStringParameters?.from;
  const toRaw = event.queryStringParameters?.to;
  if (!fromRaw || !toRaw || !Number.isFinite(Date.parse(fromRaw)) || !Number.isFinite(Date.parse(toRaw))) {
    throw new HttpError(400, "invalid_date_range", "from and to must be valid ISO 8601 date-times.");
  }
  const from = new Date(fromRaw).toISOString();
  const to = new Date(toRaw).toISOString();
  if (Date.parse(to) <= Date.parse(from)) {
    throw new HttpError(400, "invalid_date_range", "to must be after from.");
  }
  if (Date.parse(to) - Date.parse(from) > maxCalendarRangeMs) {
    throw new HttpError(400, "date_range_too_large", "Calendar queries are limited to 366 days.");
  }
  return { from, to, fromWithOverlap: new Date(Date.parse(from) - maxEventDurationMs).toISOString() };
}

async function createEvent(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);
  const schedule = normalizeEvent(parseBody(event, eventInputSchema));
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  const item = {
    ...eventKey(familyId, eventId),
    GSI1PK: `FAMILY#${familyId}#EVENTS`,
    GSI1SK: `EVENT#${schedule.startAt}#${eventId}`,
    entityType: "CALENDAR_EVENT",
    familyId,
    eventId,
    ...schedule,
    status: "agreed",
    revision: 1,
    createdBy: user.userId,
    updatedBy: user.userId,
    createdAt,
    updatedAt: createdAt,
  };
  const recipients = await getOtherFamilyMemberIds(user.userId, familyId);

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: getTableName(),
          Item: item,
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      eventRevisionPut(familyId, item, 1, user.userId, createdAt),
      auditPut(familyId, user.userId, "CALENDAR_EVENT_CREATED", createdAt, { eventId }),
      ...recipients.map((recipientId) => notificationOutboxPut(
        familyId,
        recipientId,
        "CALENDAR_EVENT_CREATED",
        eventId,
        createdAt,
      )),
    ],
  }));

  return jsonResponse(201, { event: publicRecord(item) });
}

async function getCalendar(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);
  const { from, to, fromWithOverlap } = queryRange(event);
  const limit = parsePageSize(event.queryStringParameters?.limit);

  const [eventsResult, proposalsResult] = await Promise.all([
    documentClient.send(new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :familyEvents AND GSI1SK BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":familyEvents": `FAMILY#${familyId}#EVENTS`,
        ":from": `EVENT#${fromWithOverlap}`,
        ":to": `EVENT#${to}#~`,
      },
      ExclusiveStartKey: decodeCursor(event.queryStringParameters?.eventCursor, ["PK", "SK", "GSI1PK", "GSI1SK"]),
      Limit: limit,
      ScanIndexForward: true,
    })),
    documentClient.send(new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :familyProposals AND begins_with(GSI2SK, :pendingPrefix)",
      ExpressionAttributeValues: {
        ":familyProposals": `FAMILY#${familyId}#PROPOSALS`,
        ":pendingPrefix": "PENDING#",
      },
      ExclusiveStartKey: decodeCursor(event.queryStringParameters?.proposalCursor, ["PK", "SK", "GSI2PK", "GSI2SK"]),
      Limit: limit,
      ScanIndexForward: true,
    })),
  ]);

  const agreedEvents = (eventsResult.Items ?? [])
    .filter((item) => item.status === "agreed" && Date.parse(String(item.endAt)) > Date.parse(from) && Date.parse(String(item.startAt)) < Date.parse(to))
    .map((item) => publicRecord(item));

  const pendingProposals = await Promise.all((proposalsResult.Items ?? []).map(async (proposal) => {
    let currentEvent: Record<string, unknown> | null = null;
    if (proposal.eventId) {
      const result = await documentClient.send(new GetCommand({
        TableName: getTableName(),
        Key: eventKey(familyId, String(proposal.eventId)),
        ConsistentRead: true,
      }));
      if (result.Item) {
        currentEvent = publicRecord(result.Item);
      }
    }
    const item = publicRecord(proposal);
    const proposedEvent = item.proposedEvent as Record<string, unknown> | undefined;
    const matchesProposed = proposedEvent
      ? Date.parse(String(proposedEvent.endAt)) > Date.parse(from) && Date.parse(String(proposedEvent.startAt)) < Date.parse(to)
      : false;
    const matchesCurrent = currentEvent
      ? Date.parse(String(currentEvent.endAt)) > Date.parse(from) && Date.parse(String(currentEvent.startAt)) < Date.parse(to)
      : false;
    return matchesProposed || matchesCurrent ? { ...item, currentEvent } : null;
  }));

  return jsonResponse(200, {
    range: { from, to },
    events: agreedEvents,
    pendingProposals: pendingProposals.filter((proposal) => proposal !== null),
    nextEventCursor: encodeCursor(eventsResult.LastEvaluatedKey),
    nextProposalCursor: encodeCursor(proposalsResult.LastEvaluatedKey),
  });
}

async function getEventHistory(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const eventId = event.pathParameters?.eventId;
  if (!familyId || !eventId) throw new HttpError(400, "invalid_request", "Family and event IDs are required.");
  await requireFamilyMember(user.userId, familyId);

  const result = await documentClient.send(new QueryCommand({
    TableName: getTableName(),
    KeyConditionExpression: "PK = :familyKey AND begins_with(SK, :historyPrefix)",
    ExpressionAttributeValues: {
      ":familyKey": `FAMILY#${familyId}`,
      ":historyPrefix": `EVENT_REVISION#${eventId}#`,
    },
    Limit: 100,
    ScanIndexForward: true,
  }));
  return jsonResponse(200, { eventId, revisions: (result.Items ?? []).map((item) => publicRecord(item)) });
}

async function createProposal(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);
  const input = parseBody(event, createProposalSchema);

  let baseEvent: Record<string, unknown> | undefined;
  let baseRevision: number | undefined;
  let proposedEvent: ReturnType<typeof normalizeEvent> | undefined;
  let eventId: string | undefined;

  if (input.kind === "change" || input.kind === "cancel") {
    eventId = input.eventId;
    const current = await documentClient.send(new GetCommand({
      TableName: getTableName(),
      Key: eventKey(familyId, eventId),
      ConsistentRead: true,
    }));
    baseEvent = current.Item;
    if (!baseEvent || baseEvent.status !== "agreed") {
      throw new HttpError(404, "calendar_event_not_found", "The agreed calendar event was not found.");
    }
    baseRevision = Number(baseEvent.revision);
  }

  if (input.kind === "create" || input.kind === "change") proposedEvent = normalizeEvent(input.event);
  const proposalId = randomUUID();
  if (input.kind === "create") eventId = randomUUID();
  const createdAt = new Date().toISOString();
  const proposedStartAt = proposedEvent?.startAt ?? String(baseEvent?.startAt);
  const item = {
    ...proposalKey(familyId, proposalId),
    entityType: "CALENDAR_PROPOSAL",
    familyId,
    proposalId,
    eventId,
    kind: input.kind,
    proposedEvent,
    proposedBy: user.userId,
    status: "pending",
    baseRevision,
    proposedStartAt,
    createdAt,
    GSI2PK: `FAMILY#${familyId}#PROPOSALS`,
    GSI2SK: `PENDING#${createdAt}#${proposalId}`,
  };
  const recipients = await getOtherFamilyMemberIds(user.userId, familyId);

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: getTableName(),
          Item: item,
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      auditPut(familyId, user.userId, "CALENDAR_CHANGE_PROPOSED", createdAt, { proposalId, eventId: eventId ?? "" }),
      ...recipients.map((recipientId) => notificationOutboxPut(
        familyId,
        recipientId,
        "CALENDAR_PROPOSAL_CREATED",
        proposalId,
        createdAt,
      )),
    ],
  }));

  return jsonResponse(201, {
    proposal: publicRecord(item),
    currentEvent: baseEvent ? publicRecord(baseEvent) : null,
  });
}

async function respondToProposal(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const proposalId = event.pathParameters?.proposalId;
  if (!familyId || !proposalId) throw new HttpError(400, "invalid_request", "Family and proposal IDs are required.");
  await requireFamilyMember(user.userId, familyId);
  const { decision } = parseBody(event, respondSchema);

  const proposalResult = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: proposalKey(familyId, proposalId),
    ConsistentRead: true,
  }));
  const proposal = proposalResult.Item;
  if (!proposal) throw new HttpError(404, "proposal_not_found", "The calendar proposal was not found.");
  if (proposal.status !== "pending") throw new HttpError(409, "proposal_not_pending", "The proposal has already been resolved.");
  if (proposal.proposedBy === user.userId) throw new HttpError(403, "cannot_respond_to_own_proposal", "The person who proposed a change cannot respond to it.");

  let currentEvent: Record<string, unknown> | undefined;
  if (proposal.kind !== "create") {
    const current = await documentClient.send(new GetCommand({
      TableName: getTableName(),
      Key: eventKey(familyId, String(proposal.eventId)),
      ConsistentRead: true,
    }));
    currentEvent = current.Item;
    if (!currentEvent || currentEvent.status !== "agreed" || Number(currentEvent.revision) !== Number(proposal.baseRevision)) {
      throw new HttpError(409, "calendar_event_changed", "The agreed event changed after this proposal was created.");
    }
  }

  const respondedAt = new Date().toISOString();
  const eventItems = [];
  const finalStatus = decision === "accept" ? "accepted" : "declined";
  eventItems.push({
    Update: {
      TableName: getTableName(),
      Key: proposalKey(familyId, proposalId),
      UpdateExpression: "SET #status = :status, respondedAt = :respondedAt, respondedBy = :userId, GSI2SK = :resolvedKey",
      ConditionExpression: "#status = :pending AND proposedBy <> :userId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": finalStatus,
        ":respondedAt": respondedAt,
        ":userId": user.userId,
        ":pending": "pending",
        ":resolvedKey": `RESOLVED#${String(proposal.proposedStartAt)}#${proposalId}`,
      },
    },
  });

  if (decision === "accept") {
    if (proposal.kind === "create") {
      const schedule = proposal.proposedEvent as ReturnType<typeof normalizeEvent>;
      const eventId = String(proposal.eventId);
      const acceptedEvent = {
        ...eventKey(familyId, eventId),
        GSI1PK: `FAMILY#${familyId}#EVENTS`,
        GSI1SK: `EVENT#${schedule.startAt}#${eventId}`,
        entityType: "CALENDAR_EVENT",
        familyId,
        eventId,
        ...schedule,
        status: "agreed",
        revision: 1,
        createdBy: proposal.proposedBy,
        updatedBy: user.userId,
        createdAt: respondedAt,
        updatedAt: respondedAt,
      };
      eventItems.push({
        Put: {
          TableName: getTableName(),
          Item: acceptedEvent,
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      });
      eventItems.push(eventRevisionPut(familyId, acceptedEvent, 1, user.userId, respondedAt));
    } else if (proposal.kind === "change") {
      const schedule = proposal.proposedEvent as ReturnType<typeof normalizeEvent>;
      const eventId = String(proposal.eventId);
      const updatedEvent = {
        ...currentEvent,
        ...schedule,
        eventId,
        status: "agreed",
        revision: Number(proposal.baseRevision) + 1,
        updatedBy: user.userId,
        updatedAt: respondedAt,
      };
      eventItems.push({
        Update: {
          TableName: getTableName(),
          Key: eventKey(familyId, eventId),
          UpdateExpression: "SET #title = :title, notes = :notes, startAt = :startAt, endAt = :endAt, timeZone = :timeZone, updatedAt = :updatedAt, updatedBy = :updatedBy, revision = revision + :one, GSI1SK = :eventSortKey",
          ConditionExpression: "#status = :agreed AND revision = :baseRevision",
          ExpressionAttributeNames: { "#title": "title", "#status": "status" },
          ExpressionAttributeValues: {
            ":title": schedule.title,
            ":notes": schedule.notes ?? null,
            ":startAt": schedule.startAt,
            ":endAt": schedule.endAt,
            ":timeZone": schedule.timeZone,
            ":updatedAt": respondedAt,
            ":updatedBy": user.userId,
            ":one": 1,
            ":eventSortKey": `EVENT#${schedule.startAt}#${eventId}`,
            ":agreed": "agreed",
            ":baseRevision": proposal.baseRevision,
          },
        },
      });
      eventItems.push(eventRevisionPut(familyId, updatedEvent, Number(proposal.baseRevision) + 1, user.userId, respondedAt));
    } else {
      const eventId = String(proposal.eventId);
      const cancelledEvent = {
        ...currentEvent,
        eventId,
        status: "cancelled",
        revision: Number(proposal.baseRevision) + 1,
        updatedBy: user.userId,
        updatedAt: respondedAt,
      };
      eventItems.push({
        Update: {
          TableName: getTableName(),
          Key: eventKey(familyId, eventId),
          UpdateExpression: "SET #status = :cancelled, updatedAt = :updatedAt, updatedBy = :updatedBy, revision = revision + :one, GSI1SK = :cancelledSortKey",
          ConditionExpression: "#status = :agreed AND revision = :baseRevision",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":cancelled": "cancelled",
            ":updatedAt": respondedAt,
            ":updatedBy": user.userId,
            ":one": 1,
            ":cancelledSortKey": `CANCELLED#${String(currentEvent?.startAt)}#${eventId}`,
            ":agreed": "agreed",
            ":baseRevision": proposal.baseRevision,
          },
        },
      });
      eventItems.push(eventRevisionPut(familyId, cancelledEvent, Number(proposal.baseRevision) + 1, user.userId, respondedAt));
    }
  }

  eventItems.push(auditPut(
    familyId,
    user.userId,
    decision === "accept" ? "CALENDAR_CHANGE_ACCEPTED" : "CALENDAR_CHANGE_DECLINED",
    respondedAt,
    { proposalId, eventId: String(proposal.eventId ?? "") },
  ));
  eventItems.push(notificationOutboxPut(
    familyId,
    String(proposal.proposedBy),
    "CALENDAR_PROPOSAL_RESPONDED",
    proposalId,
    respondedAt,
  ));

  try {
    await documentClient.send(new TransactWriteCommand({ TransactItems: eventItems }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      throw new HttpError(409, "proposal_conflict", "The proposal or its event changed before this response was saved.");
    }
    throw error;
  }

  return jsonResponse(200, {
    proposalId,
    status: finalStatus,
    respondedAt,
    eventId: proposal.eventId ?? null,
  });
}

async function withdrawProposal(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const proposalId = event.pathParameters?.proposalId;
  if (!familyId || !proposalId) throw new HttpError(400, "invalid_request", "Family and proposal IDs are required.");
  await requireFamilyMember(user.userId, familyId);

  const key = proposalKey(familyId, proposalId);
  const result = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: key,
    ConsistentRead: true,
  }));
  const proposal = result.Item;
  if (!proposal) throw new HttpError(404, "proposal_not_found", "The calendar proposal was not found.");
  if (proposal.proposedBy !== user.userId) {
    throw new HttpError(403, "not_proposal_author", "Only the person who proposed the change can withdraw it.");
  }
  if (proposal.status !== "pending") {
    throw new HttpError(409, "proposal_not_pending", "Only a pending proposal can be withdrawn.");
  }

  const withdrawnAt = new Date().toISOString();
  const recipients = await getOtherFamilyMemberIds(user.userId, familyId);
  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: getTableName(),
            Key: key,
            UpdateExpression: "SET #status = :withdrawn, respondedAt = :withdrawnAt, respondedBy = :userId, GSI2SK = :resolvedKey",
            ConditionExpression: "#status = :pending AND proposedBy = :userId",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":withdrawn": "withdrawn",
              ":withdrawnAt": withdrawnAt,
              ":userId": user.userId,
              ":pending": "pending",
              ":resolvedKey": `RESOLVED#${String(proposal.proposedStartAt)}#${proposalId}`,
            },
          },
        },
        auditPut(familyId, user.userId, "CALENDAR_CHANGE_WITHDRAWN", withdrawnAt, {
          proposalId,
          eventId: String(proposal.eventId ?? ""),
        }),
        ...recipients.map((recipientId) => notificationOutboxPut(
          familyId,
          recipientId,
          "CALENDAR_PROPOSAL_WITHDRAWN",
          proposalId,
          withdrawnAt,
        )),
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      throw new HttpError(409, "proposal_not_pending", "The proposal changed before it could be withdrawn.");
    }
    throw error;
  }

  return jsonResponse(200, { proposalId, status: "withdrawn", withdrawnAt });
}

export const handler = createHandler(async (event) => {
  const route = `${event.httpMethod} ${event.resource}`;
  switch (route) {
    case "POST /families/{familyId}/calendar/events":
      return createEvent(event);
    case "GET /families/{familyId}/calendar/events/{eventId}/history":
      return getEventHistory(event);
    case "GET /families/{familyId}/calendar":
      return getCalendar(event);
    case "POST /families/{familyId}/calendar/proposals":
      return createProposal(event);
    case "POST /families/{familyId}/calendar/proposals/{proposalId}/respond":
      return respondToProposal(event);
    case "DELETE /families/{familyId}/calendar/proposals/{proposalId}":
      return withdrawProposal(event);
    default:
      throw new HttpError(404, "route_not_found", "The requested route was not found.");
  }
});
