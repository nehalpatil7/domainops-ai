import { getToolApproval, useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DomainOpsAgent } from "./agent/domain-ops-agent";
import {
  simulationScenarios,
  type DomainOpsState,
  type DomainRecord,
  type DomainStatusEvent,
  type SimulationScenario,
} from "./domain/types";

type ToolPart = UIMessage["parts"][number];

export default function App() {
  const [revision, setRevision] = useState(0);
  const [domains, setDomains] = useState<DomainRecord[]>([]);
  const [history, setHistory] = useState<DomainStatusEvent[]>([]);
  const [selectedHostname, setSelectedHostname] = useState<string | null>(null);
  const [hostname, setHostname] = useState("");
  const [scenario, setScenario] = useState<SimulationScenario>("healthy");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agent = useAgent<DomainOpsAgent, DomainOpsState>({
    agent: "DomainOpsAgent",
    name: "demo",
    onStateUpdate: (state) => setRevision(state.revision),
  });

  const refreshDomains = useCallback(async () => {
    const next = await agent.stub.listDomains();
    setDomains(next);
  }, [agent]);

  useEffect(() => {
    void refreshDomains().catch((cause) => setError(getErrorMessage(cause)));
  }, [refreshDomains, revision]);

  useEffect(() => {
    if (!selectedHostname) {
      setHistory([]);
      return;
    }
    void agent.stub
      .getDomainHistory(selectedHostname)
      .then(setHistory)
      .catch((cause) => setError(getErrorMessage(cause)));
  }, [agent, revision, selectedHostname]);

  const selectedDomain = useMemo(
    () => domains.find((domain) => domain.hostname === selectedHostname) ?? null,
    [domains, selectedHostname],
  );

  const { messages, sendMessage, status, clearHistory, addToolApprovalResponse, stop } =
    useAgentChat({ agent, experimental_throttle: 80 });

  const isChatBusy = status === "streaming" || status === "submitted";

  async function registerDomain(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await agent.stub.registerDomain({ hostname, scenario });
      setHostname("");
      setSelectedHostname(result.domain.hostname);
      await refreshDomains();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function retryValidation(domain: DomainRecord) {
    setError(null);
    try {
      await agent.stub.retryValidation(domain.hostname);
      await refreshDomains();
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }

  function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isChatBusy) return;
    sendMessage({ text });
    setInput("");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Cloudflare-native domain operations</div>
          <h1>DomainOps AI</h1>
        </div>
        <span className="simulation-badge">Simulation mode</span>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}

      <section className="workspace">
        <div className="dashboard-column">
          <section className="panel register-panel">
            <div className="panel-heading">
              <div>
                <span className="section-label">Onboarding</span>
                <h2>Register a custom domain</h2>
              </div>
            </div>
            <form className="register-form" onSubmit={registerDomain}>
              <label>
                Hostname
                <input
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                  placeholder="app.customer.com"
                  autoComplete="off"
                />
              </label>
              <label>
                Scenario
                <select
                  value={scenario}
                  onChange={(event) => setScenario(event.target.value as SimulationScenario)}
                >
                  {simulationScenarios.map((value) => (
                    <option key={value} value={value}>
                      {scenarioLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary-button" disabled={busy} type="submit">
                {busy ? "Registering…" : "Register domain"}
              </button>
            </form>
          </section>

          <section className="panel domains-panel">
            <div className="panel-heading">
              <div>
                <span className="section-label">Inventory</span>
                <h2>Custom domains</h2>
              </div>
              <span className="count-badge">{domains.length}</span>
            </div>

            {domains.length === 0 ? (
              <div className="empty-state">
                Register a domain to start its durable validation workflow.
              </div>
            ) : (
              <div className="domain-list">
                {domains.map((domain) => (
                  <article
                    className={`domain-card ${
                      selectedHostname === domain.hostname ? "selected" : ""
                    }`}
                    key={domain.id}
                  >
                    <button
                      className="domain-main"
                      onClick={() => setSelectedHostname(domain.hostname)}
                    >
                      <div className="domain-title-row">
                        <strong>{domain.hostname}</strong>
                        <span className={domain.ready ? "ready" : "not-ready"}>
                          {domain.ready ? "Ready" : "Needs attention"}
                        </span>
                      </div>
                      <div className="status-grid">
                        <Status label="DNS" value={domain.dnsStatus} />
                        <Status label="Hostname" value={domain.hostnameStatus} />
                        <Status label="Certificate" value={domain.certificateStatus} />
                      </div>
                    </button>
                    <div className="domain-footer">
                      <span>{scenarioLabel(domain.scenario)}</span>
                      <button
                        disabled={Boolean(domain.activeWorkflowId)}
                        onClick={() => void retryValidation(domain)}
                      >
                        {domain.activeWorkflowId ? "Validating…" : "Retry"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {selectedDomain ? (
            <section className="panel history-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-label">Status history</span>
                  <h2>{selectedDomain.hostname}</h2>
                </div>
                <button className="text-button" onClick={() => setSelectedHostname(null)}>
                  Close
                </button>
              </div>
              <ol className="timeline">
                {history.map((event) => (
                  <li key={event.id}>
                    <span className="timeline-dot" />
                    <div>
                      <div className="event-title">
                        {event.category}: {event.nextStatus}
                      </div>
                      <p>{event.reason}</p>
                      <time>{formatTime(event.createdAt)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>

        <section className="panel chat-panel">
          <div className="panel-heading chat-heading">
            <div>
              <span className="section-label">Stateful assistant</span>
              <h2>Troubleshoot with AI</h2>
            </div>
            <button className="text-button" onClick={() => clearHistory()}>
              Clear chat
            </button>
          </div>

          <div className="chat-notice">
            Uses real Workers AI and persistent chat storage. Domain results are simulated.
          </div>

          <div className="messages" aria-live="polite">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <div className="assistant-mark">DO</div>
                <h3>Ask about your domains</h3>
                <p>Try “Which domains need attention?” or “Inspect app.customer.com”.</p>
              </div>
            ) : (
              messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="message-role">
                    {message.role === "user" ? "You" : "DomainOps AI"}
                  </div>
                  <div className="message-body">
                    {message.parts.map((part, index) =>
                      part.type === "text" ? (
                        <p key={index}>{part.text}</p>
                      ) : (
                        <ToolPartView
                          addToolApprovalResponse={addToolApprovalResponse}
                          key={index}
                          part={part}
                        />
                      ),
                    )}
                  </div>
                </article>
              ))
            )}
          </div>

          <form className="chat-form" onSubmit={submitMessage}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Ask about DNS, activation, or certificate status…"
              rows={3}
            />
            <div className="chat-actions">
              <span>Powered by Llama 3.3 on Workers AI</span>
              {isChatBusy ? (
                <button className="secondary-button" type="button" onClick={() => stop()}>
                  Stop
                </button>
              ) : (
                <button className="primary-button" type="submit" disabled={!input.trim()}>
                  Send
                </button>
              )}
            </div>
          </form>
        </section>
      </section>
    </main>
  );
}

function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-item">
      <span>{label}</span>
      <strong className={`status-value ${value}`}>{value}</strong>
    </div>
  );
}

function ToolPartView({
  part,
  addToolApprovalResponse,
}: {
  part: ToolPart;
  addToolApprovalResponse: (response: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const name = getToolName(part);

  if (part.state === "approval-requested") {
    const approval = getToolApproval(part);
    if (!approval) return null;
    return (
      <div className="tool-card approval-card">
        <strong>Approve {name}?</strong>
        <pre>{JSON.stringify(part.input, null, 2)}</pre>
        <div className="approval-actions">
          <button onClick={() => addToolApprovalResponse({ id: approval.id, approved: true })}>
            Approve
          </button>
          <button onClick={() => addToolApprovalResponse({ id: approval.id, approved: false })}>
            Reject
          </button>
        </div>
      </div>
    );
  }

  if (part.state === "output-available") {
    return (
      <details className="tool-card">
        <summary>{name} completed</summary>
        <pre>{JSON.stringify(part.output, null, 2)}</pre>
      </details>
    );
  }

  if (part.state === "output-error") {
    return <div className="tool-card error-tool">{part.errorText}</div>;
  }

  return <div className="tool-card">Running {name}…</div>;
}

function scenarioLabel(scenario: SimulationScenario): string {
  return scenario.replaceAll("_", " ");
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong.";
}
