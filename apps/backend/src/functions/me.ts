import type { APIGatewayProxyHandler } from "aws-lambda";

interface CognitoClaims {
  sub?: string;
  email?: string;
  email_verified?: string;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const authorizer = event.requestContext.authorizer as
    | { claims?: CognitoClaims }
    | null
    | undefined;
  const claims = authorizer?.claims;

  if (!claims?.sub) {
    return {
      statusCode: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ error: "unauthorized" }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify({
      userId: claims.sub,
      email: claims.email ?? null,
      emailVerified: claims.email_verified === "true",
    }),
  };
};
