import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useAgent } from "agents/react";
import { useState } from "react";
import type { DomainOpsChatAgent } from "./agent/domain-ops-chat-agent";

export function ChatPanel({ workspaceId }: { workspaceId: string }) {
  const [input, setInput] = useState("");
  const agent = useAgent<DomainOpsChatAgent>({
    agent: "DomainOpsChatAgent",
    name: workspaceId,
  });
  const { messages, sendMessage, clearHistory, status, stop, isRecovering } = useAgentChat({
    agent,
    experimental_throttle: 80,
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
    <section className="panel chat-panel">
      <div className="panel-heading">
        <div>
          <span>Persistent AI assistant</span>
          <h2>Domain troubleshooting</h2>
        </div>
        <button className="text-button" onClick={() => clearHistory()} disabled={busy}>
          Clear chat
        </button>
      </div>
      <div className="chat-notice">
        Real Workers AI · read-only tools · simulated onboarding and live observations stay separate
      </div>
      <div className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <strong>Ask about this workspace</strong>
            <p>
              Try “Which domains need attention?” or “Why is incorrect-dns.demo.example not ready?”
            </p>
          </div>
        ) : (
          messages.map((message) => <ChatMessage key={message.id} message={message} />)
        )}
        {isRecovering ? <div className="chat-status">Recovering the previous response…</div> : null}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about DNS, SSL, readiness, or validation history…"
          rows={3}
        />
        <div className="chat-actions">
          <small>Conversation history is stored in this workspace's chat Durable Object.</small>
          {busy ? (
            <button className="secondary" type="button" onClick={() => stop()}>
              Stop
            </button>
          ) : (
            <button className="primary" disabled={!input.trim()} type="submit">
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
            const output = "output" in part ? part.output : undefined;
            return (
              <details className="tool-call" key={part.toolCallId}>
                <summary>
                  {getToolName(part)} · {toolStateLabel(part.state)}
                </summary>
                {output === undefined ? null : <pre>{JSON.stringify(output, null, 2)}</pre>}
              </details>
            );
          }
          return null;
        })}
      </div>
    </article>
  );
}

function toolStateLabel(state: string): string {
  if (state === "output-available") return "checked";
  if (state === "output-error") return "failed";
  return "checking";
}
