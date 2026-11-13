# EventRelay

EventRelay is a webhook delivery platform for applications that need to send events to customer-configured endpoints.

## Current capabilities

The API provides account registration and login, short-lived bearer access tokens, authenticated account details, organization management, member management, role-based access, projects, environments, API keys, endpoint subscriptions, idempotent event ingestion, an outbox publisher, and signed webhook delivery.

Authentication uses bcrypt password hashes, JWTs signed with a local secret, and rate limits on registration and login. The API also applies a per-process request limit, records organization changes in an audit log, and blocks webhook delivery to private network addresses in production. PostgreSQL stores application and delivery data. API key secrets are stored as hashes; endpoint signing secrets are encrypted with `DATA_ENCRYPTION_KEY`.

Email invitations, password reset, and the dashboard are not available yet.

## Requirements

- Node.js 22 or newer
- npm
- PostgreSQL 16 or newer
- A Redis-compatible server

## Local setup

1. Install dependencies with `npm install`.
2. Create a PostgreSQL database and set its connection URL in `.env` as `DATABASE_URL`.
3. Set `JWT_SECRET` to a random value containing at least 32 characters. Set `DATA_ENCRYPTION_KEY` to a base64-encoded, randomly generated 32-byte key.
4. Start a Redis-compatible server at the `REDIS_URL` in `.env` (default `redis://127.0.0.1:6379`). For local webhook receiver testing, `ALLOW_PRIVATE_WEBHOOKS=true` permits private destinations only when `NODE_ENV` is not `production`.
5. Apply migrations with `npm run db:migrate`.
6. Start the API with `npm run dev`.
7. In a second terminal, start the outbox publisher and delivery worker with `npm run worker`.
8. Check API liveness at `http://localhost:4000/health` and database readiness at `http://localhost:4000/health/ready`.

## Authentication API

All request and response bodies use JSON. Successful registration and login return a bearer token. Send it on protected requests as `Authorization: Bearer <token>`.

- `POST /v1/auth/register` — create an account and its owner organization. Requires `name`, `email`, and a password of at least 12 characters and at most 72 UTF-8 bytes.
- `POST /v1/auth/login` — authenticate with `email` and `password`.
- `GET /v1/auth/me` — return the authenticated account.
- `GET /v1/organizations` — list the signed-in user's organizations and roles.
- `POST /v1/organizations` — create an organization; the creator is its owner.
- `GET /v1/organizations/:organizationId/members` — list members when the signed-in user belongs to that organization.
- `POST /v1/organizations/:organizationId/members` — add an existing account by `email` and assign `admin`, `developer`, or `viewer`.
- `PATCH /v1/organizations/:organizationId/members/:userId` — change a member's role.
- `DELETE /v1/organizations/:organizationId/members/:userId` — remove a member.

## Project resources API

All resource routes require a bearer token and an organization membership. Owners, admins, and developers can create and change resources; viewers can read them.

- `GET/POST /v1/organizations/:organizationId/projects` — list or create projects.
- `PATCH/DELETE /v1/organizations/:organizationId/projects/:projectId` — rename or delete a project.
- `GET/POST /v1/organizations/:organizationId/projects/:projectId/environments` — list or create project environments.
- `GET/POST /v1/organizations/:organizationId/projects/:projectId/environments/:environmentId/api-keys` — list or create scoped API keys.
- `DELETE /v1/organizations/:organizationId/projects/:projectId/environments/:environmentId/api-keys/:keyId` — revoke an API key.
- `GET/POST /v1/organizations/:organizationId/projects/:projectId/environments/:environmentId/endpoints` — list or create webhook endpoints and their event subscriptions.
- `PATCH/DELETE /v1/organizations/:organizationId/projects/:projectId/environments/:environmentId/endpoints/:endpointId` — update or remove an endpoint.
- `PUT /v1/organizations/:organizationId/projects/:projectId/environments/:environmentId/endpoints/:endpointId/subscriptions` — replace the endpoint's event type subscriptions.

API key secrets and endpoint signing secrets are returned only when created. Save them at that time.

## Event ingestion and delivery

`POST /v1/events` accepts an event using an environment API key in the bearer authorization header. Include an `Idempotency-Key` header and a JSON body with `eventType`, an object `payload`, and optional object `metadata`. New events are saved together with an outbox record in one database transaction and return `202 Accepted`. Repeating the same key and content returns the original event; reusing a key with different content returns `409 Conflict`.

The outbox publisher queues events in BullMQ. The worker sends matching webhook subscriptions and stores the delivery attempt. Delivery requests include `X-EventRelay-Event-Id`, `X-EventRelay-Event-Type`, `X-EventRelay-Timestamp`, and `X-EventRelay-Signature` headers. The signature is HMAC-SHA256 over `<timestamp>.<raw-json-body>` using the endpoint signing secret.

## Delivery recovery

Retryable network failures and HTTP 408, 425, 429, and 5xx responses use exponential backoff starting at 2 seconds, capped at 1 hour, for up to 8 attempts. Other HTTP errors are dead-lettered immediately. The worker recovers deliveries left processing for more than 2 minutes.

- `GET /v1/organizations/:organizationId/deliveries` — list delivery state and filter with `?state=dead_lettered`.
- `GET /v1/organizations/:organizationId/deliveries/:deliveryId/attempts` — view request attempts and response details.
- `POST /v1/organizations/:organizationId/deliveries/:deliveryId/replay` — replay a failed or dead-lettered delivery. The new delivery is queued through the outbox; a delivery can be replayed only once.
## Checks

- `npm test` runs health, authentication, authorization, resource-management, ingestion, retry, dead-letter, replay, and signed-delivery tests. The signed-delivery test does not require Redis; running `npm run worker` does.
- `npm run build` runs strict TypeScript validation.
- `npm run db:migrate` applies unapplied numbered SQL migrations under `src/db/migrations`.