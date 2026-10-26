import { useEffect, useState } from "react";
import type { Domain, LiveDiagnosticRun } from "./domain/types";

type ApiEnvelope<T> = { data: T; error?: { message: string } };

export function LiveDiagnosticsPanel({
  workspaceId,
  domain,
}: {
  workspaceId: string;
  domain: Domain | null;
}) {
  const [runs, setRuns] = useState<LiveDiagnosticRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveAllowed = Boolean(domain && !isReservedDemoHostname(domain.hostname));

  useEffect(() => {
    setRuns([]);
    setError(null);
    if (!domain) return;
    void loadHistory(workspaceId, domain.id)
      .then(setRuns)
      .catch((cause) => setError(message(cause)));
  }, [domain?.id, workspaceId]);

  async function runDiagnostics() {
    if (!domain) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<{
        run: LiveDiagnosticRun | null;
        pending: boolean;
      }>(`/api/workspaces/${workspaceId}/domains/${domain.id}/live-diagnostics`, {
        method: "POST",
        headers: { "Idempotency-Key": `live:${crypto.randomUUID()}` },
      });
      if (response.run) setRuns(await loadHistory(workspaceId, domain.id));
      if (response.pending)
        setError("A live diagnostic is already in progress. Try again shortly.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const latest = runs[0];
  return (
    <section className="panel live-panel">
      <div className="panel-heading">
        <div>
          <span>Live public observations</span>
          <h2>DNS &amp; HTTPS diagnostics</h2>
        </div>
        <button
          className="primary"
          disabled={!domain || !liveAllowed || busy}
          onClick={() => void runDiagnostics()}
        >
          {busy ? "Checking…" : "Run live diagnostics"}
        </button>
      </div>
      <div className="live-notice">
        Uses Cloudflare DNS over HTTPS and a safety-limited HTTPS HEAD request. Results below are
        never simulated.
      </div>
      {!domain ? (
        <div className="empty">Select a domain to view or run public diagnostics.</div>
      ) : !liveAllowed ? (
        <div className="empty">
          Reserved <code>.example</code> demo hostnames cannot be probed. Register a public hostname
          to use live mode.
        </div>
      ) : latest ? (
        <div className="live-results">
          <div className="live-summary">
            <strong className={`live-${latest.status}`}>{latest.status}</strong>
            <span>Observed {formatTime(latest.observedAt)}</span>
            <span>Source: {latest.dnsProvider}</span>
          </div>
          <h3>Public DNS</h3>
          <div className="live-dns-grid">
            {latest.dns.map((query) => (
              <div className="live-dns-card" key={query.type}>
                <div>
                  <b>{query.type}</b>
                  <span>{query.status.replaceAll("_", " ")}</span>
                </div>
                {query.records
                  .filter((record) => record.type === query.type)
                  .map((record) => (
                    <code key={`${record.name}:${record.value}`}>{record.value}</code>
                  ))}
                {query.error ? <small>{query.error}</small> : null}
              </div>
            ))}
          </div>
          <h3>HTTPS &amp; TLS</h3>
          <div className="live-observation">
            <Fact label="Reachability" value={latest.https.status} />
            <Fact
              label="HTTP status"
              value={latest.https.statusCode?.toString() ?? "Unavailable"}
            />
            <Fact
              label="Response time"
              value={
                latest.https.responseTimeMs === null
                  ? "Unavailable"
                  : `${latest.https.responseTimeMs} ms`
              }
            />
            <Fact label="TLS handshake" value={latest.tls.handshake} />
          </div>
          {latest.https.redirectLocation ? (
            <p className="live-detail">
              Redirect observed, not followed: <code>{latest.https.redirectLocation}</code>
            </p>
          ) : null}
          <p className="live-limitation">{latest.tls.limitation}</p>
          <h3>Saved observations</h3>
          <ol className="live-history">
            {runs.map((run) => (
              <li key={run.id}>
                <b>{run.status}</b>
                <span>{formatTime(run.observedAt)}</span>
                <span>
                  {run.https.status === "reachable"
                    ? `HTTPS ${run.https.statusCode}`
                    : run.https.status}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="empty">No live observations saved for {domain.hostname}.</div>
      )}
      {error ? (
        <div className="inline-error" role="alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value.replaceAll("_", " ")}</b>
    </div>
  );
}

function isReservedDemoHostname(hostname: string): boolean {
  return hostname === "example" || hostname.endsWith(".example");
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Live diagnostics failed.";
}

async function loadHistory(workspaceId: string, domainId: string): Promise<LiveDiagnosticRun[]> {
  return api(`/api/workspaces/${workspaceId}/domains/${domainId}/live-diagnostics`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok)
    throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
  return payload.data;
}
