import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
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
import { requireFamilyMember } from "../../shared/family-access";
import { requireFeatureEntitlement } from "../../shared/entitlements";
import { ChimeMediaProvider } from "./media-provider";

const mediaRegion = process.env.CHIME_MEDIA_REGION ?? process.env.AWS_REGION;
const bucketName = process.env.RECORDINGS_BUCKET_NAME;
const mediaProvider = new ChimeMediaProvider();

const inviteSchema = z.object({
  inviteeId: z.string().min(1).max(128),
  recordingRequested: z.boolean().default(false),
});
const responseSchema = z.object({
  decision: z.enum(["accept", "decline"]),
  recordingConsent: z.boolean().default(false),
});
const invitationLifetimeMs = 5 * 60 * 1_000;
const getCallKey = (familyId: string, callId: string) => ({
  PK: `FAMILY#${familyId}`,
  SK: `CALL#${callId}`,
});
const opaqueId = (value: string) => createHash("sha256").update(value).digest("hex");

function auditPut(familyId: string, actorId: string, action: string, createdAt: string, callId: string) {
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
        details: { callId },
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    },
  };
}

async function getCall(familyId: string, callId: string) {
  const result = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: getCallKey(familyId, callId),
    ConsistentRead: true,
  }));
  if (!result.Item || result.Item.entityType !== "CALL") {
    throw new HttpError(404, "call_not_found", "The call was not found.");
  }
  return result.Item;
}

function requireCallParticipant(call: Record<string, unknown>, userId: string) {
  if (call.callerId !== userId && call.inviteeId !== userId) {
    throw new HttpError(404, "call_not_found", "The call was not found.");
  }
}

function publicCall(call: Record<string, unknown>) {
  const {
    meetingId: _meetingId,
    meetingArn: _meetingArn,
    capturePipelineArn: _capturePipelineArn,
    capturePipelineId: _capturePipelineId,
    concatenationPipelineId: _concatenationPipelineId,
    ...safeCall
  } = call;
  return publicRecord(safeCall);
}

async function createCall(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);
  const input = parseBody(event, inviteSchema);
  if (input.recordingRequested) await requireFeatureEntitlement(familyId, "call_recording");
  if (input.inviteeId === user.userId) {
    throw new HttpError(400, "invalid_invitee", "A call must be invited to another family member.");
  }

  const invitee = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: `FAMILY#${familyId}`, SK: `MEMBER#${input.inviteeId}` },
    ConsistentRead: true,
  }));
  if (!invitee.Item) throw new HttpError(404, "invitee_not_found", "The invitee is not a member of this family.");

  const callId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + invitationLifetimeMs).toISOString();
  const notificationId = randomUUID();
  const call = {
    ...getCallKey(familyId, callId),
    GSI1PK: `FAMILY#${familyId}#CALLS`,
    GSI1SK: `CALL#${createdAt}#${callId}`,
    entityType: "CALL",
    familyId,
    callId,
    callerId: user.userId,
    inviteeId: input.inviteeId,
    status: "invited",
    expiresAt,
    recordingRequested: input.recordingRequested,
    callerRecordingConsent: input.recordingRequested,
    inviteeRecordingConsent: false,
    recordingStatus: input.recordingRequested ? "awaiting_consent" : "not_requested",
    createdAt,
    updatedAt: createdAt,
  };

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: getTableName(),
          Item: call,
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      auditPut(familyId, user.userId, "CALL_INVITED", createdAt, callId),
      {
        Put: {
          TableName: getTableName(),
          Item: {
            PK: `FAMILY#${familyId}`,
            SK: `NOTIFICATION#${createdAt}#${notificationId}`,
            entityType: "NOTIFICATION_OUTBOX",
            notificationId,
            familyId,
            recipientId: input.inviteeId,
            notificationType: "CALL_INVITATION",
            referenceId: callId,
            deliveryStatus: "pending",
            createdAt,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
    ],
  }));

  return jsonResponse(201, {
    call: publicCall(call),
    notification: { status: "pending", id: notificationId },
  });
}

