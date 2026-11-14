import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  GetCommand,
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
} from "../../shared/http";
import { requireFamilyMember } from "../../shared/family-access";

const createFamilySchema = z.object({
  name: z.string().trim().min(1).max(100).default("Coparenting family"),
});

const createInvitationSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
});

const acceptInvitationSchema = z.object({
  invitationToken: z.string().min(32).max(128),
});

const invitationLifetimeSeconds = 60 * 60 * 24 * 7;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function familyKey(familyId: string) {
  return { PK: `FAMILY#${familyId}`, SK: "METADATA" };
}

function membershipKey(familyId: string, userId: string) {
  return { PK: `FAMILY#${familyId}`, SK: `MEMBER#${userId}` };
}

function auditPut(
  familyId: string,
  actorId: string,
  action: string,
  createdAt: string,
  details: Record<string, string> = {},
) {
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

async function createFamily(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  if (!user.emailVerified) throw new HttpError(403, "email_not_verified", "Verify your email before creating a family.");

  const { name } = parseBody(event, createFamilySchema);
  const familyId = randomUUID();
  const now = new Date().toISOString();
  const tableName = getTableName();

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            ...familyKey(familyId),
            entityType: "FAMILY",
            familyId,
            name,
            status: "active",
            createdBy: user.userId,
            createdAt: now,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            ...membershipKey(familyId, user.userId),
            entityType: "MEMBERSHIP",
            familyId,
            userId: user.userId,
            role: "parent",
            joinedAt: now,
            GSI1PK: `USER#${user.userId}`,
            GSI1SK: `FAMILY#${familyId}`,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      auditPut(familyId, user.userId, "FAMILY_CREATED", now),
    ],
  }));

  return jsonResponse(201, { family: { familyId, name, status: "active", createdAt: now } });
}

async function listFamilies(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  const memberships = await documentClient.send(new QueryCommand({
    TableName: getTableName(),
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :userKey AND begins_with(GSI1SK, :familyPrefix)",
    ExpressionAttributeValues: {
      ":userKey": `USER#${user.userId}`,
      ":familyPrefix": "FAMILY#",
    },
    Limit: 50,
  }));

  const families = await Promise.all((memberships.Items ?? []).map(async (membership) => {
    const familyId = String(membership.familyId);
    const result = await documentClient.send(new GetCommand({
      TableName: getTableName(),
      Key: familyKey(familyId),
      ConsistentRead: true,
    }));
    if (!result.Item) return null;
    return {
      familyId,
      name: result.Item.name,
      status: result.Item.status,
      role: membership.role,
      joinedAt: membership.joinedAt,
    };
  }));

  return jsonResponse(200, { families: families.filter((family) => family !== null) });
}

async function createInvitation(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  if (!user.emailVerified) throw new HttpError(403, "email_not_verified", "Verify your email before inviting a parent.");

  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);

  const { email } = parseBody(event, createInvitationSchema);
  if (user.email?.toLowerCase() === email) {
    throw new HttpError(400, "invalid_invitation", "You cannot invite your own account.");
  }

  const invitationId = randomUUID();
  const invitationToken = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(invitationToken);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + invitationLifetimeSeconds;

  await documentClient.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: getTableName(),
          Item: {
            PK: `FAMILY#${familyId}`,
            SK: `INVITE#${invitationId}`,
            entityType: "FAMILY_INVITATION",
            familyId,
            invitationId,
            invitedEmail: email,
            invitedBy: user.userId,
            status: "pending",
            createdAt,
            expirationTime: expiresAt,
            tokenHash,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      {
        Put: {
          TableName: getTableName(),
          Item: {
            PK: `INVITATION_TOKEN#${tokenHash}`,
            SK: "METADATA",
            entityType: "INVITATION_LOOKUP",
            familyId,
            invitationId,
            invitedEmail: email,
            status: "pending",
            expiresAt,
          },
          ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
        },
      },
      auditPut(familyId, user.userId, "FAMILY_INVITATION_CREATED", createdAt, { invitationId }),
    ],
  }));

  return jsonResponse(201, {
    invitation: { invitationId, familyId, email, status: "pending", createdAt, expiresAt },
    invitationToken,
  });
}

async function listInvitations(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  if (!familyId) throw new HttpError(400, "invalid_request", "A family ID is required.");
  await requireFamilyMember(user.userId, familyId);

  const result = await documentClient.send(new QueryCommand({
    TableName: getTableName(),
    KeyConditionExpression: "PK = :familyKey AND begins_with(SK, :invitePrefix)",
    ExpressionAttributeValues: {
      ":familyKey": `FAMILY#${familyId}`,
      ":invitePrefix": "INVITE#",
    },
    Limit: 50,
    ScanIndexForward: false,
  }));

  const invitations = (result.Items ?? []).map((item) => ({
    invitationId: item.invitationId,
    email: item.invitedEmail,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expirationTime,
    acceptedAt: item.acceptedAt,
  }));
  return jsonResponse(200, { invitations });
}

