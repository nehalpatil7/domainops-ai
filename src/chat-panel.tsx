import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useState } from "react";
import type { DomainOpsChatAgent } from "./agent/domain-ops-chat-agent";

export function ChatPanel({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  const [input, setInput] = useState("");
  const agent = useAgent<DomainOpsChatAgent>({ agent: "DomainOpsChatAgent", name: workspaceId });
  const { messages, sendMessage, clearHistory, status, stop, isRecovering, error } = useAgentChat({
    agent,
    experimental_throttle: 60,
  });
  const busy = status === "submitted" || status === "streaming" || isRecovering;
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
    setInput("");
  }
  return (
    <section className="chat-panel">
      <header className="chat-header">
        <div>
          <p className="eyebrow">AI copilot</p>
          <h2>Domain troubleshooting</h2>
        </div>
        <div>
          <button className="text-button" onClick={() => clearHistory()} disabled={busy}>
            Clear
          </button>
          <button className="drawer-close" onClick={onClose} aria-label="Close copilot">
            ×
          </button>
        </div>
      </header>
      <div className="chat-trust">
        <span>✦</span>
        <p>
          Grounded in saved public observations. Ask me to run a new check when you need current
          data.
        </p>
      </div>
      <div className="messages" aria-live="polite">
        {!messages.length ? (
          <div className="chat-empty">
            <div>✦</div>
            <h3>How can I help?</h3>
            <p>Ask about a domain’s DNS, HTTPS health, recent changes, or request a live check.</p>
            <button onClick={() => setInput("Which domains need attention?")}>
              Which domains need attention?
            </button>
            <button onClick={() => setInput("Run a live check for ")}>Run a live check</button>
          </div>
        ) : (
          messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              busy={busy}
              onAction={(prompt) => sendMessage({ text: prompt })}
            />
          ))
        )}
        {status === "submitted" ? (
          <div className="chat-status">
            <i />
            Connecting to diagnostic tools…
          </div>
        ) : null}
        {isRecovering ? (
          <div className="chat-status">
            <i />
            Recovering the response…
          </div>
        ) : null}
        {error ? (
          <div className="chat-error">
            The copilot could not complete that response. {error.message}
          </div>
        ) : null}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about a domain or request a live check…"
          rows={3}
        />
        <div>
          <small>Public checks are rate-limited and SSRF-protected.</small>
          {busy ? (
            <button type="button" className="secondary" onClick={() => stop()}>
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function ChatMessage({
  message,
  busy,
  onAction,
}: {
  message: UIMessage;
  busy: boolean;
  onAction(prompt: string): void;
}) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-role">{message.role === "user" ? "You" : "DomainOps AI"}</div>
      <div className="message-content">
        {message.parts.map((part, index) => {
          if (part.type === "text") return <p key={index}>{part.text}</p>;
          if (isToolUIPart(part)) {
            const name = getToolName(part);
            const output = "output" in part ? part.output : undefined;
            const input = "input" in part ? part.input : undefined;
            const errorText = "errorText" in part ? part.errorText : undefined;
            const failed =
              part.state === "output-error" ||
              Boolean(
                output &&
                typeof output === "object" &&
                "result" in output &&
                output.result === "error",
              );
            return (
              <div className={`tool-call ${failed ? "failed" : ""}`} key={part.toolCallId}>
                <div className="tool-call-heading">
                  <i />
                  {toolLabel(name, part.state)}
                  {toolSubject(input) ? <b>{toolSubject(input)}</b> : null}
                </div>
                {failed ? (
                  <p>{toolError(errorText ?? output)}</p>
                ) : output === undefined ? (
                  <small>{toolProgress(name)}</small>
                ) : (
                  <ToolResult output={output} busy={busy} onAction={onAction} />
                )}
              </div>
            );
          }
          return null;
        })}
      </div>
    </article>
  );
}

function toolLabel(name: string, state: string) {
  const labels: Record<string, string> = {
    listDomains: "Reviewing domain inventory",
    getDomainStatus: "Reading latest domain health",
    getDnsConfiguration: "Inspecting public DNS",
    getDiagnosticHistory: "Reviewing diagnostic history",
    diagnoseDomain: "Analyzing observed issues",
    registerDomain: "Registering domain",
    runLiveDiagnostic: "Running public DNS and HTTPS checks",
  };
  const verb =
    state === "output-available" ? "Complete" : state === "output-error" ? "Failed" : "In progress";
  return `${labels[name] ?? "Using diagnostic tool"} · ${verb}`;
}

