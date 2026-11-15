# EventRelay Docker deployment

This guide deploys the production image on a single Docker host. It uses Docker Compose, durable PostgreSQL and Redis volumes, a one-shot migration container, a non-root API/worker image, and an optional private Prometheus stack. Put a TLS reverse proxy in front of the API for public access.

## Prepare the host

Install Docker Engine and the Docker Compose plugin. Configure the host firewall to allow only SSH and HTTPS (and HTTP if the reverse proxy redirects to HTTPS). Keep the application, PostgreSQL, Redis, Prometheus, and metrics ports bound to loopback or the private Compose network. The Compose file publishes the API, database, Redis, and Prometheus UI on loopback only.

Create `.env` in the project root and provide these production values:

- `POSTGRES_PASSWORD`: a long URL-safe password. The Compose connection URL embeds this value.
- `JWT_SECRET`: a unique random secret containing at least 32 characters.
- `DATA_ENCRYPTION_KEY`: a base64-encoded random 32-byte key. Preserve it: rotating it without re-encrypting endpoint secrets makes existing stored secrets unreadable.
- `CORS_ORIGIN`: the exact HTTPS origin that serves the dashboard.

Generate secrets in Git Bash without putting them in shell history:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Use the hex output for `JWT_SECRET` and the base64 output for `DATA_ENCRYPTION_KEY`. Keep `.env` out of Git and restrict access to it on the host. Do not reuse the local development secrets.

## Deploy and verify

From the project root on the Docker host:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api worker migrate
curl --fail http://127.0.0.1:4000/health
curl --fail http://127.0.0.1:4000/health/ready
```

The migration service must exit with code 0, the API must report `healthy`, and the worker must report `healthy`. Configure the host reverse proxy to forward HTTPS requests to `http://127.0.0.1:4000`; enable TLS and keep port 4000 private. PostgreSQL and Redis data use named Docker volumes.

The dashboard and API are served from one origin. Set `CORS_ORIGIN` to the browser-visible HTTPS origin even though the production dashboard uses the API at that same origin.

## Metrics and alerts

Start Prometheus for local or host-level monitoring with:

```bash
docker compose --profile observability up -d
```

Open `http://127.0.0.1:9090/targets`. Both `eventrelay-api` and `eventrelay-worker` should be `UP`. Prometheus scrapes private container ports 9464 and 9465. Those endpoints are not published to the host. The API exports bounded-cardinality HTTP request counts and latency histograms plus Node.js process metrics. The worker exports queue job outcomes, active jobs, durable webhook attempt outcomes and latency, outbox publishing, retry scheduling, recovery and scheduler error counters. Alert rules cover failed scrapes, elevated HTTP 5xx rates, and worker scheduler errors.

Structured JSON request and worker logs go to stdout/stderr. Use `docker compose logs -f api worker` for a live view and configure the host log driver or collector to retain logs. Metrics and health checks do not replace durable database backups.

## Back up and restore PostgreSQL

Run these commands in Git Bash from the project root. Keep the resulting dump encrypted and off-host:

```bash
docker compose exec -T database sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > eventrelay-backup.sql
docker compose exec -T database sh -c 'createdb -U "$POSTGRES_USER" eventrelay_restore'
cat eventrelay-backup.sql | docker compose exec -T database sh -c 'psql -U "$POSTGRES_USER" eventrelay_restore'
```

The restore commands create a separate `eventrelay_restore` database so they do not overwrite the running application database. Test restoration on a separate host before relying on a backup. The Docker volumes are persistent storage, not backups. `docker compose down --volumes` permanently removes the PostgreSQL, Redis and Prometheus volumes.

## Update and rollback

Before deploying an update, take and verify a database backup. Then run `docker compose up -d --build` and check the migration exit status, API readiness, worker health, Prometheus targets and application logs. Keep the previous image available for rollback. Database migrations are forward-only in this project; if a migration changes stored data, restoring a pre-deploy backup may be required before reverting the image. Do not delete volumes during routine updates.

## Current deployment boundary

This repository includes a provider-neutral Docker deployment and observability configuration. A public deployment still needs a chosen host, DNS, TLS termination, firewall configuration, and host-managed secret storage.
