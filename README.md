# EventRelay

EventRelay is a webhook delivery platform for applications that need to send events to customer-configured endpoints.

## Current capabilities

The API foundation includes strict TypeScript, validated runtime configuration, security headers, scoped CORS, request IDs, structured logs with credential redaction, centralized errors, graceful shutdown, PostgreSQL connection pooling, database readiness checks, and versioned migrations for the core relational model.

Authentication, public event ingestion, asynchronous delivery, and the dashboard are still under development.

## Requirements

- Node.js 22 or newer
- npm
- PostgreSQL 16 or newer

## Local setup

1. Install dependencies: `npm install`.
2. Update `.env` with a PostgreSQL database URL available on your machine.
3. Create the database named in `DATABASE_URL` if it does not exist.
4. Apply migrations: `npm run db:migrate`.
5. Start the API: `npm run dev`.
6. Check liveness at `http://localhost:4401/health` and database readiness at `http://localhost:4401/health/ready`.

## Checks

- `npm test` runs API health-route smoke tests.
- `npm run build` runs strict TypeScript validation.
- `npm run db:migrate` applies unapplied numbered SQL migrations under `src/db/migrations`.
