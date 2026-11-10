CREATE INDEX projects_org_created_idx ON projects(organization_id, created_at DESC);
CREATE INDEX environments_project_created_idx ON environments(project_id, created_at DESC);
CREATE INDEX api_keys_environment_created_idx ON api_keys(environment_id, created_at DESC);
CREATE INDEX endpoints_environment_created_idx ON endpoints(environment_id, created_at DESC);
CREATE INDEX subscriptions_event_type_idx ON subscriptions(event_type);