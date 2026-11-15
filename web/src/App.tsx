import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { apiRequest } from './api.js';

type Role = 'owner' | 'admin' | 'developer' | 'viewer';
type User = { id: string; name: string; email: string };
type Organization = { id: string; name: string; slug: string; role: Role };
type Project = { id: string; name: string; slug: string; created_at: string };
type Environment = { id: string; name: string; slug: string; created_at: string };
type Endpoint = {
  id: string;
  url: string;
  description: string;
  active: boolean;
  created_at: string;
  event_types: string[];
};
type ApiKey = {
  id: string;
  label: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};
type Delivery = {
  id: string;
  event_id: string;
  endpoint_id: string;
  event_type: string;
  endpoint_url: string;
  state: string;
  attempt_count: number;
  last_status: number | null;
  last_error: string | null;
  updated_at: string;
};
type Attempt = {
  id: string;
  attempt_number: number;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  started_at: string;
};
type AuditEntry = {
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
};
type Member = { id: string; name: string; email: string; role: Role; joined_at: string };
type View = 'overview' | 'destinations' | 'deliveries' | 'members' | 'audit';

const readToken = () => window.sessionStorage.getItem('eventrelay_token');
const saveToken = (token: string | null) =>
  token
    ? window.sessionStorage.setItem('eventrelay_token', token)
    : window.sessionStorage.removeItem('eventrelay_token');
const dateTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Never';
const shortId = (value: string) => value.slice(0, 8);

