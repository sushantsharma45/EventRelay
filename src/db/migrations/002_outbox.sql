CREATE TABLE outbox_messages (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);

CREATE INDEX outbox_messages_unpublished_idx
  ON outbox_messages (created_at)
  WHERE published_at IS NULL;