async function listCalls(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);
  const result = await documentClient.send(new QueryCommand({
    TableName: getTableName(),
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :familyCalls AND begins_with(GSI1SK, :callPrefix)",
    ExpressionAttributeValues: {
      ":familyCalls": `FAMILY#${familyId}#CALLS`,
      ":callPrefix": "CALL#",
    },
    Limit: 100,
    ScanIndexForward: false,
  }));
  const now = new Date().toISOString();
  const calls = await Promise.all((result.Items ?? [])
    .filter((call) => call.callerId === user.userId || call.inviteeId === user.userId)
    .map(async (call) => {
      if (call.status === "invited" && typeof call.expiresAt === "string" && call.expiresAt <= now) {
        try {
          await documentClient.send(new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: getTableName(),
                  Key: getCallKey(familyId, String(call.callId)),
                  UpdateExpression: "SET #status = :expired, updatedAt = :now",
                  ConditionExpression: "#status = :invited AND expiresAt <= :now",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: { ":expired": "expired", ":invited": "invited", ":now": now },
                },
              },
              auditPut(familyId, user.userId, "CALL_INVITATION_EXPIRED", now, String(call.callId)),
            ],
          }));
          return publicCall({ ...call, status: "expired", updatedAt: now });
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
          const current = await getCall(familyId, String(call.callId));
          return publicCall(current);
        }
      }
      return publicCall(call);
    }));
  return jsonResponse(200, { calls });
}

async function cancelCall(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const callId = event.pathParameters?.callId;
  if (!familyId || !callId) throw new HttpError(400, "invalid_request", "Family and call IDs are required.");
  await requireFamilyMember(user.userId, familyId);
  const call = await getCall(familyId, callId);
  if (call.callerId !== user.userId) throw new HttpError(403, "not_caller", "Only the caller can cancel an invitation.");
  if (call.status !== "invited") throw new HttpError(409, "call_not_pending", "Only a pending call invitation can be cancelled.");
  const now = new Date().toISOString();
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: getTableName(),
          Key: getCallKey(familyId, callId),
          UpdateExpression: "SET #status = :cancelled, updatedAt = :now, cancelledAt = :now",
          ConditionExpression: "#status = :invited AND callerId = :userId",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":cancelled": "cancelled", ":invited": "invited", ":userId": user.userId, ":now": now },
        },
      },
      auditPut(familyId, user.userId, "CALL_CANCELLED", now, callId),
    ],
  }));
  return jsonResponse(200, { call: { ...publicCall(call), status: "cancelled", cancelledAt: now } });
}

async function ensureMeeting(call: Record<string, unknown>) {
  if (typeof call.meetingId === "string" && typeof call.meetingArn === "string") return call;
  if (typeof mediaRegion !== "string" || !mediaRegion) {
    throw new HttpError(503, "media_unavailable", "Call media is not configured.");
  }
  try {
    const meeting = await mediaProvider.createMeeting(String(call.callId), String(call.callerId), mediaRegion);
    await documentClient.send(new UpdateCommand({
      TableName: getTableName(),
      Key: getCallKey(String(call.familyId), String(call.callId)),
      UpdateExpression: "SET meetingId = :meetingId, meetingArn = :meetingArn, updatedAt = :updatedAt",
      ConditionExpression: "#status IN (:accepted, :active)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":meetingId": meeting.meetingId,
        ":meetingArn": meeting.meetingArn,
        ":updatedAt": new Date().toISOString(),
        ":accepted": "accepted",
        ":active": "active",
      },
    }));
    return { ...call, meetingId: meeting.meetingId, meetingArn: meeting.meetingArn };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ event: "call_meeting_create_failed", errorName }));
    throw new HttpError(503, "media_unavailable", "The call session could not be prepared. Please try again.");
  }
}

