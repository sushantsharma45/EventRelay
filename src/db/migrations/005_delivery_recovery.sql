ALTER TABLE deliveries
ADD COLUMN dead_lettered_at timestamptz;

CREATE INDEX deliveries_dead_lettered_idx
ON deliveries(updated_at DESC)
WHERE state = 'dead_lettered';

CREATE INDEX deliveries_recovery_idx
ON deliveries(updated_at)
WHERE state = 'processing';