function ToolResult({
  output,
  busy,
  onAction,
}: {
  output: unknown;
  busy: boolean;
  onAction(prompt: string): void;
}) {
  const result = asRecord(output);
  if (!result) return <small>Tool completed without a displayable result.</small>;
  if (result.result === "error")
    return <p>{stringValue(result.message, "Tool request failed.")}</p>;
  if (result.result === "ambiguous")
    return <p>More than one domain matched. Choose an exact hostname.</p>;
  if (result.result === "not_found") return <p>No registered domain matched this request.</p>;
  const domain = asRecord(result.domain);
  const dns = Array.isArray(result.dns) ? result.dns.map(asRecord).filter(Boolean) : [];
  const domains = Array.isArray(result.domains) ? result.domains.map(asRecord).filter(Boolean) : [];
  const runs = Array.isArray(result.runs) ? result.runs.map(asRecord).filter(Boolean) : [];
  const facts = Array.isArray(result.observedFacts)
    ? result.observedFacts.filter((item): item is string => typeof item === "string")
    : [];
  return (
    <div className="tool-result">
      {domain ? (
        <div className="tool-result-line">
          <strong>{stringValue(domain.hostname, "Domain")}</strong>
          <span>
            {label(stringValue(domain.healthStatus, stringValue(result.result, "complete")))}
          </span>
        </div>
      ) : null}
      {typeof result.hostname === "string" ? (
        <div className="tool-result-line">
          <strong>{result.hostname}</strong>
          <span>{label(stringValue(result.status, stringValue(result.result, "complete")))}</span>
        </div>
      ) : null}
      {typeof result.count === "number" ? (
        <p>
          {result.count} domain{result.count === 1 ? "" : "s"} returned.
        </p>
      ) : null}
      {domains.length ? (
        <div className="tool-domain-results">
          {domains.slice(0, 8).map((item, index) => (
            <span key={`${stringValue(item?.hostname, "domain")}:${index}`}>
              <b>{stringValue(item?.hostname, "Domain")}</b>
              {label(stringValue(item?.healthStatus, "unknown"))}
            </span>
          ))}
        </div>
      ) : null}
      {dns.length ? (
        <div className="tool-dns-results">
          {dns.map((query, index) => (
            <span key={`${stringValue(query?.type, "DNS")}:${index}`}>
              <b>{stringValue(query?.type, "DNS")}</b>{" "}
              {label(stringValue(query?.status, "unknown"))}
            </span>
          ))}
        </div>
      ) : null}
      {facts.length ? (
        <ul>
          {facts.slice(0, 4).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      ) : null}
      {runs.length ? (
        <p>
          {runs.length} saved check{runs.length === 1 ? "" : "s"}; latest{" "}
          {formatToolTime(runs[0]?.observedAt)}.
        </p>
      ) : null}
      {typeof result.observedAt === "string" ? (
        <small>
          Observed {formatToolTime(result.observedAt)} ·{" "}
          {stringValue(result.freshness, "timestamped result")}
        </small>
      ) : null}
      <ToolActions value={result.availableActions} busy={busy} onAction={onAction} />
    </div>
  );
}

function ToolActions({
  value,
  busy,
  onAction,
}: {
  value: unknown;
  busy: boolean;
  onAction(prompt: string): void;
}) {
  if (!Array.isArray(value)) return null;
  const actions = value
    .map(asRecord)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item.prompt === "string" && typeof item.label === "string"),
    );
  return (
    <div className="tool-actions">
      {actions.map((action) => (
        <button
          key={action.prompt as string}
          disabled={busy}
          onClick={() => onAction(action.prompt as string)}
        >
          {action.label as string}
        </button>
      ))}
    </div>
  );
}

function toolSubject(input: unknown): string | null {
  const value = asRecord(input);
  return value && typeof value.domain === "string" ? value.domain : null;
}
function toolProgress(name: string): string {
  return name === "runLiveDiagnostic"
    ? "Resolving DNS twice, validating the target, then checking HTTPS…"
    : name === "registerDomain"
      ? "Validating and saving the hostname…"
      : "Waiting for the workspace backend…";
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatToolTime(value: unknown): string {
  return typeof value === "string"
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "unknown time";
}
function toolError(output: unknown) {
  if (typeof output === "string") return output;
  if (
    output &&
    typeof output === "object" &&
    "message" in output &&
    typeof output.message === "string"
  )
    return output.message;
  return "The diagnostic tool could not complete this request.";
}
