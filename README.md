# EventRelay

EventRelay is a webhook delivery platform for applications that need to send events to customer-configured endpoints.

## Current capabilities

EventRelay provides account registration and login, organization management, role-based access, projects, environments, API keys, webhook subscriptions, idempotent event ingestion, asynchronous signed delivery, retry and replay controls, and a React operations dashboard.

Authentication uses bcrypt password hashes, JWTs signed with a local secret, and rate limits on registration and login. The API applies a per-process request limit, records organization changes in an audit log, and blocks webhook delivery to private network addresses in production. PostgreSQL stores application and delivery data. API key secrets are stored as hashes; endpoint signing secrets are encrypted with `DATA_ENCRYPTION_KEY`.

Email invitations and password reset are not available yet.

## Requirements

- Node.js 22.12 or newer
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
7. In another terminal, start the dashboard with `npm run dev:web` and open `http://localhost:5173`. The Vite development server proxies API calls to `PORT` from `.env` (4000 if unset).
8. Start Redis, then start the outbox publisher and delivery worker with `npm run worker` to process deliveries. `npm run dev:dashboard` starts the API and dashboard together; `npm run dev:stack` also starts the worker and requires Redis.
9. Check API liveness at `http://localhost:4401/health` and database readiness at `http://localhost:4401/health/ready` when using the included local `.env` (`PORT=4401`).

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
- `GET /v1/organizations/:organizationId/audit` — view recent changes (owners and admins only).

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
## Dashboard

The React dashboard at `http://localhost:5173` supports registration and login, organization switching, member roles, project and environment management, endpoint subscriptions, API keys, test event submission, delivery attempt inspection and replay, and admin audit history. Newly created API key and webhook signing secrets are displayed once and held only in the current browser tab.

Run `npm run build` to type-check the backend and create the production dashboard under `dist/web`; the API serves these files from its root URL.

## Checks

- `npm test` runs API health and readiness, authentication, authorization, resource, event, delivery, SSRF, and audit tests. It requires a migrated PostgreSQL database. Local receiver tests do not require Redis.
- `npm run build` validates the code, compiles the API to `dist/server`, and builds the dashboard to `dist/web`.
- `npm run db:migrate` applies unapplied numbered SQL migrations under `src/db/migrations`.

## Docker Compose

Docker Compose starts PostgreSQL, Redis, a one-shot migration service, the API with the built dashboard, and the delivery worker. Set `POSTGRES_PASSWORD`, `JWT_SECRET`, and `DATA_ENCRYPTION_KEY` in `.env` before using Compose. Use a URL-safe password for `POSTGRES_PASSWORD`, since Compose uses it in `DATABASE_URL`.

- `docker compose up --build` builds the production image and starts the local stack. The API is available at the configured `PORT`; PostgreSQL and Redis are bound to localhost ports 5433 and 6380 by default.
- `docker compose --profile observability up --build` also starts Prometheus at `http://127.0.0.1:9090`. The API and worker expose Prometheus metrics on private container ports 9464 and 9465; those ports are not published to the host.
- `docker compose ps` shows database, migration, API readiness, and worker status.
- `docker compose down` stops containers and preserves the named database and Redis volumes.
- `docker compose down --volumes` deletes those volumes and their data.

The GitHub Actions workflow starts PostgreSQL and Redis services, installs from the lockfile, applies migrations, builds the API and dashboard, runs the integration and security tests, validates Compose, and builds the production image on pushes and pull requests. See [DEPLOYMENT.md](DEPLOYMENT.md) for generic Docker host deployment, health checks, backups, rollback, and monitoring guidance.
