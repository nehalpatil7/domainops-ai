import { useCallback, useEffect, useState } from "react";
import {
  simulationProfiles,
  type DiagnosticEvent,
  type DnsAssessment,
  type Domain,
  type SimulationProfile,
} from "./domain/types";

type ApiEnvelope<T> = {
  data: T;
  meta: { workspaceId: string; simulated: boolean; requestId: string };
};

export default function App() {
  const [workspaceDraft, setWorkspaceDraft] = useState("demo-acme");
  const [workspaceId, setWorkspaceId] = useState("demo-acme");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [selected, setSelected] = useState<Domain | null>(null);
  const [assessment, setAssessment] = useState<DnsAssessment | null>(null);
  const [history, setHistory] = useState<DiagnosticEvent[]>([]);
  const [hostname, setHostname] = useState("");
  const [profile, setProfile] = useState<SimulationProfile>("pending_ssl");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await api<Domain[]>(`/api/workspaces/${workspaceId}/domains`);
    setDomains(next);
    setSelected((current) => next.find((domain) => domain.id === current?.id) ?? null);
  }, [workspaceId]);

  useEffect(() => {
    setSelected(null);
    setAssessment(null);
    setHistory([]);
    void refresh().catch((cause) => setError(errorMessage(cause)));
  }, [refresh]);

  async function inspect(domain: Domain) {
    setSelected(domain);
    setError(null);
    try {
      const [dns, events] = await Promise.all([
        api<DnsAssessment>(`/api/workspaces/${workspaceId}/domains/${domain.id}/dns`),
        api<DiagnosticEvent[]>(`/api/workspaces/${workspaceId}/domains/${domain.id}/history`),
      ]);
      setAssessment(dns);
      setHistory(events);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function register(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ domain: Domain }>(`/api/workspaces/${workspaceId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey("register") },
        body: JSON.stringify({ hostname, simulationProfile: profile }),
      });
      setHostname("");
      await refresh();
      await inspect(result.domain);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revalidate(domain: Domain) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/workspaces/${workspaceId}/domains/${domain.id}/revalidate`, {
        method: "POST",
        headers: { "Idempotency-Key": requestKey("revalidate") },
      });
      await refresh();
      window.setTimeout(() => {
        void refresh()
          .then(() => inspect(domain))
          .catch((cause) => setError(errorMessage(cause)));
      }, 1500);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Cloudflare custom-domain control plane</div>
          <h1>DomainOps AI</h1>
        </div>
        <span className="simulation-badge">Simulated provider data</span>
      </header>

      {error ? (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}

      <section className="toolbar panel">
        <label>
          Demo workspace
          <input
            value={workspaceDraft}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
          />
        </label>
        <button
          className="secondary"
          onClick={() => setWorkspaceId(workspaceDraft.trim().toLowerCase())}
        >
          Open workspace
        </button>
        <p>Each workspace maps to an isolated SQLite-backed Durable Object.</p>
      </section>

      <section className="layout">
        <div className="left-column">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <span>Onboarding</span>
                <h2>Register domain</h2>
              </div>
            </div>
            <form className="register-form" onSubmit={register}>
              <label>
                Hostname
                <input
                  required
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                  placeholder="app.customer.example"
                />
              </label>
              <label>
                Simulation profile
                <select
                  value={profile}
                  onChange={(event) => setProfile(event.target.value as SimulationProfile)}
                >
                  {simulationProfiles.map((item) => (
                    <option key={item} value={item}>
                      {label(item)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={busy}>
                Register
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <span>Inventory</span>
                <h2>{workspaceId}</h2>
              </div>
              <b>{domains.length}</b>
            </div>
            <div className="domain-list">
              {domains.map((domain) => (
                <button
                  className={`domain-card ${selected?.id === domain.id ? "selected" : ""}`}
                  key={domain.id}
                  onClick={() => void inspect(domain)}
                >
                  <div className="domain-title">
                    <strong>{domain.hostname}</strong>
                    <em className={domain.ready ? "ready" : "attention"}>
                      {domain.ready ? "Ready" : "Needs attention"}
                    </em>
                  </div>
                  <div className="statuses">
                    <Status name="DNS" value={domain.dnsStatus} />
                    <Status name="Hostname" value={domain.hostnameStatus} />
                    <Status name="SSL" value={domain.sslStatus} />
                  </div>
                  <small>
                    {label(domain.simulationProfile)} · updated {formatTime(domain.updatedAt)}
                  </small>
                </button>
              ))}
            </div>
          </section>
        </div>

        <section className="panel detail-panel">
          <div className="panel-heading">
            <div>
              <span>Domain details</span>
              <h2>{selected?.hostname ?? "Select a domain"}</h2>
            </div>
            {selected ? (
              <button
                className="primary"
                disabled={busy || Boolean(selected.activeValidationId)}
                onClick={() => void revalidate(selected)}
              >
                {selected.activeValidationId ? "Validating…" : "Revalidate"}
              </button>
            ) : null}
          </div>
          {selected && assessment ? (
            <div className="details">
              <div className="facts">
                <Fact name="Validation" value={selected.validationState} />
                <Fact name="Retries" value={String(selected.retryCount)} />
                <Fact
                  name="Last attempt"
                  value={
                    selected.lastValidationAttemptAt
                      ? formatTime(selected.lastValidationAttemptAt)
                      : "Never"
                  }
                />
                <Fact name="Source" value="Simulation" />
              </div>
              <h3>DNS configuration</h3>
              <RecordList title="Expected" records={assessment.expectedRecords} />
              <RecordList title="Observed" records={assessment.observedRecords} />
              <h3>Required validation records</h3>
              <ul className="records">
                {assessment.requiredValidationRecords.map((record) => (
                  <li key={record.purpose}>
                    <code>
                      {record.type} {record.name} → {record.value}
                    </code>
                    <span>{record.status}</span>
                  </li>
                ))}
              </ul>
              <h3>Diagnostic history</h3>
              <ol className="history">
                {history.map((item) => (
                  <li key={item.id}>
                    <b>{item.diagnosticCode}</b>
                    <p>{item.message}</p>
                    <small>
                      {item.category} · {formatTime(item.createdAt)}
                    </small>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="empty">
              Choose a domain to inspect its configuration and event history.
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function Status({ name, value }: { name: string; value: string }) {
  return (
    <div>
      <span>{name}</span>
      <b>{label(value)}</b>
    </div>
  );
}
function Fact({ name, value }: { name: string; value: string }) {
  return (
    <div>
      <span>{name}</span>
      <b>{label(value)}</b>
    </div>
  );
}
function RecordList({
  title,
  records,
}: {
  title: string;
  records: DnsAssessment["expectedRecords"];
}) {
  return (
    <div className="record-group">
      <b>{title}</b>
      <ul className="records">
        {records.length ? (
          records.map((record) => (
            <li key={`${record.type}:${record.name}:${record.value}`}>
              <code>
                {record.type} {record.name} → {record.value}
              </code>
              <span>TTL {record.ttl}</span>
            </li>
          ))
        ) : (
          <li>No record observed</li>
        )}
      </ul>
    </div>
  );
}
function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
function requestKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}
function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Request failed.";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = (await response.json()) as ApiEnvelope<T> & { error?: { message: string } };
  if (!response.ok)
    throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
  return payload.data;
}
