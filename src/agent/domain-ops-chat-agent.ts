import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createAI } from "agents/models/ai-sdk";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UIMessage,
} from "ai";
import { createDomainAssistantTools, type DomainBackend } from "./domain-assistant-tools";
import { validateWorkspaceId } from "../domain/validation";
import { runPersistedDiagnostic, unwrap } from "../live/persisted-diagnostic";

export const DOMAIN_ASSISTANT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const DOMAIN_ASSISTANT_SYSTEM_PROMPT = [
  "You are DomainOps AI, a concise public-domain troubleshooting copilot.",
  "Backend tools are the only source of domain facts. Never invent DNS, HTTPS, TLS, timestamps, history, or health.",
  "Use a tool before every domain-specific answer, including follow-ups. Resolve pronouns from conversation context.",
  "If a domain is ambiguous, ask which exact hostname the user means. If it is missing or a tool errors, say so plainly.",
  "Structure diagnostic answers as Observed, Possible causes, and Next steps. Keep them short, natural, and actionable.",
  "Always include the observation time and warn when freshness says a result is stale.",
  "Only run runLiveDiagnostic when the user explicitly asks to check, run, scan, refresh, recheck, or diagnose now.",
  "A live check makes DNS-over-HTTPS and HTTPS requests but does not change DNS or certificates.",
  "Never call public HTTPS health a Cloudflare for SaaS activation, hostname provisioning, or certificate provisioning status.",
  "TLS issuer, SAN, serial, and expiry are unavailable; never infer them from handshake success.",
  "After tools finish, always provide a complete user-facing answer. Never end with 'here is the function call', raw arguments, or a promise to call a tool.",
].join(" ");

export class DomainOpsChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true as const;
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workspaceId = validateWorkspaceId(this.name);
    const result = streamText({
      model: createAI({ binding: this.env.AI })(DOMAIN_ASSISTANT_MODEL),
      system: DOMAIN_ASSISTANT_SYSTEM_PROMPT,
      messages: await prepareConversationMessages(this.messages),
      tools: createDomainAssistantTools(this.createBackend(workspaceId)),
      stopWhen: stepCountIs(8),
      prepareStep: ({ stepNumber }) =>
        stepNumber === 0
          ? { toolChoice: "required" as const }
          : stepNumber >= 5
            ? { toolChoice: "none" as const }
            : {},
      temperature: 0.15,
      abortSignal: options?.abortSignal,
    });
    return result.toUIMessageStreamResponse();
  }
  private createBackend(workspaceId: string): DomainBackend {
    const store = this.env.WorkspaceDomainStore.get(
      this.env.WorkspaceDomainStore.idFromName(workspaceId),
    );
    return {
      listDomains: async () => unwrap(await store.listDomains(workspaceId)),
      getDomain: async (domainId) => unwrap(await store.getDomain(workspaceId, domainId)),
      getDiagnosticHistory: async (domainId) =>
        unwrap(await store.getDiagnosticHistory(workspaceId, domainId)),
      runDiagnostic: async (domainId) =>
        (await runPersistedDiagnostic(store, workspaceId, domainId, `agent:${crypto.randomUUID()}`))
          .run,
    };
  }
}

export async function prepareConversationMessages(messages: UIMessage[]): Promise<ModelMessage[]> {
  return pruneMessages({
    messages: await convertToModelMessages(messages),
    toolCalls: "before-last-2-messages",
    reasoning: "before-last-message",
  });
}
