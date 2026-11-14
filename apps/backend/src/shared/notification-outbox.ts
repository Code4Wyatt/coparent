import { randomUUID } from "node:crypto";
import { getTableName } from "./dynamo";

export function notificationOutboxPut(
  familyId: string,
  recipientId: string,
  notificationType: string,
  referenceId: string,
  createdAt: string,
) {
  const notificationId = randomUUID();
  return {
    Put: {
      TableName: getTableName(),
      Item: {
        PK: `FAMILY#${familyId}`,
        SK: `NOTIFICATION#${createdAt}#${notificationId}`,
        entityType: "NOTIFICATION_OUTBOX",
        notificationId,
        familyId,
        recipientId,
        notificationType,
        referenceId,
        deliveryStatus: "pending",
        createdAt,
      },
      ConditionExpression: "attribute_not_exists(PK) AND attribute_not_exists(SK)",
    },
  };
}
