import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});

export const documentClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export function getTableName(): string {
  const tableName = process.env.DATA_TABLE_NAME;
  if (!tableName) throw new Error("DATA_TABLE_NAME is not configured");
  return tableName;
}
