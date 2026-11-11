# EventRelay

EventRelay is a webhook delivery platform for applications that need to send events to customer-configured endpoints.

## Current capabilities

The API provides account registration and login, short-lived bearer access tokens, authenticated account details, organization management, member management, and role-based organization access. New accounts get a private organization with the owner role. Organization data is checked against the signed-in user's membership before member routes return data.

Authentication uses bcrypt password hashes, JWTs signed with a local secret, and rate limits on registration and login. PostgreSQL stores accounts, organizations, memberships, projects, environments, API keys, endpoints, and subscriptions. The API also includes validated runtime configuration, security headers, request IDs, structured logs with credential redaction, centralized errors, graceful shutdown, connection pooling, readiness checks, and numbered SQL migrations.

Members can be added by email after they have created an account. Organization owners can assign admin, developer, or viewer roles. Admins can manage developer and viewer members but cannot grant admin access or modify other admins. Invitations by email, password reset, asynchronous delivery and the dashboard are not available yet.

## Requirements

- Node.js 22 or newer
- npm
- PostgreSQL 16 or newer

## Local setup

1. Install dependencies with `npm install`.
2. Create a PostgreSQL database and set its connection URL in `.env` as `DATABASE_URL`.
3. Set `JWT_SECRET` in `.env` to a random value containing at least 32 characters. Set `DATA_ENCRYPTION_KEY` to a base64-encoded, randomly generated 32-byte key.
4. Apply migrations with `npm run db:migrate`.
5. Start the API with `npm run dev`.
6. Check liveness at `http://localhost:4401/health` and database readiness at `http://localhost:4401/health/ready`.

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

An API key's secret and an endpoint's signing secret are returned only when created. API key secrets are stored as hashes. Endpoint signing secrets are encrypted with `DATA_ENCRYPTION_KEY`.

## Event ingestion API

`POST /v1/events` accepts an event using an environment API key in the bearer authorization header. Include an `Idempotency-Key` header and a JSON body with `eventType`, an object `payload`, and optional object `metadata`. New events are saved together with an outbox record in one database transaction and return `202 Accepted`. Repeating the same key and content returns the original event; reusing a key with different content returns `409 Conflict`. Event delivery is handled in a later stage.

## Checks

- `npm test` runs health, authentication, authorization, resource-management, and database-backed ingestion tests.
- `npm run build` runs strict TypeScript validation.
- `npm run db:migrate` applies unapplied numbered SQL migrations under `src/db/migrations`.