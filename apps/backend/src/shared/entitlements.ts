import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient, getTableName } from "./dynamo";
import { HttpError } from "./http";

export async function requireFeatureEntitlement(familyId: string, feature: string): Promise<void> {
  const result = await documentClient.send(new GetCommand({
    TableName: getTableName(),
    Key: { PK: `FAMILY#${familyId}`, SK: "ENTITLEMENTS" },
    ConsistentRead: true,
  }));
  const enabledFeatures = result.Item?.enabledFeatures;
  if (!Array.isArray(enabledFeatures) || !enabledFeatures.includes(feature)) {
    throw new HttpError(403, "feature_not_entitled", "This feature is not enabled for the family.");
  }
}