function App() {
  const [token, setToken] = useState<string | null>(readToken);
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState('');
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [selectedDelivery, setSelectedDelivery] = useState('');
  const [view, setView] = useState<View>('overview');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(Boolean(readToken()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newApiKeySecret, setNewApiKeySecret] = useState('');
  const [newSigningSecret, setNewSigningSecret] = useState('');
  const [ingestionKey, setIngestionKey] = useState('');
  const [showNewOrganization, setShowNewOrganization] = useState(false);

  const activeOrganization = organizations.find((item) => item.id === organizationId);
  const canWrite = activeOrganization?.role !== 'viewer';
  const canAdmin = activeOrganization?.role === 'owner' || activeOrganization?.role === 'admin';
  const activeProject = projects.find((item) => item.id === projectId);
  const activeEnvironment = environments.find((item) => item.id === environmentId);

  async function withBusy<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      return await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The request could not be completed.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function loadOrganizations(accessToken: string) {
    const result = await apiRequest<{ data: Organization[] }>('/organizations', {
      token: accessToken,
    });
    setOrganizations(result.data);
    setOrganizationId((selected) =>
      result.data.some((item) => item.id === selected) ? selected : (result.data[0]?.id ?? ''),
    );
  }

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    let current = true;
    Promise.all([
      apiRequest<{ user: User }>('/auth/me', { token }),
      apiRequest<{ data: Organization[] }>('/organizations', { token }),
    ])
      .then(([account, result]) => {
        if (!current) return;
        setUser(account.user);
        setOrganizations(result.data);
        setOrganizationId((selected) =>
          result.data.some((item) => item.id === selected) ? selected : (result.data[0]?.id ?? ''),
        );
      })
      .catch(() => {
        if (!current) return;
        saveToken(null);
        setToken(null);
        setUser(null);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !organizationId) {
      setProjects([]);
      setDeliveries([]);
      setProjectId('');
      return;
    }
    let current = true;
    Promise.all([
      apiRequest<{ data: Project[] }>('/organizations/' + organizationId + '/projects', { token }),
      apiRequest<{ data: Delivery[] }>(
        '/organizations/' + organizationId + '/deliveries?limit=100',
        { token },
      ),
    ])
      .then(([projectResult, deliveryResult]) => {
        if (!current) return;
        setProjects(projectResult.data);
        setProjectId((selected) =>
          projectResult.data.some((item) => item.id === selected)
            ? selected
            : (projectResult.data[0]?.id ?? ''),
        );
        setDeliveries(deliveryResult.data);
      })
      .catch((caught) => {
        if (current)
          setError(
            caught instanceof Error ? caught.message : 'Workspace data could not be loaded.',
          );
      });
    return () => {
      current = false;
    };
  }, [token, organizationId]);

  useEffect(() => {
    if (!token || !organizationId) {
      setMembers([]);
      return;
    }
    let current = true;
    apiRequest<{ data: Member[] }>('/organizations/' + organizationId + '/members', { token })
      .then((result) => {
        if (current) setMembers(result.data);
      })
      .catch((caught) => {
        if (current)
          setError(caught instanceof Error ? caught.message : 'Members could not be loaded.');
      });
    return () => {
      current = false;
    };
  }, [token, organizationId]);

  useEffect(() => {
    if (!token || !organizationId || !projectId) {
      setEnvironments([]);
      setEnvironmentId('');
      return;
    }
    let current = true;
    apiRequest<{ data: Environment[] }>(
      '/organizations/' + organizationId + '/projects/' + projectId + '/environments',
      { token },
    )
      .then((result) => {
        if (!current) return;
        setEnvironments(result.data);
        setEnvironmentId((selected) =>
          result.data.some((item) => item.id === selected) ? selected : (result.data[0]?.id ?? ''),
        );
      })
      .catch((caught) => {
        if (current)
          setError(caught instanceof Error ? caught.message : 'Environments could not be loaded.');
      });
    return () => {
      current = false;
    };
  }, [token, organizationId, projectId]);

  useEffect(() => {
    setNewApiKeySecret('');
    setNewSigningSecret('');
    setIngestionKey('');
  }, [organizationId, projectId, environmentId]);

  useEffect(() => {
    if (view === 'audit' && !canAdmin) setView('overview');
  }, [view, canAdmin]);

  useEffect(() => {
    if (!token || !organizationId || !projectId || !environmentId) {
      setEndpoints([]);
      setApiKeys([]);
      return;
    }
    let current = true;
    const base =
      '/organizations/' +
      organizationId +
      '/projects/' +
      projectId +
      '/environments/' +
      environmentId;
    Promise.all([
      apiRequest<{ data: Endpoint[] }>(base + '/endpoints', { token }),
      apiRequest<{ data: ApiKey[] }>(base + '/api-keys', { token }),
    ])
      .then(([endpointResult, keyResult]) => {
        if (!current) return;
        setEndpoints(endpointResult.data);
        setApiKeys(keyResult.data);
      })
      .catch((caught) => {
        if (current)
          setError(
            caught instanceof Error ? caught.message : 'Environment resources could not be loaded.',
          );
      });
    return () => {
      current = false;
    };
  }, [token, organizationId, projectId, environmentId]);

  useEffect(() => {
    if (!token || !organizationId || view !== 'audit' || !canAdmin) return;
    apiRequest<{ data: AuditEntry[] }>('/organizations/' + organizationId + '/audit?limit=100', {
      token,
    })
      .then((result) => setAudit(result.data))
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : 'Audit history could not be loaded.'),
      );
  }, [token, organizationId, view, canAdmin]);

  async function refreshDeliveries() {
    if (!token || !organizationId) return;
    const result = await apiRequest<{ data: Delivery[] }>(
      '/organizations/' + organizationId + '/deliveries?limit=100',
      { token },
    );
    setDeliveries(result.data);
  }

  async function refreshProjects() {
    if (!token || !organizationId) return;
    const result = await apiRequest<{ data: Project[] }>(
      '/organizations/' + organizationId + '/projects',
      { token },
    );
    setProjects(result.data);
    return result.data;
  }

  async function refreshEnvironmentResources() {
    if (!token || !organizationId || !projectId || !environmentId) return;
    const base =
      '/organizations/' +
      organizationId +
      '/projects/' +
      projectId +
      '/environments/' +
      environmentId;
    const [endpointResult, keyResult] = await Promise.all([
      apiRequest<{ data: Endpoint[] }>(base + '/endpoints', { token }),
      apiRequest<{ data: ApiKey[] }>(base + '/api-keys', { token }),
    ]);
    setEndpoints(endpointResult.data);
    setApiKeys(keyResult.data);
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      ...(authMode === 'register' ? { name: String(form.get('name') ?? '') } : {}),
    };
    await withBusy(async () => {
      const path = authMode === 'register' ? '/auth/register' : '/auth/login';
      const result = await apiRequest<{ token: string; user: User }>(path, {
        method: 'POST',
        body,
      });
      saveToken(result.token);
      setToken(result.token);
      setUser(result.user);
      await loadOrganizations(result.token);
      setNotice(authMode === 'register' ? 'Your workspace is ready.' : 'Welcome back.');
    });
  }

  function signOut() {
    saveToken(null);
    setToken(null);
    setUser(null);
    setOrganizations([]);
    setOrganizationId('');
    setProjects([]);
    setDeliveries([]);
    setNewApiKeySecret('');
    setNewSigningSecret('');
    setIngestionKey('');
    setNotice('');
    setError('');
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !organizationId) return;
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
    await withBusy(async () => {
      const result = await apiRequest<{ project: Project }>(
        '/organizations/' + organizationId + '/projects',
        { token, method: 'POST', body: { name } },
      );
      await refreshProjects();
      setProjectId(result.project.id);
      setView('destinations');
      setNotice('Project created. Add an environment to continue.');
    });
  }

  async function renameProject(project: Project) {
    if (!token || !organizationId) return;
    const name = window.prompt('Rename project', project.name)?.trim();
    if (!name) return;
    await withBusy(async () => {
      await apiRequest('/organizations/' + organizationId + '/projects/' + project.id, {
        token,
        method: 'PATCH',
        body: { name },
      });
      await refreshProjects();
      setNotice('Project renamed.');
    });
  }

  async function deleteProject(project: Project) {
    if (
      !token ||
      !organizationId ||
      !window.confirm('Delete project ' + project.name + ' and its resources?')
    )
      return;
    await withBusy(async () => {
      await apiRequest('/organizations/' + organizationId + '/projects/' + project.id, {
        token,
        method: 'DELETE',
      });
      if (projectId === project.id) setProjectId('');
      await refreshProjects();
      setNotice('Project deleted.');
    });
  }

  async function createEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !organizationId || !projectId) return;
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
    await withBusy(async () => {
      const result = await apiRequest<{ environment: Environment }>(
        '/organizations/' + organizationId + '/projects/' + projectId + '/environments',
        { token, method: 'POST', body: { name } },
      );
      setEnvironments((current) => [...current, result.environment]);
      setEnvironmentId(result.environment.id);
      setNotice('Environment created.');
    });
  }

  async function createEndpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !organizationId || !projectId || !environmentId) return;
    const form = new FormData(event.currentTarget);
    const eventTypes = String(form.get('eventTypes') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const body = {
      url: String(form.get('url') ?? ''),
      description: String(form.get('description') ?? ''),
      eventTypes,
    };
    await withBusy(async () => {
      const result = await apiRequest<{ endpoint: Endpoint & { signingSecret: string } }>(
        '/organizations/' +
          organizationId +
          '/projects/' +
          projectId +
          '/environments/' +
          environmentId +
          '/endpoints',
        { token, method: 'POST', body },
      );
      setNewSigningSecret(result.endpoint.signingSecret);
      await refreshEnvironmentResources();
      setNotice('Webhook endpoint created. Copy its signing secret now.');
    });
  }

  async function createApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !organizationId || !projectId || !environmentId) return;
    const label = String(new FormData(event.currentTarget).get('label') ?? '');
    await withBusy(async () => {
      const result = await apiRequest<{ apiKey: ApiKey & { secret: string } }>(
        '/organizations/' +
          organizationId +
          '/projects/' +
          projectId +
          '/environments/' +
          environmentId +
          '/api-keys',
        { token, method: 'POST', body: { label } },
      );
      setNewApiKeySecret(result.apiKey.secret);
      setIngestionKey(result.apiKey.secret);
      await refreshEnvironmentResources();
      setNotice('Copy your new API key now. The secret is only shown once.');
    });
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
    await withBusy(async () => {
      const result = await apiRequest<{ organization: Organization }>('/organizations', {
        token,
        method: 'POST',
        body: { name },
      });
      await loadOrganizations(token);
      setOrganizationId(result.organization.id);
      setShowNewOrganization(false);
      setNotice('Workspace created.');
    });
  }

  async function updateEndpoint(endpoint: Endpoint, active: boolean) {
    if (!token || !organizationId || !projectId || !environmentId) return;
    const path =
      '/organizations/' +
      organizationId +
      '/projects/' +
      projectId +
      '/environments/' +
      environmentId +
      '/endpoints/' +
      endpoint.id;
    await withBusy(async () => {
      await apiRequest(path, { token, method: 'PATCH', body: { active } });
      await refreshEnvironmentResources();
      setNotice(active ? 'Endpoint enabled.' : 'Endpoint paused.');
    });
  }

  async function updateSubscriptions(event: FormEvent<HTMLFormElement>, endpoint: Endpoint) {
    event.preventDefault();
    if (!token || !organizationId || !projectId || !environmentId) return;
    const eventTypes = String(new FormData(event.currentTarget).get('eventTypes') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const path =
      '/organizations/' +
      organizationId +
      '/projects/' +
      projectId +
      '/environments/' +
      environmentId +
      '/endpoints/' +
      endpoint.id +
      '/subscriptions';
    await withBusy(async () => {
      await apiRequest(path, { token, method: 'PUT', body: { eventTypes } });
      await refreshEnvironmentResources();
      setNotice('Endpoint subscriptions updated.');
    });
  }

  async function deleteEndpoint(endpoint: Endpoint) {
    if (
      !token ||
      !organizationId ||
      !projectId ||
      !environmentId ||
      !window.confirm('Delete this webhook endpoint?')
    )
      return;
    const path =
      '/organizations/' +
      organizationId +
      '/projects/' +
      projectId +
      '/environments/' +
      environmentId +
      '/endpoints/' +
      endpoint.id;
    await withBusy(async () => {
      await apiRequest(path, { token, method: 'DELETE' });
      await refreshEnvironmentResources();
      setNotice('Endpoint deleted.');
    });
  }

  async function revokeKey(key: ApiKey) {
    if (
      !token ||
      !organizationId ||
      !projectId ||
      !environmentId ||
      !window.confirm('Revoke this API key?')
    )
      return;
    const path =
      '/organizations/' +
      organizationId +
      '/projects/' +
      projectId +
      '/environments/' +
      environmentId +
      '/api-keys/' +
      key.id;
    await withBusy(async () => {
      await apiRequest(path, { token, method: 'DELETE' });
      await refreshEnvironmentResources();
      setNotice('API key revoked.');
    });
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !organizationId) return;
    const form = new FormData(event.currentTarget);
    const body = {
      email: String(form.get('email') ?? ''),
      role: String(form.get('role') ?? 'viewer'),
    };
    await withBusy(async () => {
      await apiRequest('/organizations/' + organizationId + '/members', {
        token,
        method: 'POST',
        body,
      });
      const result = await apiRequest<{ data: Member[] }>(
        '/organizations/' + organizationId + '/members',
        { token },
      );
      setMembers(result.data);
      setNotice('Workspace member added.');
    });
  }

  async function updateMemberRole(member: Member, role: Role) {
    if (!token || !organizationId) return;
    await withBusy(async () => {
      await apiRequest('/organizations/' + organizationId + '/members/' + member.id, {
        token,
        method: 'PATCH',
        body: { role },
      });
      setMembers((current) =>
        current.map((item) => (item.id === member.id ? { ...item, role } : item)),
      );
      setNotice('Member role updated.');
    });
  }

  async function removeMember(member: Member) {
    if (
      !token ||
      !organizationId ||
      !window.confirm('Remove ' + member.name + ' from this workspace?')
    )
      return;
    await withBusy(async () => {
      await apiRequest('/organizations/' + organizationId + '/members/' + member.id, {
        token,
        method: 'DELETE',
      });
      setMembers((current) => current.filter((item) => item.id !== member.id));
      setNotice('Member removed from the workspace.');
    });
  }

  async function sendEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ingestionKey) {
      setError('Create an API key or paste an existing environment key first.');
      return;
    }
    const form = new FormData(event.currentTarget);
    let payload: unknown;
    let metadata: unknown;
    try {
      payload = JSON.parse(String(form.get('payload') ?? '{}'));
      metadata = JSON.parse(String(form.get('metadata') ?? '{}'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Payload must be a JSON object.');
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error('Metadata must be a JSON object.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enter valid JSON.');
      return;
    }
    await withBusy(async () => {
      const result = await apiRequest<{ event: { id: string; type: string } }>('/events', {
        apiKey: ingestionKey,
        method: 'POST',
        idempotencyKey: crypto.randomUUID(),
        body: { eventType: String(form.get('eventType') ?? ''), payload, metadata },
      });
      await refreshDeliveries();
      setNotice(
        'Event accepted: ' + shortId(result.event.id) + '. Delivery may take a moment to appear.',
      );
      setView('deliveries');
    });
  }

  async function showAttempts(delivery: Delivery) {
    if (!token || !organizationId) return;
    setSelectedDelivery(delivery.id);
    setAttempts([]);
    const result = await withBusy(() =>
      apiRequest<{ data: Attempt[] }>(
        '/organizations/' + organizationId + '/deliveries/' + delivery.id + '/attempts',
        { token },
      ),
    );
    if (result) setAttempts(result.data);
  }

  async function replayDelivery(delivery: Delivery) {
    if (!token || !organizationId) return;
    await withBusy(async () => {
      await apiRequest(
        '/organizations/' + organizationId + '/deliveries/' + delivery.id + '/replay',
        { token, method: 'POST' },
      );
      await refreshDeliveries();
      setNotice('Replay queued for the delivery worker.');
    });
  }

  const activeDeliveries = deliveries.filter((item) =>
    ['pending', 'processing', 'retrying'].includes(item.state),
  ).length;
  const failedDeliveries = deliveries.filter((item) =>
    ['failed', 'dead_lettered'].includes(item.state),
  ).length;
  const activeEndpointCount = useMemo(
    () => endpoints.filter((item) => item.active).length,
    [endpoints],
  );

  if (loading)
    return (
      <div className="boot-screen">
        <span className="brand-mark">ER</span>
        <span>Loading your workspace…</span>
      </div>
    );
  if (!token || !user)
    return (
      <AuthScreen
        mode={authMode}
        busy={busy}
        error={error}
        onModeChange={(mode) => {
          setAuthMode(mode);
          setError('');
        }}
        onSubmit={submitAuth}
      />
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setView('overview')}>
          <span className="brand-mark">ER</span>
          <span>
            eventrelay<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-picker">
          <span className="eyebrow">WORKSPACE</span>
          <select
            aria-label="Choose workspace"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
          >
            {organizations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button className="text-button" onClick={() => setShowNewOrganization(true)}>
            ＋ New workspace
          </button>
        </div>
        <span className="eyebrow nav-heading">OPERATIONS</span>
        <nav className="main-nav" aria-label="Main navigation">
          <NavButton active={view === 'overview'} icon="◫" onClick={() => setView('overview')}>
            Overview
          </NavButton>
          <NavButton
            active={view === 'destinations'}
            icon="⌘"
            onClick={() => setView('destinations')}
          >
            Projects & endpoints
          </NavButton>
          <NavButton active={view === 'members'} icon="M" onClick={() => setView('members')}>
            Members
          </NavButton>
          <NavButton active={view === 'deliveries'} icon="⇄" onClick={() => setView('deliveries')}>
            Deliveries <span className="nav-count">{deliveries.length}</span>
          </NavButton>
          {canAdmin && (
            <NavButton active={view === 'audit'} icon="◷" onClick={() => setView('audit')}>
              Audit history
            </NavButton>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="service-state">
            <span className="status-dot" />
            API workspace connected
          </div>
          <div className="profile-row">
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy">
              <strong>{user.name}</strong>
              <small>{activeOrganization?.role ?? 'member'}</small>
            </span>
            <button
              className="icon-button"
              title="Sign out"
              aria-label="Sign out"
              onClick={signOut}
            >
              ↗
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>EventRelay</span>
            <span className="crumb-divider">/</span>
            <strong>{activeOrganization?.name ?? 'Workspace'}</strong>
          </div>
          <div className="topbar-right">
            <span className="role-chip">{activeOrganization?.role ?? 'member'}</span>
            <span className="avatar avatar-small">{user.name.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <div className="page-wrap">
          {(error || notice) && (
            <div className={'flash ' + (error ? 'flash-error' : 'flash-success')} role="status">
              <span>{error || notice}</span>
              <button
                aria-label="Dismiss"
                onClick={() => {
                  setError('');
                  setNotice('');
                }}
              >
                ×
              </button>
            </div>
          )}
          {busy && <div className="busy-line" />}

          {view === 'overview' && (
            <>
              <PageHeading
                eyebrow="WORKSPACE OVERVIEW"
                title="Good operations start here."
                subtitle="Keep an eye on event delivery and manage destinations connected to this workspace."
              >
                <button className="button button-primary" onClick={() => setView('destinations')}>
                  ＋ Add endpoint
                </button>
              </PageHeading>
              <div className="summary-grid">
                <Metric
                  label="Total deliveries"
                  value={deliveries.length}
                  detail="Most recent 100"
                  icon="⇄"
                />
                <Metric
                  label="In progress"
                  value={activeDeliveries}
                  detail="Waiting or retrying"
                  icon="◷"
                  tone="blue"
                />
                <Metric
                  label="Needs attention"
                  value={failedDeliveries}
                  detail="Failed or dead-lettered"
                  icon="!"
                  tone="orange"
                />
                <Metric
                  label="Active endpoints"
                  value={activeEndpointCount}
                  detail="Selected environment"
                  icon="⌁"
                  tone="green"
                />
              </div>
              <div className="overview-grid">
                <section className="panel delivery-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">DELIVERY FEED</span>
                      <h2>Recent activity</h2>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => void withBusy(refreshDeliveries)}
                    >
                      Refresh ↻
                    </button>
                  </div>
                  {deliveries.length ? (
                    <DeliveryTable
                      deliveries={deliveries.slice(0, 6)}
                      onSelect={(item) => {
                        void showAttempts(item);
                        setView('deliveries');
                      }}
                    />
                  ) : (
                    <EmptyState
                      title="No deliveries yet"
                      text="Create an endpoint, then send a test event to see delivery status here."
                    />
                  )}
                </section>
                <section className="panel setup-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">GETTING STARTED</span>
                      <h2>Connect a destination</h2>
                    </div>
                    <span className="setup-icon">↗</span>
                  </div>
                  <p className="muted">
                    Register a webhook, send an event, and inspect every delivery attempt here.
                  </p>
                  <div className="setup-steps">
                    <SetupStep
                      number="01"
                      done={projects.length > 0}
                      title="Create a project"
                      text="Group event sources."
                    />
                    <SetupStep
                      number="02"
                      done={environments.length > 0}
                      title="Add an environment"
                      text="Separate test and live traffic."
                    />
                    <SetupStep
                      number="03"
                      done={endpoints.length > 0}
                      title="Register an endpoint"
                      text="Choose a URL and event types."
                    />
                    <SetupStep
                      number="04"
                      done={deliveries.length > 0}
                      title="Send an event"
                      text="Watch delivery and retries."
                    />
                  </div>
                  <button
                    className="button button-secondary full-width"
                    onClick={() => setView('destinations')}
                  >
                    Manage destinations <span>→</span>
                  </button>
                </section>
              </div>
              <section className="panel resource-strip">
                <div>
                  <span className="eyebrow">CURRENT SCOPE</span>
                  <h2>{activeProject?.name ?? 'No project selected'}</h2>
                  <p className="muted">
                    {activeEnvironment?.name ??
                      'Create a project and environment to manage keys and endpoints.'}
                  </p>
                </div>
                <div className="scope-selects">
                  <label>
                    Project
                    <select
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                    >
                      <option value="">Choose project</option>
                      {projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Environment
                    <select
                      value={environmentId}
                      onChange={(event) => setEnvironmentId(event.target.value)}
                      disabled={!environments.length}
                    >
                      <option value="">Choose environment</option>
                      {environments.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
            </>
          )}

          {view === 'destinations' && (
            <>
              <PageHeading
                eyebrow="PROJECT SETUP"
                title="Projects & endpoints"
                subtitle="Manage environments, delivery destinations, and application keys."
              >
                <span className="scope-label">{activeOrganization?.name}</span>
              </PageHeading>
              <div className="resource-toolbar panel">
                <label>
                  Project
                  <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                    <option value="">Choose project</option>
                    {projects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Environment
                  <select
                    value={environmentId}
                    onChange={(event) => setEnvironmentId(event.target.value)}
                    disabled={!environments.length}
                  >
                    <option value="">Choose environment</option>
                    {environments.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="toolbar-spacer" />
                <span className="role-chip">{activeOrganization?.role}</span>
              </div>
              <div className="resource-grid">
                <section className="panel form-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">PROJECT</span>
                      <h2>
                        {projects.length} project{projects.length === 1 ? '' : 's'}
                      </h2>
                    </div>
                    <span className="panel-icon">⌘</span>
                  </div>
                  {canWrite ? (
                    <form onSubmit={createProject} className="inline-form">
                      <label>
                        Project name
                        <input
                          name="name"
                          placeholder="Payments service"
                          required
                          maxLength={100}
                        />
                      </label>
                      <button className="button button-secondary" disabled={busy}>
                        Create
                      </button>
                    </form>
                  ) : (
                    <p className="muted">You have view-only access.</p>
                  )}
                  <div className="resource-list">
                    {projects.map((item) => (
                      <button
                        className={
                          'resource-row ' + (item.id === projectId ? 'resource-row-active' : '')
                        }
                        key={item.id}
                        onClick={() => setProjectId(item.id)}
                      >
                        <span className="list-glyph">P</span>
                        <span className="resource-name">
                          <strong>{item.name}</strong>
                          <small>{item.slug}</small>
                        </span>
                        <span className="row-arrow">→</span>
                      </button>
                    ))}
                    {!projects.length && (
                      <EmptyState
                        title="No projects"
                        text="Create a project to start organizing environments."
                      />
                    )}
                  </div>
                  {activeProject && canWrite && (
                    <div className="project-controls">
                      <span>Selected: {activeProject.name}</span>
                      <button
                        className="text-button"
                        onClick={() => void renameProject(activeProject)}
                      >
                        Rename
                      </button>
                      <button
                        className="text-button danger-text"
                        onClick={() => void deleteProject(activeProject)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </section>
                <section className="panel form-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">ENVIRONMENTS</span>
                      <h2>
                        {environments.length} environment{environments.length === 1 ? '' : 's'}
                      </h2>
                    </div>
                    <span className="panel-icon">◈</span>
                  </div>
                  {projectId && canWrite ? (
                    <form onSubmit={createEnvironment} className="inline-form">
                      <label>
                        Environment name
                        <input name="name" placeholder="Production" required maxLength={40} />
                      </label>
                      <button className="button button-secondary" disabled={busy}>
                        Add
                      </button>
                    </form>
                  ) : (
                    <p className="muted">Choose a project to create an environment.</p>
                  )}
                  <div className="resource-list">
                    {environments.map((item) => (
                      <button
                        className={
                          'resource-row ' + (item.id === environmentId ? 'resource-row-active' : '')
                        }
                        key={item.id}
                        onClick={() => setEnvironmentId(item.id)}
                      >
                        <span className="list-glyph list-glyph-blue">E</span>
                        <span className="resource-name">
                          <strong>{item.name}</strong>
                          <small>{item.slug}</small>
                        </span>
                        <span className="row-arrow">→</span>
                      </button>
                    ))}
                    {projectId && !environments.length && (
                      <EmptyState
                        title="No environments"
                        text="Create a test or production environment."
                      />
                    )}
                  </div>
                </section>
              </div>
              <div className="resource-grid resource-grid-wide">
                <section className="panel form-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">WEBHOOK DESTINATIONS</span>
                      <h2>Endpoints</h2>
                    </div>
                    <span className="panel-icon">⌁</span>
                  </div>
                  {environmentId && canWrite ? (
                    <form onSubmit={createEndpoint} className="stack-form">
                      <div className="form-row">
                        <label>
                          Endpoint URL
                          <input
                            name="url"
                            type="url"
                            placeholder="https://api.example.com/webhooks"
                            required
                            maxLength={2048}
                          />
                        </label>
                        <label>
                          Description
                          <input
                            name="description"
                            placeholder="Payments event receiver"
                            maxLength={500}
                          />
                        </label>
                      </div>
                      <div className="form-row">
                        <label>
                          Subscribed event types
                          <input
                            name="eventTypes"
                            placeholder="invoice.paid, customer.created"
                            required
                          />
                        </label>
                        <button className="button button-primary form-action" disabled={busy}>
                          ＋ Add endpoint
                        </button>
                      </div>
                      <small className="helper-text">
                        Separate event types with commas. Public HTTPS destinations are recommended.
                      </small>
                    </form>
                  ) : (
                    <p className="muted">Select an environment to configure endpoints.</p>
                  )}
                  {newSigningSecret && (
                    <div className="secret-panel">
                      <div>
                        <strong>Copy your webhook signing secret</strong>
                        <p>Store this in your receiver. It is only shown once.</p>
                      </div>
                      <code>{newSigningSecret}</code>
                      <button
                        className="button button-secondary"
                        onClick={() =>
                          void navigator.clipboard
                            ?.writeText(newSigningSecret)
                            .then(() => setNotice('Signing secret copied.'))
                        }
                      >
                        Copy signing secret
                      </button>
                    </div>
                  )}
                  {newSigningSecret && (
                    <div className="secret-panel">
                      <div>
                        <strong>Copy your webhook signing secret</strong>
                        <p>Store this in your receiver. It is only shown once.</p>
                      </div>
                      <code>{newSigningSecret}</code>
                      <button
                        className="button button-secondary"
                        onClick={() =>
                          void navigator.clipboard
                            ?.writeText(newSigningSecret)
                            .then(() => setNotice('Signing secret copied.'))
                        }
                      >
                        Copy signing secret
                      </button>
                    </div>
                  )}
                  <div className="endpoint-list">
                    {endpoints.map((item) => (
                      <div className="endpoint-card" key={item.id}>
                        <div className="endpoint-main">
                          <span
                            className={
                              'state-dot ' + (item.active ? 'state-dot-green' : 'state-dot-muted')
                            }
                          />
                          <div className="endpoint-copy">
                            <strong>{item.url}</strong>
                            <span>
                              {item.description || 'No description'} · {item.event_types.join(', ')}
                            </span>
                          </div>
                        </div>
                        {canWrite && (
                          <form
                            className="subscription-edit"
                            onSubmit={(event) => void updateSubscriptions(event, item)}
                          >
                            <label>
                              Event types
                              <input
                                name="eventTypes"
                                defaultValue={item.event_types.join(', ')}
                                required
                              />
                            </label>
                            <button className="text-button">Save</button>
                          </form>
                        )}
                        {canWrite && (
                          <div className="endpoint-actions">
                            <button
                              className="text-button"
                              onClick={() => void updateEndpoint(item, !item.active)}
                            >
                              {item.active ? 'Pause' : 'Enable'}
                            </button>
                            <button
                              className="text-button danger-text"
                              onClick={() => void deleteEndpoint(item)}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    {environmentId && !endpoints.length && (
                      <EmptyState
                        title="No endpoints yet"
                        text="Add a destination URL and event types above."
                      />
                    )}
                  </div>
                </section>
                <section className="panel form-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">INGESTION CREDENTIALS</span>
                      <h2>API keys</h2>
                    </div>
                    <span className="panel-icon">⌘</span>
                  </div>
                  {environmentId && canWrite && (
                    <form onSubmit={createApiKey} className="inline-form">
                      <label>
                        Key label
                        <input name="label" placeholder="Production app" required maxLength={100} />
                      </label>
                      <button className="button button-secondary" disabled={busy}>
                        Create key
                      </button>
                    </form>
                  )}
                  {newApiKeySecret && (
                    <div className="secret-panel">
                      <div>
                        <strong>Copy your new key</strong>
                        <p>This secret is only shown once and clears when you sign out.</p>
                      </div>
                      <code>{newApiKeySecret}</code>
                      <button
                        className="button button-secondary"
                        onClick={() =>
                          void navigator.clipboard
                            ?.writeText(newApiKeySecret)
                            .then(() => setNotice('API key copied.'))
                        }
                      >
                        Copy key
                      </button>
                    </div>
                  )}
                  <div className="key-list">
                    {apiKeys.map((item) => (
                      <div className="key-row" key={item.id}>
                        <span className="key-icon">⌑</span>
                        <span className="resource-name">
                          <strong>{item.label}</strong>
                          <small>
                            {item.prefix}•••• ·{' '}
                            {item.revoked_at
                              ? 'Revoked'
                              : 'Last used ' + dateTime(item.last_used_at)}
                          </small>
                        </span>
                        {!item.revoked_at && canWrite && (
                          <button
                            className="text-button danger-text"
                            onClick={() => void revokeKey(item)}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                    {environmentId && !apiKeys.length && (
                      <EmptyState
                        title="No API keys"
                        text="Create a key to send events into this environment."
                      />
                    )}
                  </div>
                </section>
              </div>
              <section className="panel event-composer">
                <div className="panel-heading">
                  <div>
                    <span className="eyebrow">TRY YOUR PIPELINE</span>
                    <h2>Send a test event</h2>
                  </div>
                  <span className="panel-icon">↗</span>
                </div>
                <p className="muted">
                  Matching active endpoints receive the signed event. Delivery attempts appear in
                  history.
                </p>
                <form onSubmit={sendEvent} className="event-form">
                  <label>
                    Environment API key
                    <input
                      type="password"
                      autoComplete="off"
                      value={ingestionKey}
                      onChange={(event) => setIngestionKey(event.target.value)}
                      placeholder="Paste an existing key or create one above"
                    />
                  </label>
                  <div className="form-row">
                    <label>
                      Event type
                      <input name="eventType" placeholder="invoice.paid" required maxLength={100} />
                    </label>
                    <label>
                      Payload JSON
                      <textarea
                        name="payload"
                        defaultValue={'{\n  "invoiceId": "inv_123",\n  "amount": 4200\n}'}
                        rows={5}
                        required
                      />
                    </label>
                  </div>
                  <label>
                    Metadata JSON
                    <textarea name="metadata" defaultValue="{}" rows={2} />
                  </label>
                  <button className="button button-primary" disabled={busy || !environmentId}>
                    Send event <span>→</span>
                  </button>
                </form>
              </section>
            </>
          )}
          {view === 'members' && (
            <>
              <PageHeading
                eyebrow="WORKSPACE ACCESS"
                title="Members"
                subtitle="Manage who can access this workspace and what they can change."
              >
                <span className="scope-label">{members.length} members</span>
              </PageHeading>
              {canAdmin && (
                <section className="panel member-invite">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">ADD AN EXISTING ACCOUNT</span>
                      <h2>Grant workspace access</h2>
                    </div>
                  </div>
                  <form className="inline-form" onSubmit={addMember}>
                    <label>
                      Email
                      <input
                        name="email"
                        type="email"
                        placeholder="teammate@company.com"
                        required
                        maxLength={254}
                      />
                    </label>
                    <label>
                      Role
                      <select name="role">
                        <option value="developer">Developer</option>
                        <option value="viewer">Viewer</option>
                        <option value="admin" disabled={activeOrganization?.role !== 'owner'}>
                          Admin
                        </option>
                      </select>
                    </label>
                    <button className="button button-primary" disabled={busy}>
                      Add member
                    </button>
                  </form>
                  <p className="helper-text">
                    The person must already have an EventRelay account. Owners can grant admin
                    access.
                  </p>
                </section>
              )}
              <section className="panel member-panel">
                <div className="member-list">
                  {members.map((member) => (
                    <div className="member-row" key={member.id}>
                      <span className="avatar">{member.name.slice(0, 1).toUpperCase()}</span>
                      <div className="member-copy">
                        <strong>{member.name}</strong>
                        <small>
                          {member.email} · joined {dateTime(member.joined_at)}
                        </small>
                      </div>
                      {canAdmin &&
                      member.role !== 'owner' &&
                      (activeOrganization?.role === 'owner' || member.role !== 'admin') ? (
                        <>
                          <select
                            aria-label={'Role for ' + member.name}
                            value={member.role}
                            onChange={(event) =>
                              void updateMemberRole(member, event.target.value as Role)
                            }
                          >
                            <option value="admin" disabled={activeOrganization?.role !== 'owner'}>
                              Admin
                            </option>
                            <option value="developer">Developer</option>
                            <option value="viewer">Viewer</option>
                          </select>
                          <button
                            className="text-button danger-text"
                            onClick={() => void removeMember(member)}
                          >
                            Remove
                          </button>
                        </>
                      ) : (
                        <span className="role-chip">{member.role}</span>
                      )}
                    </div>
                  ))}
                  {!members.length && (
                    <EmptyState
                      title="No workspace members"
                      text="Add an existing account to collaborate."
                    />
                  )}
                </div>
              </section>
            </>
          )}

          {view === 'deliveries' && (
            <>
              <PageHeading
                eyebrow="DELIVERY OPERATIONS"
                title="Delivery history"
                subtitle="Inspect attempts, response details, retries, and dead-lettered deliveries."
              >
                <button
                  className="button button-secondary"
                  onClick={() => void withBusy(refreshDeliveries)}
                >
                  Refresh ↻
                </button>
              </PageHeading>
              <section className="panel table-panel">
                <div className="table-summary">
                  <span>{deliveries.length} recent deliveries</span>
                  <span className="summary-spacer" />
                  <select
                    aria-label="Filter deliveries"
                    onChange={(event) => {
                      if (event.target.value === 'all') void withBusy(refreshDeliveries);
                      else if (token && organizationId)
                        void apiRequest<{ data: Delivery[] }>(
                          '/organizations/' +
                            organizationId +
                            '/deliveries?state=' +
                            event.target.value +
                            '&limit=100',
                          { token },
                        )
                          .then((result) => setDeliveries(result.data))
                          .catch((caught) =>
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : 'Could not filter deliveries.',
                            ),
                          );
                    }}
                  >
                    <option value="all">All states</option>
                    <option value="pending">Pending</option>
                    <option value="processing">Processing</option>
                    <option value="retrying">Retrying</option>
                    <option value="succeeded">Succeeded</option>
                    <option value="failed">Failed</option>
                    <option value="dead_lettered">Dead-lettered</option>
                  </select>
                </div>
                {deliveries.length ? (
                  <DeliveryTable
                    deliveries={deliveries}
                    onSelect={(item) => void showAttempts(item)}
                  />
                ) : (
                  <EmptyState
                    title="No deliveries found"
                    text="Send an event to an active subscription to create a delivery."
                  />
                )}
              </section>
              {selectedDelivery && (
                <section className="panel attempts-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">DELIVERY {shortId(selectedDelivery)}</span>
                      <h2>Attempt history</h2>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => {
                        setSelectedDelivery('');
                        setAttempts([]);
                      }}
                      aria-label="Close attempts"
                    >
                      ×
                    </button>
                  </div>
                  {attempts.length ? (
                    <div className="attempt-list">
                      {attempts.map((item) => (
                        <div className="attempt-card" key={item.id}>
                          <div className="attempt-top">
                            <strong>Attempt {item.attempt_number}</strong>
                            <span>{dateTime(item.started_at)}</span>
                            <span className="status-pill">
                              {item.response_status ?? 'Network error'}
                            </span>
                          </div>
                          <p>
                            {item.error ||
                              (item.response_status
                                ? 'HTTP ' + item.response_status + ' response'
                                : 'No response received')}
                          </p>
                          {item.duration_ms !== null && <small>{item.duration_ms} ms</small>}
                          {item.response_body && <pre>{item.response_body}</pre>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No attempts have been recorded yet.</p>
                  )}
                  {deliveries.find(
                    (item) =>
                      item.id === selectedDelivery &&
                      ['failed', 'dead_lettered'].includes(item.state),
                  ) &&
                    canWrite && (
                      <button
                        className="button button-primary"
                        onClick={() => {
                          const item = deliveries.find((entry) => entry.id === selectedDelivery);
                          if (item && window.confirm('Queue a replay for this delivery?'))
                            void replayDelivery(item);
                        }}
                      >
                        Replay delivery <span>→</span>
                      </button>
                    )}
                </section>
              )}
              <div className="delivery-note">
                <span>ⓘ</span> Delivery is at-least-once. Receivers should use the event ID to
                handle duplicate attempts safely.
              </div>
            </>
          )}

          {view === 'audit' && canAdmin && (
            <>
              <PageHeading
                eyebrow="SECURITY & ACCOUNTABILITY"
                title="Audit history"
                subtitle="Recent workspace changes and the resources they affected."
              >
                <button
                  className="button button-secondary"
                  onClick={() =>
                    void apiRequest<{ data: AuditEntry[] }>(
                      '/organizations/' + organizationId + '/audit?limit=100',
                      { token },
                    )
                      .then((result) => setAudit(result.data))
                      .catch((caught) =>
                        setError(
                          caught instanceof Error
                            ? caught.message
                            : 'Could not refresh audit history.',
                        ),
                      )
                  }
                >
                  Refresh ↻
                </button>
              </PageHeading>
              <section className="panel table-panel">
                <div className="audit-list">
                  {audit.map((item) => (
                    <div className="audit-row" key={item.id}>
                      <span className="audit-icon">◷</span>
                      <div className="audit-copy">
                        <strong>{item.action.replace(':', ' ')}</strong>
                        <span>
                          {item.actor_name || item.actor_email || 'System'} · {item.resource_type}
                          {item.resource_id ? ' · ' + shortId(item.resource_id) : ''}
                        </span>
                      </div>
                      <time>{dateTime(item.created_at)}</time>
                    </div>
                  ))}
                  {!audit.length && (
                    <EmptyState
                      title="No audit entries"
                      text="Successful workspace changes will appear here."
                    />
                  )}
                </div>
              </section>
            </>
          )}
        </div>
      </main>
      {showNewOrganization && (
        <Modal title="Create a workspace" onClose={() => setShowNewOrganization(false)}>
          <form onSubmit={createOrganization} className="stack-form">
            <label>
              Workspace name
              <input
                name="name"
                placeholder="Acme Engineering"
                required
                minLength={2}
                maxLength={100}
              />
            </label>
            <button className="button button-primary" disabled={busy}>
              Create workspace
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function AuthScreen({
  mode,
  busy,
  error,
  onModeChange,
  onSubmit,
}: {
  mode: 'login' | 'register';
  busy: boolean;
  error: string;
  onModeChange: (mode: 'login' | 'register') => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="auth-shell">
      <div className="auth-decoration">
        <span className="auth-orbit orbit-one" />
        <span className="auth-orbit orbit-two" />
        <div className="auth-brand">
          <span className="brand-mark">ER</span>
          <strong>
            eventrelay<span className="brand-dot">.</span>
          </strong>
        </div>
        <div className="auth-message">
          <span className="eyebrow">EVENT DELIVERY, UNDER CONTROL</span>
          <h1>
            Events in.
            <br />
            Confidence out.
          </h1>
          <p>Connect applications, inspect delivery attempts, and keep customer webhooks moving.</p>
          <div className="auth-footnote">
            <span className="status-dot" /> Reliable event infrastructure for your team
          </div>
        </div>
      </div>
      <main className="auth-card-wrap">
        <div className="auth-card">
          <span className="eyebrow">{mode === 'register' ? 'GET STARTED' : 'WELCOME BACK'}</span>
          <h2>{mode === 'register' ? 'Create your workspace' : 'Sign in to EventRelay'}</h2>
          <p className="muted">
            {mode === 'register'
              ? 'Set up a workspace to manage webhook delivery.'
              : 'Open your delivery workspace and pick up where you left off.'}
          </p>
          <form className="auth-form" onSubmit={onSubmit}>
            {mode === 'register' && (
              <label>
                Full name
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="Your name"
                  required
                  maxLength={100}
                />
              </label>
            )}
            <label>
              Work email
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                placeholder={mode === 'register' ? 'At least 12 characters' : 'Your password'}
                minLength={mode === 'register' ? 12 : 1}
                maxLength={72}
                required
              />
            </label>
            {error && (
              <div className="flash flash-error" role="alert">
                {error}
              </div>
            )}
            <button className="button button-primary auth-submit" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}{' '}
              <span>→</span>
            </button>
          </form>
          <div className="auth-switch">
            {mode === 'register' ? 'Already have an account?' : 'New to EventRelay?'}{' '}
            <button
              className="text-button"
              onClick={() => onModeChange(mode === 'register' ? 'login' : 'register')}
            >
              {mode === 'register' ? 'Sign in' : 'Create an account'}
            </button>
          </div>
          <div className="auth-security">
            Session-scoped sign in · Workspace access is role-scoped
          </div>
        </div>
      </main>
    </div>
  );
}

function NavButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={'nav-button ' + (active ? 'nav-button-active' : '')} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

function PageHeading({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children && <div className="heading-action">{children}</div>}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  tone = '',
}: {
  label: string;
  value: number;
  detail: string;
  icon: string;
  tone?: string;
}) {
  return (
    <section className="metric-card">
      <div className={'metric-icon ' + tone}>{icon}</div>
      <div className="metric-label">{label}</div>
      <strong className="metric-value">{value}</strong>
      <div className="metric-detail">{detail}</div>
    </section>
  );
}

function DeliveryTable({
  deliveries,
  onSelect,
}: {
  deliveries: Delivery[];
  onSelect: (delivery: Delivery) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Destination</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {deliveries.map((item) => (
            <tr
              key={item.id}
              onClick={() => onSelect(item)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSelect(item);
              }}
            >
              <td>
                <strong>{item.event_type}</strong>
                <small className="table-sub">evt_{shortId(item.event_id)}</small>
              </td>
              <td className="endpoint-cell" title={item.endpoint_url}>
                {item.endpoint_url}
              </td>
              <td>
                <StatusPill state={item.state} />
              </td>
              <td>{item.attempt_count}</td>
              <td>{dateTime(item.updated_at)}</td>
              <td>
                <button
                  className="icon-button"
                  aria-label="View attempts"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(item);
                  }}
                >
                  →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ state }: { state: string }) {
  return <span className={'status-pill status-' + state}>{state.replace('_', ' ')}</span>;
}

function SetupStep({
  number,
  done,
  title,
  text,
}: {
  number: string;
  done: boolean;
  title: string;
  text: string;
}) {
  return (
    <div className="setup-step">
      <span className={'step-number ' + (done ? 'step-done' : '')}>{done ? '✓' : number}</span>
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-mark">⌁</span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-heading">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export default App;
