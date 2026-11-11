ALTER TABLE outbox_messages
ADD COLUMN event_id uuid REFERENCES events(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX outbox_event_once_idx
ON outbox_messages(event_id)
WHERE event_id IS NOT NULL;