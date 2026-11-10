CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE org_role AS ENUM ('owner','admin','developer','viewer');
CREATE TYPE delivery_state AS ENUM ('pending','processing','retrying','succeeded','failed','dead_lettered');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE, role org_role NOT NULL DEFAULT 'developer',
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (organization_id,user_id)
);

CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  name text NOT NULL, slug text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,slug)
);

CREATE TABLE environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  name text NOT NULL, slug text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,slug)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment_id uuid NOT NULL REFERENCES environments ON DELETE CASCADE,
  label text NOT NULL, prefix text NOT NULL UNIQUE, secret_hash text NOT NULL, last_used_at timestamptz,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment_id uuid NOT NULL REFERENCES environments ON DELETE CASCADE,
  url text NOT NULL, description text NOT NULL DEFAULT '', signing_secret_enc text NOT NULL,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  endpoint_id uuid NOT NULL REFERENCES endpoints ON DELETE CASCADE, event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(endpoint_id,event_type)
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment_id uuid NOT NULL REFERENCES environments ON DELETE CASCADE,
  event_type text NOT NULL, payload jsonb NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  idempotency_key text, replay_of uuid REFERENCES events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(environment_id,idempotency_key)
);

CREATE INDEX events_env_created_idx ON events(environment_id,created_at DESC);
CREATE INDEX events_type_idx ON events(environment_id,event_type,created_at DESC);
CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES endpoints ON DELETE CASCADE, state delivery_state NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer, last_error text, duration_ms integer, replay_of uuid REFERENCES deliveries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX deliveries_original_pair_uq ON deliveries(event_id,endpoint_id) WHERE replay_of IS NULL;
CREATE UNIQUE INDEX deliveries_replay_source_uq ON deliveries(replay_of) WHERE replay_of IS NOT NULL;
CREATE INDEX deliveries_due_idx ON deliveries(next_attempt_at) WHERE state IN ('pending','retrying');
CREATE INDEX deliveries_event_idx ON deliveries(event_id,created_at DESC);
CREATE TABLE delivery_attempts (
  id bigserial PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES deliveries ON DELETE CASCADE,
  attempt_number integer NOT NULL, request_id uuid NOT NULL DEFAULT gen_random_uuid(), response_status integer,
  response_body text, error text, duration_ms integer NOT NULL, started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(delivery_id,attempt_number)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  actor_id uuid REFERENCES users ON DELETE SET NULL, action text NOT NULL, resource_type text NOT NULL,
  resource_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_time_idx ON audit_log(organization_id,created_at DESC);
