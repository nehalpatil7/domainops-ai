import { useEffect, useState } from "react";
import type { DiagnosticHistoryItem, Domain } from "./domain/types";

type Props = {
  workspaceId: string;
  domain: Domain | null;
  checking: boolean;
  onRun(domain: Domain): Promise<void>;
  onUpdated(): Promise<void>;
};

export function LiveDiagnosticsPanel({ workspaceId, domain, checking, onRun, onUpdated }: Props) {
  const [runs, setRuns] = useState<DiagnosticHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRuns([]);
    setError(null);
    if (!domain) return;
    setLoading(true);
    void load(workspaceId, domain.id)
      .then(setRuns)
      .catch((cause) => setError(message(cause)))
      .finally(() => setLoading(false));
  }, [domain?.id, workspaceId]);

  async function run() {
    if (!domain) return;
    try {
      await onRun(domain);
      setRuns(await load(workspaceId, domain.id));
      await onUpdated();
    } catch (cause) {
      setError(message(cause));
    }
  }

  if (!domain)
    return (
      <section className="panel details-panel">
        <div className="empty-state large">
          <span>⌁</span>
          <h3>Select a domain</h3>
          <p>Choose a hostname to inspect its latest observations and check history.</p>
        </div>
      </section>
    );
  const latest = runs[0] ?? domain.latestDiagnostic;
  return (
    <section className="panel details-panel">
      <div className="panel-heading detail-heading">
        <div>
          <p className="eyebrow">
            Public diagnostics{" "}
            <Info text="Point-in-time public DNS and HTTPS observations. This is not Cloudflare for SaaS activation status." />
          </p>
          <h2>{domain.hostname}</h2>
        </div>
        <button className="primary" disabled={checking} onClick={() => void run()}>
          {checking ? "Checking…" : "Run live check"}
        </button>
      </div>
      {loading ? (
        <div className="detail-loading">Loading diagnostic history…</div>
      ) : latest ? (
        <div className="diagnostic-content">
          <div className="summary-strip">
            <Status status={latest.status} classification={latest.https.classification} />
            <div>
              <span>Last checked</span>
              <strong>{formatTime(latest.observedAt)}</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>{latest.durationMs} ms</strong>
            </div>
            <div>
              <span>Freshness</span>
              <strong>{freshness(latest.observedAt)}</strong>
            </div>
          </div>
          {latest.findings.length ? (
            <section>
              <h3>Observed findings</h3>
              <ul className="findings">
                {latest.findings.map((finding) => (
                  <li key={finding}>{finding}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h3>
              Public DNS{" "}
              <Info text="Queries use Cloudflare's DNS-over-HTTPS resolver. Empty or timed-out answers are preserved as partial observations." />
            </h3>
            <div className="dns-grid">
              {latest.dns.map((query) => (
                <div className={`dns-card dns-${query.status}`} key={query.type}>
                  <header>
                    <b>{query.type}</b>
                    <span>{query.status.replaceAll("_", " ")}</span>
                  </header>
                  {query.records
                    .filter((record) => record.type === query.type)
                    .map((record) => (
                      <code key={`${record.name}:${record.value}`}>{record.value}</code>
                    ))}
                  {query.error ? (
                    <small>{query.error}</small>
                  ) : !query.records.length ? (
                    <small>No records observed</small>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3>
              HTTPS &amp; TLS{" "}
              <Info text="A HEAD request checks HTTPS reachability and handshake success. Workers do not expose certificate issuer, SAN, or expiry metadata." />
            </h3>
            <div className="observation-grid">
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
            {latest.https.redirects?.length ? (
              <p className="callout">
                Original: <code>{latest.https.originalUrl ?? latest.https.url}</code>
                <br />
                Final destination: <code>{latest.https.finalUrl ?? "Unverified"}</code>
                <br />
                Redirect result:{" "}
                <strong>{label(latest.https.classification ?? "redirect_unverified")}</strong>
              </p>
            ) : null}
            <p className="limitation">{latest.tls.limitation}</p>
          </section>
          <section>
            <h3>Check history</h3>
            <div className="timeline">
              {runs.map((item) => (
                <article key={item.id}>
                  <i className={`timeline-dot live-${item.status}`} />
                  <div>
                    <header>
                      <b>{label(item.status)}</b>
                      <time>{formatTime(item.observedAt)}</time>
                    </header>
                    <p>
                      {item.https.status === "reachable"
                        ? `HTTPS ${item.https.statusCode}`
                        : `HTTPS ${item.https.status}`}{" "}
                      · {item.durationMs} ms
                    </p>
                    {item.changes.length ? (
                      <ul className="changes">
                        {item.changes.map((change) => (
                          <li key={`${change.area}:${change.message}`}>{change.message}</li>
                        ))}
                      </ul>
                    ) : (
                      <small>
                        {runs.at(-1)?.id === item.id
                          ? "Baseline observation"
                          : "No meaningful change"}
                      </small>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <div className="empty-state large">
          <span>◌</span>
          <h3>No observations yet</h3>
          <p>
            Run the first live check to inspect public DNS, HTTPS reachability, and TLS handshake
            health.
          </p>
          <button className="primary" onClick={() => void run()}>
            Run first check
          </button>
        </div>
      )}
      {error ? <div className="inline-error">{error}</div> : null}
    </section>
  );
}

function Info({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={text}>
      i<span role="tooltip">{text}</span>
    </span>
  );
}
function Fact({ label: name, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{name}</span>
      <strong>{label(value)}</strong>
    </div>
  );
}
function Status({
  status,
  classification,
}: {
  status: "healthy" | "degraded" | "failed";
  classification?: string;
}) {
  const text =
    classification === "redirected"
      ? "Healthy (Redirected)"
      : classification === "redirect_unverified"
        ? "Redirect Detected (Unverified)"
        : classification === "redirect_loop"
          ? "Redirect Loop"
          : status === "healthy"
            ? "Healthy"
            : "Needs attention";
  return (
    <div className={`result-status live-${status}`}>
      <span>Result</span>
      <strong>{text}</strong>
    </div>
  );
}
function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
function freshness(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 300_000) return "Fresh";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m old`;
  return `${Math.floor(ms / 3_600_000)}h old`;
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Could not load diagnostics.";
}
async function load(workspaceId: string, domainId: string) {
  const response = await fetch(`/api/workspaces/${workspaceId}/domains/${domainId}/diagnostics`);
  const payload = (await response.json()) as {
    data: DiagnosticHistoryItem[];
    error?: { message: string };
  };
  if (!response.ok) throw new Error(payload.error?.message ?? "Could not load diagnostics.");
  return payload.data;
}