async function respondToCall(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const callId = event.pathParameters?.callId;
  if (!familyId || !callId) throw new HttpError(400, "invalid_request", "Family and call IDs are required.");
  await requireFamilyMember(user.userId, familyId);
  const input = parseBody(event, responseSchema);
  const call = await getCall(familyId, callId);
  if (call.inviteeId !== user.userId) throw new HttpError(403, "not_invitee", "Only the invited parent can respond.");

  if (call.status !== "invited") {
    if (call.status === "accepted" || call.status === "active") {
      if (input.decision !== "accept") throw new HttpError(409, "call_already_accepted", "This invitation has already been accepted.");
      return jsonResponse(200, { call: publicCall(await ensureMeeting(call)), replayed: true });
    }
    throw new HttpError(409, "call_not_pending", "This invitation is no longer waiting for a response.");
  }
  if (Date.parse(String(call.expiresAt)) <= Date.now()) {
    const expiredAt = new Date().toISOString();
    await documentClient.send(new UpdateCommand({
      TableName: getTableName(),
      Key: getCallKey(familyId, callId),
      UpdateExpression: "SET #status = :expired, updatedAt = :updatedAt",
      ConditionExpression: "#status = :invited",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":expired": "expired", ":invited": "invited", ":updatedAt": expiredAt },
    }));
    throw new HttpError(409, "call_invitation_expired", "This call invitation has expired.");
  }

  const now = new Date().toISOString();
  const accepted = input.decision === "accept";
  const recordingConsent = accepted && call.recordingRequested === true && input.recordingConsent;
  const status = accepted ? "accepted" : "declined";
  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: getTableName(),
            Key: getCallKey(familyId, callId),
            UpdateExpression: "SET #status = :status, inviteeRecordingConsent = :consent, recordingStatus = :recordingStatus, respondedAt = :respondedAt, updatedAt = :updatedAt",
            ConditionExpression: "#status = :invited AND inviteeId = :userId AND expiresAt > :now",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":status": status,
              ":consent": recordingConsent,
              ":recordingStatus": call.recordingRequested === true
                ? recordingConsent ? "consented" : "not_consented"
                : "not_requested",
              ":respondedAt": now,
              ":updatedAt": now,
              ":invited": "invited",
              ":userId": user.userId,
              ":now": now,
            },
          },
        },
        auditPut(familyId, user.userId, accepted ? "CALL_ACCEPTED" : "CALL_DECLINED", now, callId),
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      throw new HttpError(409, "call_not_pending", "This invitation was already answered or has expired.");
    }
    throw error;
  }

  if (!accepted) return jsonResponse(200, { call: { ...publicCall(call), status, respondedAt: now } });
  const updatedCall = {
    ...call,
    status,
    inviteeRecordingConsent: recordingConsent,
    recordingStatus: call.recordingRequested === true ? recordingConsent ? "consented" : "not_consented" : "not_requested",
    respondedAt: now,
    updatedAt: now,
  };
  return jsonResponse(200, { call: publicCall(await ensureMeeting(updatedCall)) });
}

async function ensureCapturePipeline(call: Record<string, unknown>) {
  if (typeof call.capturePipelineArn === "string") return call;
  if (call.recordingRequested !== true || call.callerRecordingConsent !== true || call.inviteeRecordingConsent !== true) {
    return call;
  }
  if (!bucketName || typeof call.meetingArn !== "string") {
    throw new HttpError(503, "recording_unavailable", "Call recording is not configured.");
  }
  try {
    const capture = await mediaProvider.startCapture(String(call.meetingArn), String(call.callId), bucketName);
    await documentClient.send(new UpdateCommand({
      TableName: getTableName(),
      Key: getCallKey(String(call.familyId), String(call.callId)),
      UpdateExpression: "SET capturePipelineArn = :pipelineArn, capturePipelineId = :pipelineId, recordingStatus = :status, updatedAt = :updatedAt",
      ConditionExpression: "recordingRequested = :yes AND callerRecordingConsent = :yes AND inviteeRecordingConsent = :yes",
      ExpressionAttributeValues: {
        ":pipelineArn": capture.pipelineArn,
        ":pipelineId": capture.pipelineId,
        ":status": "recording",
        ":yes": true,
        ":updatedAt": new Date().toISOString(),
      },
    }));
    return { ...call, capturePipelineArn: capture.pipelineArn, capturePipelineId: capture.pipelineId, recordingStatus: "recording" };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ event: "call_recording_start_failed", errorName }));
    throw new HttpError(503, "recording_unavailable", "Recording could not be started. Please try again.");
  }
}

