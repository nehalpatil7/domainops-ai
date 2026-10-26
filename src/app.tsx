import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "./chat-panel";
import type { Domain, DomainHealth, Workspace } from "./domain/types";
import { LiveDiagnosticsPanel } from "./live-diagnostics-panel";

type ApiEnvelope<T> = { data: T; error?: { message: string } };
const workspaceStorageKey = "domainops:selected-workspace";

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | DomainHealth>("all");
  const [sort, setSort] = useState<"hostname" | "health" | "checked">("hostname");
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState<"create" | "rename" | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const requestEpoch = useRef(0);

  const loadDomains = useCallback(
    async (id = workspaceId) => {
      if (!id) return;
      const epoch = ++requestEpoch.current;
      setLoading(true);
      try {
        const next = await api<Domain[]>(`/api/workspaces/${id}/domains`);
        if (requestEpoch.current !== epoch) return;
        setDomains(next);
        setSelectedId((current) =>
          next.some((domain) => domain.id === current) ? current : (next[0]?.id ?? null),
        );
      } catch (cause) {
        if (requestEpoch.current === epoch) setError(message(cause));
      } finally {
        if (requestEpoch.current === epoch) setLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void (async () => {
      try {
        let items = await api<Workspace[]>("/api/workspaces");
        if (!items.length) {
          await api<Domain[]>("/api/workspaces/demo-acme/domains");
          await api("/api/workspaces/demo-acme", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Primary workspace" }),
          });
          items = await api<Workspace[]>("/api/workspaces");
        }
        setWorkspaces(items);
        const saved = localStorage.getItem(workspaceStorageKey);
        setWorkspaceId(items.some((item) => item.id === saved) ? saved! : items[0]!.id);
      } catch (cause) {
        setError(message(cause));
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    localStorage.setItem(workspaceStorageKey, workspaceId);
    setDomains([]);
    setSelectedId(null);
    setSearch("");
    setError(null);
    void loadDomains(workspaceId);
  }, [workspaceId, loadDomains]);

  const selected = domains.find((domain) => domain.id === selectedId) ?? null;
  const visibleDomains = useMemo(() => {
    const result = domains.filter(
      (domain) =>
        domain.hostname.includes(search.trim().toLowerCase()) &&
        (filter === "all" || domain.healthStatus === filter),
    );
    return result.sort((a, b) =>
      sort === "hostname"
        ? a.hostname.localeCompare(b.hostname)
        : sort === "health"
          ? a.healthStatus.localeCompare(b.healthStatus)
          : (b.lastCheckedAt ?? "").localeCompare(a.lastCheckedAt ?? ""),
    );
  }, [domains, filter, search, sort]);

  async function register(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId) return;
    setError(null);
    try {
      const result = await api<{ domain: Domain }>(`/api/workspaces/${workspaceId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key("register") },
        body: JSON.stringify({ hostname }),
      });
      setHostname("");
      await loadDomains();
      setSelectedId(result.domain.id);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function runCheck(domain: Domain) {
    setChecking((current) => new Set(current).add(domain.id));
    setError(null);
    try {
      await api(`/api/workspaces/${workspaceId}/domains/${domain.id}/diagnostics`, {
        method: "POST",
        headers: { "Idempotency-Key": key("diagnostic") },
      });
      await loadDomains();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(domain.id);
        return next;
      });
    }
  }

  async function saveWorkspace(event: React.FormEvent) {
    event.preventDefault();
    try {
      const item =
        workspaceDialog === "create"
          ? await api<Workspace>("/api/workspaces", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: workspaceName }),
            })
          : await api<Workspace>(`/api/workspaces/${workspaceId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: workspaceName }),
            });
      const items = await api<Workspace[]>("/api/workspaces");
      setWorkspaces(items);
      setWorkspaceDialog(null);
      setWorkspaceName("");
      if (workspaceDialog === "create") setWorkspaceId(item.id);
    } catch (cause) {
      setError(message(cause));
    }
  }

  function openWorkspaceDialog(kind: "create" | "rename") {
    setWorkspaceDialog(kind);
    setWorkspaceName(
      kind === "rename" ? (workspaces.find((item) => item.id === workspaceId)?.name ?? "") : "",
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">D</span>
          <div>
            <strong>DomainOps AI</strong>
            <small>Public domain observability</small>
          </div>
        </div>
        <div className="header-actions">
          <label className="workspace-select">
            <span>Workspace</span>
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              disabled={!workspaces.length}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-button"
            title="Rename workspace"
            aria-label="Rename workspace"
            onClick={() => openWorkspaceDialog("rename")}
          >
            ✎
          </button>
          <button className="secondary compact" onClick={() => openWorkspaceDialog("create")}>
            + Workspace
          </button>
          <button
            type="button"
            className="secondary compact"
            onClick={() => {
              localStorage.removeItem(workspaceStorageKey);
              window.location.assign("/cdn-cgi/access/logout");
            }}
            title="Sign out of Cloudflare Access"
          >
            Log out
          </button>
          <button className="copilot-button" onClick={() => setDrawerOpen(true)}>
            <span>✦</span> Ask Copilot
          </button>
        </div>
      </header>

      <div className="page-heading">
        <div>
          <p className="eyebrow">Domain health</p>
          <h1>Monitor public DNS and HTTPS</h1>
          <p>
            Real, timestamped observations from Cloudflare DNS over HTTPS and safety-limited edge
            probes.
          </p>
        </div>
        <form className="add-domain" onSubmit={register}>
          <input
            required
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="www.example.com"
            aria-label="Hostname"
          />
          <button className="primary">Add domain</button>
        </form>
      </div>
      {error ? (
        <div className="error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}

      <section className="dashboard-grid">
        <section className="panel inventory-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Inventory</p>
              <h2>Domains</h2>
            </div>
            <span className="count-badge">{domains.length}</span>
          </div>
          <div className="list-controls">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search domains…"
            />
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as typeof filter)}
              aria-label="Filter health"
            >
              <option value="all">All states</option>
              <option value="healthy">Healthy</option>
              <option value="needs_attention">Needs attention</option>
              <option value="checking">Checking</option>
              <option value="unknown">Unknown</option>
            </select>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
              aria-label="Sort domains"
            >
              <option value="hostname">Hostname</option>
              <option value="health">Health</option>
              <option value="checked">Last checked</option>
            </select>
          </div>
          <div className={`domain-list ${loading ? "is-loading" : ""}`}>
            {loading ? (
              <LoadingRows />
            ) : visibleDomains.length ? (
              visibleDomains.map((domain) => (
                <article
                  className={`domain-row ${selectedId === domain.id ? "selected" : ""}`}
                  key={domain.id}
                  onClick={() => setSelectedId(domain.id)}
                >
                  <div className="domain-main">
                    <StatusBadge
                      status={checking.has(domain.id) ? "checking" : domain.healthStatus}
                    />
                    <div>
                      <strong>{domain.hostname}</strong>
                      <small>
                        {domain.lastCheckedAt
                          ? `${freshness(domain.lastCheckedAt)} · ${domain.checkDurationMs ?? 0} ms`
                          : "Not checked yet"}
                      </small>
                    </div>
                  </div>
                  <button
                    className="row-action"
                    disabled={checking.has(domain.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runCheck(domain);
                    }}
                  >
                    {checking.has(domain.id) ? "Checking…" : "Run check"}
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-state">
                <span>◎</span>
                <h3>No domains found</h3>
                <p>
                  {domains.length
                    ? "Try a different search or filter."
                    : "Add a public hostname to begin monitoring."}
                </p>
              </div>
            )}
          </div>
        </section>
        <LiveDiagnosticsPanel
          key={`${workspaceId}:${selectedId ?? "none"}`}
          workspaceId={workspaceId}
          domain={selected}
          checking={selected ? checking.has(selected.id) : false}
          onRun={runCheck}
          onUpdated={() => loadDomains()}
        />
      </section>

      <div
        className={`drawer-backdrop ${drawerOpen ? "open" : ""}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside className={`copilot-drawer ${drawerOpen ? "open" : ""}`} aria-hidden={!drawerOpen}>
        <ChatPanel
          key={workspaceId}
          workspaceId={workspaceId}
          onClose={() => setDrawerOpen(false)}
        />
      </aside>
      {workspaceDialog ? (
        <div className="modal-backdrop">
          <form className="workspace-modal" onSubmit={saveWorkspace}>
            <p className="eyebrow">Workspace</p>
            <h2>{workspaceDialog === "create" ? "Create workspace" : "Rename workspace"}</h2>
            <label>
              Name
              <input
                autoFocus
                required
                maxLength={80}
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
            </label>
            <div>
              <button type="button" className="secondary" onClick={() => setWorkspaceDialog(null)}>
                Cancel
              </button>
              <button className="primary">Save</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function StatusBadge({ status }: { status: DomainHealth }) {
  return (
    <span className={`status-badge status-${status}`}>
      <i />
      {status === "needs_attention"
        ? "Needs attention"
        : status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}
function LoadingRows() {
  return (
    <>
      {[1, 2, 3].map((item) => (
        <div className="skeleton-row" key={item}>
          <i />
          <span />
        </div>
      ))}
    </>
  );
}
function freshness(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 60_000) return "Checked just now";
  if (ms < 3_600_000) return `Checked ${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `Checked ${Math.floor(ms / 3_600_000)}h ago`;
  return `Checked ${Math.floor(ms / 86_400_000)}d ago`;
}
function key(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "Request failed.";
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok)
    throw new Error(payload.error?.message ?? `Request failed (${response.status}).`);
  return payload.data;
}
