import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { HttpError } from "./http";
import { documentClient, getTableName } from "./dynamo";

export async function requireFamilyMember(userId: string, familyId: string): Promise<void> {
  const result = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: `FAMILY#${familyId}`, SK: `MEMBER#${userId}` },
    ConsistentRead: true,
  }));

  if (!result.Item) throw new HttpError(404, "family_not_found", "The family was not found.");
}
