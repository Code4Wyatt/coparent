# Backend MVP delivery plan

## Target shape

```text
Web/mobile clients
  -> Cognito User Pool (identity)
  -> API Gateway REST API (Cognito authorizer)
  -> domain Lambda handlers
  -> DynamoDB (family-scoped records)

Call media runs through a dedicated real-time media provider only after the
invitee accepts. Recordings go to private S3 storage. DynamoDB Streams drive
asynchronous notifications and other follow-up work.
```

The DynamoDB table is the primary application store. Feature entitlements are checked in the backend for every paid feature.

## Delivery stages

### 1. Backend foundations and identity

- Configure stage-aware CDK deployments and API Gateway REST routing.
- Add a Cognito user pool with verified email sign-in and an app client for
  native/mobile and web clients.
- Add the family-data DynamoDB table, GSI for user/family lookups, TTL support,
  point-in-time recovery, and DynamoDB Streams.
- Add shared HTTP response, request validation, error, logging, and identity
  helpers. Keep message bodies, call media, and other sensitive payloads out of
  logs.
- Keep `/health` public and add an authenticated `/me` route.

**Complete when:** CDK synthesizes the identity, API, and data resources; a
valid Cognito access token is required by `/me`; unauthenticated requests are
rejected.

### 2. Family membership and access boundaries

- Add family creation, invitation, acceptance, and membership lookup flows.
- Bind every protected record to a `familyId`; resolve the caller's membership
  server-side and never trust a client-supplied family ID on its own.
- Use conditional writes and single-use, expiring invitation tokens to prevent
  replay and concurrent acceptance.
- Record membership and invitation changes in an append-only audit stream.

**Complete when:** two authenticated accounts can join the same family and a
user cannot read or change another family's records.

### 3. Moderated messaging

- Add send, paginated history, read state, and message report endpoints.
- Run message text through an Amazon Comprehend toxicity adapter before
  accepting it; persist moderation outcome and policy version with the message.
- Configure the block threshold per deployment. The initial Comprehend toxicity
  integration supports English only; unsupported languages fail closed.
- Return an explicit blocked/review/accepted outcome; keep provider credentials
  and provider-specific response formats inside the adapter.
- Publish a message-created event for push delivery after the write succeeds.

**Complete when:** only family members can read a thread, message writes have a
recorded moderation decision, and failed moderation does not silently accept a
message.

### 4. Shared calendar and proposed amendments

- Add schedule/event reads by date range and endpoints for creating agreed
  events.
- Add proposed amendment creation, accept, decline, and withdrawal flows with
  an immutable response history.
- Support proposals to add, change, or cancel a calendar event; accepting a
  proposal and writing the resulting event revision are one DynamoDB
  transaction.
- Store instants in UTC with the relevant IANA time zone for display and
  recurring-plan interpretation.
- Return a calendar view that distinguishes the agreed plan from pending
  proposed changes, so clients can show both at a glance.
- Use conditional updates to prevent two concurrent responses from overwriting
  each other.

**Complete when:** both parents see the same agreed schedule and a proposal is
visibly separate until accepted.

### 5. Call invitations, acceptance, and recording

- Add invite, accept, decline, cancel, expire, and session retrieval endpoints.
- Persist invitation state before notifying the other parent. Do not create a
  media session or return join credentials until acceptance.
- Write a durable call-invitation notification outbox record in the same
  DynamoDB transaction as the invitation. Push delivery is wired in stage 7.
- Put the real-time media integration behind a provider interface. The first
  AWS implementation can use Amazon Chime SDK meetings; keep meeting media out
  of API Gateway and Lambda.
- Gate call recording by entitlement and per-call consent. Store recordings in
  a private S3 bucket, keep metadata and lifecycle state in DynamoDB, and apply
  a configured retention policy. Both parents must consent before capture starts.
- Make session creation and recording start idempotent; record provider events
  for failed or ended sessions.

**Complete when:** declined or unanswered invitations cannot produce a join
session; accepted participants receive scoped session access; recording state,
consent, and retention are auditable.

### 6. Feature entitlements and pricing hooks

- Define a server-side entitlement model for included and opt-in features.
- Enforce entitlement checks in each paid feature handler, not only in clients.
- Start each new family on a basic plan; opt-in features are disabled unless
  the family entitlement record enables them.
- Add an idempotent billing-event ingestion boundary that updates entitlements.
- Keep the payment provider behind an adapter until web, Apple, and Google
  billing requirements and the initial price catalog are selected.

**Complete when:** each account/family has a server-readable feature set and
paid capabilities cannot be enabled by changing client requests.

### 7. Notifications, operations, and release readiness

- Register and revoke device push tokens; route message, calendar, and call
  invitation notifications through a provider adapter.
- Use DynamoDB Streams for post-write notifications; keep delivery retries
  separate from the user-facing API response.
- Add API throttling, structured request IDs, metrics and alarms, dead-letter
  handling for asynchronous work, and retention/lifecycle policies.
- Add per-environment outputs and deployment configuration. Use least-privilege
  Lambda roles and keep secrets in AWS-managed secret/configuration storage.

**Complete when:** each stage can be deployed independently, failures are
observable, and retrying an event does not duplicate user-visible actions.

## Cross-cutting implementation rules

- Keep API contracts and domain behavior independent of AWS adapters where
  practical; isolate Cognito, DynamoDB, moderation, push, media, and billing
  provider code.
- Use family-scoped access checks for every operation that touches shared
  parenting data.
- Use cursor pagination and request size limits; do not return unbounded
  histories or calendar ranges.
- Treat recordings, messages, moderation outcomes, and audit records as
  sensitive data. Avoid logging their contents.
- Keep external side effects idempotent and distinguish retryable provider
  failures from permanent validation or authorization errors.

## Decisions intentionally left configurable

- Moderation provider and the product policy for block versus human review.
- Push delivery provider and mobile platform credentials.
- Call recording consent UX and retention duration.
- Payment provider, store purchase validation, and paid feature catalog.
- Exact family invitation delivery method and membership roles.