async function getSession(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const callId = event.pathParameters?.callId;
  if (!familyId || !callId) throw new HttpError(400, "invalid_request", "Family and call IDs are required.");
  await requireFamilyMember(user.userId, familyId);
  let call = await getCall(familyId, callId);
  requireCallParticipant(call, user.userId);
  if (!["accepted", "active"].includes(String(call.status))) {
    throw new HttpError(409, "call_not_accepted", "Only an accepted call can create a media session.");
  }
  if (call.recordingRequested === true && call.callerRecordingConsent === true && call.inviteeRecordingConsent === true) {
    await requireFeatureEntitlement(familyId, "call_recording");
  }
  call = await ensureMeeting(call);
  try {
    const attendeeKey = { PK: `FAMILY#${familyId}`, SK: `CALL#${callId}#ATTENDEE#${user.userId}` };
    const storedAttendee = await documentClient.send(new GetCommand({
      TableName: getTableName(),
      Key: attendeeKey,
      ConsistentRead: true,
    }));
    let attendeeId = storedAttendee.Item?.attendeeId as string | undefined;
    if (!attendeeId) {
      const externalUserId = opaqueId(`attendee:${callId}:${user.userId}`);
      attendeeId = await mediaProvider.createAttendee(String(call.meetingId), externalUserId);
      const attendeeCreatedAt = new Date().toISOString();
      try {
        await documentClient.send(new PutCommand({
          TableName: getTableName(),
          Item: {
            ...attendeeKey,
            entityType: "CALL_ATTENDEE",
            familyId,
            callId,
            userId: user.userId,
            attendeeId,
            createdAt: attendeeCreatedAt,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
        const winner = await documentClient.send(new GetCommand({
          TableName: getTableName(),
          Key: attendeeKey,
          ConsistentRead: true,
        }));
        if (typeof winner.Item?.attendeeId !== "string") throw error;
        attendeeId = winner.Item.attendeeId;
      }
    }
    const now = new Date().toISOString();
    await documentClient.send(new UpdateCommand({
      TableName: getTableName(),
      Key: getCallKey(familyId, callId),
      UpdateExpression: "SET #status = :active, updatedAt = :updatedAt",
      ConditionExpression: "#status IN (:accepted, :active)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":active": "active", ":accepted": "accepted", ":updatedAt": now },
    }));

    let currentCall: Record<string, unknown> = { ...call, status: "active" };
    currentCall = await ensureCapturePipeline(currentCall);
    const joinToken = await mediaProvider.getJoinToken(String(call.meetingId), attendeeId);
    return jsonResponse(200, {
      callId,
      meeting: { meetingId: call.meetingId, mediaRegion },
      attendee: { attendeeId, joinToken },
      recording: { status: currentCall.recordingStatus },
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ event: "call_session_create_failed", errorName }));
    throw new HttpError(503, "media_unavailable", "The call session could not be prepared. Please try again.");
  }
}

async function endCall(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const callId = event.pathParameters?.callId;
  if (!familyId || !callId) throw new HttpError(400, "invalid_request", "Family and call IDs are required.");
  await requireFamilyMember(user.userId, familyId);
  const call = await getCall(familyId, callId);
  requireCallParticipant(call, user.userId);
  if (["ended", "declined", "expired", "cancelled"].includes(String(call.status))) {
    return jsonResponse(200, { call: publicCall(call), replayed: true });
  }
  if (call.meetingId) {
    try {
      await mediaProvider.endMeeting(String(call.meetingId));
    } catch (error) {
      throw error;
    }
  }

  let concatenationPipelineId: string | undefined;
  if (typeof call.capturePipelineArn === "string") {
    try {
      if (!bucketName) throw new Error("Recording storage is not configured");
      concatenationPipelineId = await mediaProvider.stopCaptureAndConcatenate(
        String(call.capturePipelineId),
        String(call.capturePipelineArn),
        familyId,
        callId,
        bucketName,
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error(JSON.stringify({ event: "call_recording_finalize_failed", errorName }));
    }
  }

  const now = new Date().toISOString();
  const recordingStatus = call.capturePipelineArn
    ? concatenationPipelineId ? "processing" : "finalization_failed"
    : call.recordingStatus;
  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: getTableName(),
          Key: getCallKey(familyId, callId),
          UpdateExpression: "SET #status = :ended, endedAt = :endedAt, recordingStatus = :recordingStatus, updatedAt = :updatedAt" + (concatenationPipelineId ? ", concatenationPipelineId = :pipelineId" : ""),
          ConditionExpression: "#status IN (:invited, :accepted, :active)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":ended": "ended",
            ":invited": "invited",
            ":accepted": "accepted",
            ":active": "active",
            ":endedAt": now,
            ":recordingStatus": recordingStatus,
            ":updatedAt": now,
            ...(concatenationPipelineId ? { ":pipelineId": concatenationPipelineId } : {}),
          },
        },
      },
      auditPut(familyId, user.userId, "CALL_ENDED", now, callId),
    ],
  }));
  return jsonResponse(200, {
    call: { ...publicCall(call), status: "ended", endedAt: now, recordingStatus },
  });
}

