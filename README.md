# Coparent

Backend-first monorepo for a coparenting application. The repository uses pnpm workspaces and Turborepo; each workspace can be built and deployed independently.

## Backend

`apps/backend` contains the AWS CDK application, API Gateway REST API, and Lambda handlers. Product domains are organized under `apps/backend/src/features` for families, messages, calls, and calendar.

Protected routes use a Cognito access token in the `Authorization: Bearer <token>` header. Shared records are family-scoped in DynamoDB.

### Current API surface

- `GET /health`, `GET /me`
- `POST, GET /families`; family invitation create/list/cancel and `POST /invitations/accept`
- `POST, GET /families/{familyId}/messages`; message read receipts and reports
- `GET /families/{familyId}/calendar`; agreed events, proposal create/respond/withdraw, and event history
- `POST, GET /families/{familyId}/calls`; invitation response, caller cancellation, session retrieval, call end, and recording retrieval

Call invitations expire after five minutes. A media meeting and attendee join credentials are created only after acceptance. Recording requires the caller to request it, the invitee to consent, and the family to have the `call_recording` entitlement. New families start on the `basic` plan with no opt-in features enabled. The invitation notification is written to a DynamoDB outbox; push delivery is part of the notifications stage and is not wired yet.

## Requirements

- Node.js 22 or newer
- pnpm 11
- AWS CDK credentials and a bootstrapped AWS environment to deploy

## Commands

From the repository root:

```sh
pnpm install
pnpm build
pnpm check-types
pnpm synth
pnpm deploy
```

`pnpm synth` creates a CloudFormation template without deploying. Set the CDK context `stage` to choose a stack stage, for example `pnpm deploy -- --context stage=dev`.

The AWS account and region are read from the active AWS credentials/configuration. Deploying for the first time in an AWS environment may require `pnpm --filter @coparent/backend bootstrap`.
