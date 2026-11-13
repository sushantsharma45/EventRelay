CREATE INDEX audit_actor_time_idx
ON audit_log(actor_id, created_at DESC)
WHERE actor_id IS NOT NULL;