async function getRecording(event: APIGatewayProxyEvent) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const callId = event.pathParameters?.callId;
  if (!familyId || !callId) throw new HttpError(400, "invalid_request", "Family and call IDs are required.");
  await requireFamilyMember(user.userId, familyId);
  const call = await getCall(familyId, callId);
  requireCallParticipant(call, user.userId);
  if (call.recordingRequested !== true || call.callerRecordingConsent !== true || call.inviteeRecordingConsent !== true) {
    throw new HttpError(404, "recording_not_found", "This call does not have a recording.");
  }
  await requireFeatureEntitlement(familyId, "call_recording");
  if (call.status !== "ended" || typeof call.concatenationPipelineId !== "string") {
    return jsonResponse(200, { recording: { status: call.recordingStatus } });
  }
  try {
    const status = await mediaProvider.getConcatenationStatus(String(call.concatenationPipelineId));
    if (status !== "Stopped") return jsonResponse(200, { recording: { status: "processing" } });

    const prefix = `${familyId}/${callId}/recording/video/`;
    if (!bucketName) throw new Error("Recording storage is not configured");
    const url = await mediaProvider.getRecordingUrl(bucketName, prefix);
    if (!url) return jsonResponse(200, { recording: { status: "processing" } });
    return jsonResponse(200, {
      recording: { status: "available", url, expiresInSeconds: 300 },
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(JSON.stringify({ event: "call_recording_lookup_failed", errorName }));
    throw new HttpError(503, "recording_unavailable", "The recording could not be retrieved. Please try again.");
  }
}

export const handler = createHandler(async (event) => {
  const method = event.httpMethod;
  const resource = event.resource;
  if (resource === "/families/{familyId}/calls" && method === "POST") return createCall(event);
  if (resource === "/families/{familyId}/calls" && method === "GET") return listCalls(event);
  if (resource === "/families/{familyId}/calls/{callId}/cancel" && method === "POST") return cancelCall(event);
  if (resource === "/families/{familyId}/calls/{callId}/respond" && method === "POST") return respondToCall(event);
  if (resource === "/families/{familyId}/calls/{callId}/session" && method === "GET") return getSession(event);
  if (resource === "/families/{familyId}/calls/{callId}/end" && method === "POST") return endCall(event);
  if (resource === "/families/{familyId}/calls/{callId}/recording" && method === "GET") return getRecording(event);
  return jsonResponse(404, { error: "not_found", message: "The requested call route was not found." });
});