async function cancelInvitation(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  const familyId = event.pathParameters?.familyId;
  const invitationId = event.pathParameters?.invitationId;
  if (!familyId || !invitationId) throw new HttpError(400, "invalid_request", "Family and invitation IDs are required.");
  await requireFamilyMember(user.userId, familyId);

  const invitationResult = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: `FAMILY#${familyId}`, SK: `INVITE#${invitationId}` },
    ConsistentRead: true,
  }));
  const invitation = invitationResult.Item;
  if (!invitation) throw new HttpError(404, "invitation_not_found", "The invitation was not found.");
  if (invitation.status !== "pending") {
    throw new HttpError(409, "invitation_not_pending", "Only a pending invitation can be cancelled.");
  }

  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: getTableName(),
            Key: { PK: `FAMILY#${familyId}`, SK: `INVITE#${invitationId}` },
            UpdateExpression: "SET #status = :cancelled, cancelledAt = :now",
            ConditionExpression: "#status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":cancelled": "cancelled",
              ":pending": "pending",
              ":now": new Date().toISOString(),
            },
          },
        },
        {
          Update: {
            TableName: getTableName(),
            Key: { PK: `INVITATION_TOKEN#${String(invitation.tokenHash)}`, SK: "METADATA" },
            UpdateExpression: "SET #status = :cancelled",
            ConditionExpression: "#status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":cancelled": "cancelled", ":pending": "pending" },
          },
        },
        auditPut(familyId, user.userId, "FAMILY_INVITATION_CANCELLED", new Date().toISOString(), { invitationId }),
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      throw new HttpError(409, "invitation_not_pending", "Only a pending invitation can be cancelled.");
    }
    throw error;
  }

  return jsonResponse(200, { invitationId, status: "cancelled" });
}

async function acceptInvitation(event: Parameters<Parameters<typeof createHandler>[0]>[0]) {
  const user = getAuthenticatedUser(event);
  if (!user.email || !user.emailVerified) {
    throw new HttpError(403, "verified_email_required", "A verified email address is required to accept an invitation.");
  }

  const { invitationToken } = parseBody(event, acceptInvitationSchema);
  const tokenHash = hashToken(invitationToken);
  const lookup = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: `INVITATION_TOKEN#${tokenHash}`, SK: "METADATA" },
    ConsistentRead: true,
  }));
  const invitation = lookup.Item;
  if (!invitation) throw new HttpError(404, "invitation_not_found", "The invitation was not found.");
  if (invitation.invitedEmail !== user.email.toLowerCase()) {
    throw new HttpError(403, "invitation_email_mismatch", "Sign in with the email address that was invited.");
  }
  if (invitation.status !== "pending" || Number(invitation.expiresAt) <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(409, "invitation_expired", "The invitation is no longer available.");
  }

  const familyId = String(invitation.familyId);
  const invitationId = String(invitation.invitationId);
  const acceptedAt = new Date().toISOString();
  try {
    await documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: getTableName(),
            Key: { PK: `FAMILY#${familyId}`, SK: `INVITE#${invitationId}` },
            UpdateExpression: "SET #status = :accepted, acceptedAt = :acceptedAt, acceptedBy = :userId",
            ConditionExpression: "#status = :pending AND expirationTime > :now AND invitedEmail = :email",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":accepted": "accepted",
              ":acceptedAt": acceptedAt,
              ":userId": user.userId,
              ":pending": "pending",
              ":now": Math.floor(Date.now() / 1000),
              ":email": user.email.toLowerCase(),
            },
          },
        },
        {
          Update: {
            TableName: getTableName(),
            Key: { PK: `INVITATION_TOKEN#${tokenHash}`, SK: "METADATA" },
            UpdateExpression: "SET #status = :accepted, acceptedAt = :acceptedAt, acceptedBy = :userId",
            ConditionExpression: "#status = :pending AND expiresAt > :now AND invitedEmail = :email",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":accepted": "accepted",
              ":acceptedAt": acceptedAt,
              ":userId": user.userId,
              ":pending": "pending",
              ":now": Math.floor(Date.now() / 1000),
              ":email": user.email.toLowerCase(),
            },
          },
        },
        {
          Put: {
            TableName: getTableName(),
            Item: {
              PK: `FAMILY#${familyId}`,
              SK: `MEMBER#${user.userId}`,
              entityType: "MEMBERSHIP",
              familyId,
              userId: user.userId,
              role: "parent",
              joinedAt: acceptedAt,
              GSI1PK: `USER#${user.userId}`,
              GSI1SK: `FAMILY#${familyId}`,
            },
            ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
          },
        },
        {
          ConditionCheck: {
            TableName: getTableName(),
            Key: { PK: `FAMILY#${familyId}`, SK: "METADATA" },
            ConditionExpression: "#status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":active": "active" },
          },
        },
        auditPut(familyId, user.userId, "FAMILY_INVITATION_ACCEPTED", acceptedAt, { invitationId }),
      ],
    }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") {
      throw new HttpError(409, "invitation_unavailable", "The invitation has already been used or is no longer active.");
    }
    throw error;
  }

  return jsonResponse(200, { familyId, status: "accepted", joinedAt: acceptedAt });
}

export const handler = createHandler(async (event) => {
  const route = `${event.httpMethod} ${event.resource}`;
  switch (route) {
    case "POST /families":
      return createFamily(event);
    case "GET /families":
      return listFamilies(event);
    case "POST /families/{familyId}/invitations":
      return createInvitation(event);
    case "GET /families/{familyId}/invitations":
      return listInvitations(event);
    case "DELETE /families/{familyId}/invitations/{invitationId}":
      return cancelInvitation(event);
    case "POST /invitations/accept":
      return acceptInvitation(event);
    default:
      throw new HttpError(404, "route_not_found", "The requested route was not found.");
  }
});
