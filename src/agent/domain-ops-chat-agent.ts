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
import { createDomainAssistantTools, type DomainReadBackend } from "./domain-assistant-tools";
import { validateWorkspaceId } from "../domain/validation";
import type { BackendResult } from "../domain/types";

export const DOMAIN_ASSISTANT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const DOMAIN_ASSISTANT_SYSTEM_PROMPT = [
  "You are DomainOps AI, a read-only custom-domain troubleshooting assistant.",
  "The DomainOps backend tools are the only source of truth for domain inventory, DNS, hostname activation, SSL, validation records, and history.",
  "Every turn must use at least one tool before making a claim about a domain, including follow-up questions.",
  "Never invent a hostname, status, DNS record, certificate detail, timestamp, event, or validation result.",
  "When a tool returns ambiguous, ask which exact hostname the user means and do not diagnose yet.",
  "When a tool returns not_found or error, clearly say confirmed data is unavailable and do not infer state.",
  "Separate confirmed facts from possible causes. Label possible causes as possibilities, not findings.",
  "Give concise, ordered, actionable fixes based on returned expected records and validation details.",
  "Simulated onboarding tool results must be labeled as deterministic demo data and never described as live DNS or production Cloudflare for SaaS API results.",
  "Live tool results are saved point-in-time public DNS/HTTPS observations and must include their observation timestamp and limitations.",
  "Hostname activation and SSL certificate status are independent. A domain is ready only when DNS, hostname, SSL, and validation are all active/valid.",
  "Tools are read-only. Never claim to retry, modify DNS, issue a certificate, or change domain state.",
  "There are two strictly separate evidence modes: simulation for Cloudflare for SaaS onboarding, and live_public for persisted public DNS/HTTPS observations.",
  "Use live tools when the user says live, actual, public, reachable, current DNS, or real. Use simulated tools only for demo onboarding and provisioning questions.",
  "Never report simulated expected records, validation records, hostname failures, or SSL provisioning states as live findings.",
  "If the intended mode is unclear and the distinction affects the answer, ask whether the user means live public diagnostics or simulated SaaS onboarding.",
].join(" ");

export class DomainOpsChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true as const;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workspaceId = validateWorkspaceId(this.name);
    const workersAI = createAI({ binding: this.env.AI });
    const result = streamText({
      model: workersAI(DOMAIN_ASSISTANT_MODEL),
      system: DOMAIN_ASSISTANT_SYSTEM_PROMPT,
      messages: await prepareConversationMessages(this.messages),
      tools: createDomainAssistantTools(this.createBackend(workspaceId)),
      stopWhen: stepCountIs(6),
      prepareStep: ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: "required" } : {}),
      temperature: 0.2,
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  private createBackend(workspaceId: string): DomainReadBackend {
    const storeId = this.env.WorkspaceDomainStore.idFromName(workspaceId);
    const store = this.env.WorkspaceDomainStore.get(storeId);
    return {
      listDomains: async () => unwrap(await store.listDomains(workspaceId)),
      getDomain: async (domainId) => unwrap(await store.getDomain(workspaceId, domainId)),
      getDnsAssessment: async (domainId) =>
        unwrap(await store.getDnsAssessment(workspaceId, domainId)),
      getHistory: async (domainId) => unwrap(await store.getHistory(workspaceId, domainId)),
      getLiveDiagnosticHistory: async (domainId) =>
        unwrap(await store.getLiveDiagnosticHistory(workspaceId, domainId)),
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

function unwrap<T>(result: BackendResult<T>): T {
  if (result.ok) return result.value;
  const error = new Error(result.error.message) as Error & { code: string };
  error.code = result.error.code;
  throw error;
}
