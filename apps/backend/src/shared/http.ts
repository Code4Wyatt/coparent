import type {
  APIGatewayProxyEvent,
  APIGatewayProxyHandler,
  APIGatewayProxyResult,
} from "aws-lambda";
import type { ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

export function parseBody<T>(event: APIGatewayProxyEvent, schema: ZodType<T>): T {
  if (!event.body) throw new HttpError(400, "invalid_request", "A JSON request body is required.");

  let body: unknown;
  try {
    body = JSON.parse(event.body);
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must contain valid JSON.");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "invalid_request",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
}

export interface AuthenticatedUser {
  userId: string;
  email?: string;
  emailVerified: boolean;
}

export function getAuthenticatedUser(event: APIGatewayProxyEvent): AuthenticatedUser {
  const authorizer = event.requestContext.authorizer as
    | { claims?: Record<string, string | undefined> }
    | null
    | undefined;
  const claims = authorizer?.claims;
  if (!claims?.sub) throw new HttpError(401, "unauthorized", "A valid user session is required.");

  return {
    userId: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === "true",
  };
}

export function createHandler(
  operation: (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>,
): APIGatewayProxyHandler {
  return async (event) => {
    try {
      return await operation(event);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(error.statusCode, { error: error.code, message: error.message });
      }

      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error(JSON.stringify({
        event: "request_failed",
        requestId: event.requestContext.requestId,
        errorName,
      }));
      return jsonResponse(500, {
        error: "internal_error",
        message: "The request could not be completed.",
      });
    }
  };
}
