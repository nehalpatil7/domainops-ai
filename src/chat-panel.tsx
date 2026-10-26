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
          messages.map((message) => <ChatMessage key={message.id} message={message} />)
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

function ChatMessage({ message }: { message: UIMessage }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="message-role">{message.role === "user" ? "You" : "DomainOps AI"}</div>
      <div className="message-content">
        {message.parts.map((part, index) => {
          if (part.type === "text") return <p key={index}>{part.text}</p>;
          if (isToolUIPart(part)) {
            const name = getToolName(part);
            const output = "output" in part ? part.output : undefined;
            const failed =
              part.state === "output-error" ||
              Boolean(
                output &&
                typeof output === "object" &&
                "result" in output &&
                output.result === "error",
              );
            return (
              <details
                className={`tool-call ${failed ? "failed" : ""}`}
                key={part.toolCallId}
                open={failed}
              >
                <summary>
                  <i />
                  {toolLabel(name, part.state)}
                </summary>
                {failed ? (
                  <p>{toolError(output)}</p>
                ) : output === undefined ? (
                  <small>Please wait while the public observation is retrieved.</small>
                ) : (
                  <small>Diagnostic evidence received.</small>
                )}
              </details>
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
    runLiveDiagnostic: "Running public DNS and HTTPS checks",
  };
  const verb =
    state === "output-available" ? "Complete" : state === "output-error" ? "Failed" : "In progress";
  return `${labels[name] ?? "Using diagnostic tool"} · ${verb}`;
}
function toolError(output: unknown) {
  if (
    output &&
    typeof output === "object" &&
    "message" in output &&
    typeof output.message === "string"
  )
    return output.message;
  return "The diagnostic tool could not complete this request.";
}
