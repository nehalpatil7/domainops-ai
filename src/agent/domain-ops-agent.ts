import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { createAI } from "agents/models/ai-sdk";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { normalizeHostname } from "../domain/hostname";
import type { SimulationResult } from "../domain/simulated-provider";
import {
  simulationScenarios,
  type DomainInspection,
  type DomainOpsState,
  type DomainRecord,
  type DomainStatuses,
  type DomainStatusEvent,
  type RegisterDomainInput,
  type SimulationScenario,
  type WorkflowProgress,
} from "../domain/types";
import type { DomainValidationParams } from "../workflows/domain-validation-workflow";

type DomainRow = {
  id: string;
  hostname: string;
  scenario: SimulationScenario;
  dns_status: DomainRecord["dnsStatus"];
  hostname_status: DomainRecord["hostnameStatus"];
  certificate_status: DomainRecord["certificateStatus"];
  active_workflow_id: string | null;
  source: "simulation";
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
};

type EventRow = {
  id: string;
  domain_id: string;
  category: DomainStatusEvent["category"];
  previous_status: string | null;
  next_status: string;
  reason: string;
  source: DomainStatusEvent["source"];
  workflow_id: string | null;
  created_at: string;
};

const initialStatuses: DomainStatuses = {
  dnsStatus: "pending",
  hostnameStatus: "pending",
  certificateStatus: "pending",
};

export class DomainOpsAgent extends AIChatAgent<Env, DomainOpsState> {
  initialState: DomainOpsState = { revision: 0, workflowProgress: {} };
  maxPersistedMessages = 100;
  chatRecovery = true as const;

  onStart() {
    this.ensureSchema();
  }

  private ensureSchema() {
    void this.sql`
      CREATE TABLE IF NOT EXISTS domains (
        id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL UNIQUE,
        scenario TEXT NOT NULL,
        dns_status TEXT NOT NULL,
        hostname_status TEXT NOT NULL,
        certificate_status TEXT NOT NULL,
        active_workflow_id TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT
      )
    `;
    void this.sql`
      CREATE TABLE IF NOT EXISTS domain_status_events (
        id TEXT PRIMARY KEY,
        domain_id TEXT NOT NULL,
        category TEXT NOT NULL,
        previous_status TEXT,
        next_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        workflow_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (domain_id) REFERENCES domains(id)
      )
    `;
    void this.sql`
      CREATE INDEX IF NOT EXISTS domain_events_by_domain
      ON domain_status_events(domain_id, created_at DESC)
    `;
  }

  @callable()
  listDomains(): DomainRecord[] {
    this.ensureSchema();
    return this.sql<DomainRow>`
      SELECT * FROM domains ORDER BY created_at DESC
    `.map(toDomainRecord);
  }

  @callable()
  getDomainHistory(hostname: string): DomainStatusEvent[] {
    const domain = this.getDomainByHostname(normalizeHostname(hostname));
    if (!domain) return [];

    return this.sql<EventRow>`
      SELECT * FROM domain_status_events
      WHERE domain_id = ${domain.id}
      ORDER BY created_at DESC, id DESC
    `.map(toDomainStatusEvent);
  }

  @callable()
  inspectDomain(hostname: string): DomainInspection | null {
    const normalized = normalizeHostname(hostname);
    const row = this.getDomainByHostname(normalized);
    if (!row) return null;

    return {
      domain: toDomainRecord(row),
      history: this.getDomainHistory(normalized),
    };
  }

  @callable()
  async registerDomain(
    input: RegisterDomainInput,
  ): Promise<{ domain: DomainRecord; workflowId: string }> {
    const hostname = normalizeHostname(input.hostname);
    if (!simulationScenarios.includes(input.scenario)) {
      throw new Error("Unknown simulation scenario.");
    }
    if (this.getDomainByHostname(hostname)) {
      throw new Error("That hostname is already registered.");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    void this.sql`
      INSERT INTO domains (
        id, hostname, scenario, dns_status, hostname_status,
        certificate_status, active_workflow_id, source,
        created_at, updated_at, last_checked_at
      ) VALUES (
        ${id}, ${hostname}, ${input.scenario}, ${initialStatuses.dnsStatus},
        ${initialStatuses.hostnameStatus}, ${initialStatuses.certificateStatus},
        ${null}, ${"simulation"}, ${now}, ${now}, ${null}
      )
    `;

    this.insertEvent(
      id,
      "workflow",
      null,
      "registered",
      "Domain registered with the simulated provider.",
      "user",
      null,
    );

    const workflowId = await this.startValidation(id, input.scenario, "dashboard");
    this.bumpRevision();

    return {
      domain: toDomainRecord(this.getDomainByIdOrThrow(id)),
      workflowId,
    };
  }

  @callable()
  async retryValidation(hostname: string): Promise<{ workflowId: string }> {
    const normalized = normalizeHostname(hostname);
    const domain = this.getDomainByHostname(normalized);
    if (!domain) throw new Error("Domain not found.");
    if (domain.active_workflow_id) {
      throw new Error("A validation workflow is already running.");
    }

    const workflowId = await this.startValidation(domain.id, domain.scenario, "assistant");
    this.updateStatuses(domain, initialStatuses, "Validation retry started.", workflowId);
    this.bumpRevision();
    return { workflowId };
  }

  async applySimulationResult(
    domainId: string,
    result: SimulationResult,
    workflowId: string,
  ): Promise<void> {
    const domain = this.getDomainByIdOrThrow(domainId);
    if (domain.active_workflow_id !== workflowId) {
      return;
    }

    this.updateStatuses(domain, result.statuses, result.message, workflowId);
    this.bumpRevision();
  }

  async onWorkflowProgress(_workflowName: string, workflowId: string, progress: unknown) {
    const domainId = this.getDomainIdForWorkflow(workflowId);
    if (!domainId || !isProgress(progress)) return;

    this.updateWorkflowProgress(domainId, {
      workflowId,
      status: "running",
      step: progress.step,
      message: progress.message,
      percent: progress.percent,
    });
  }

  async onWorkflowComplete(_workflowName: string, workflowId: string, result?: unknown) {
    const domainId = this.getDomainIdForWorkflow(workflowId);
    if (!domainId) return;

    const message = getResultMessage(result) ?? "Validation workflow completed.";
    void this.sql`
      UPDATE domains
      SET active_workflow_id = ${null}, updated_at = ${new Date().toISOString()}
      WHERE id = ${domainId} AND active_workflow_id = ${workflowId}
    `;
    this.insertEvent(domainId, "workflow", "running", "complete", message, "system", workflowId);
    this.updateWorkflowProgress(domainId, {
      workflowId,
      status: "complete",
      step: "complete",
      message,
      percent: 1,
    });
  }

  async onWorkflowError(_workflowName: string, workflowId: string, error: string) {
    const domainId = this.getDomainIdForWorkflow(workflowId);
    if (!domainId) return;

    void this.sql`
      UPDATE domains
      SET active_workflow_id = ${null}, updated_at = ${new Date().toISOString()}
      WHERE id = ${domainId} AND active_workflow_id = ${workflowId}
    `;
    this.insertEvent(domainId, "workflow", "running", "error", error, "system", workflowId);
    this.updateWorkflowProgress(domainId, {
      workflowId,
      status: "error",
      step: "error",
      message: error,
      percent: 0,
    });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersAI = createAI({ binding: this.env.AI });
    const result = streamText({
      model: workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: [
        "You are DomainOps AI, an assistant for custom-domain onboarding.",
        "Use tools to inspect stored domain state before diagnosing an issue.",
        "All current DNS, hostname, and certificate results are simulated; say so clearly.",
        "A domain is ready only when DNS is valid, hostname status is active, and certificate status is active.",
        "Give concise, actionable explanations. Never claim a real DNS or Cloudflare for SaaS check occurred.",
      ].join(" "),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message",
      }),
      tools: {
        listDomains: tool({
          description: "List registered domains and their simulated statuses.",
          inputSchema: z.object({}),
          execute: async () => this.listDomains(),
        }),
        inspectDomain: tool({
          description: "Inspect one registered domain and its simulated status history.",
          inputSchema: z.object({ hostname: z.string() }),
          execute: async ({ hostname }) =>
            this.inspectDomain(hostname) ?? { error: "Domain not found." },
        }),
        retryDomainValidation: tool({
          description: "Start a new simulated domain validation workflow. Requires user approval.",
          inputSchema: z.object({ hostname: z.string() }),
          needsApproval: true,
          execute: async ({ hostname }) => this.retryValidation(hostname),
        }),
      },
      stopWhen: stepCountIs(6),
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  private async startValidation(
    domainId: string,
    scenario: SimulationScenario,
    requestedBy: DomainValidationParams["requestedBy"],
  ): Promise<string> {
    const workflowId = `validation_${domainId.replaceAll("-", "")}_${Date.now()}`;
    void this.sql`
      UPDATE domains
      SET active_workflow_id = ${workflowId}, updated_at = ${new Date().toISOString()}
      WHERE id = ${domainId}
    `;
    try {
      await this.runWorkflow<DomainValidationParams>(
        "DOMAIN_VALIDATION_WORKFLOW",
        { domainId, scenario, requestedBy },
        {
          id: workflowId,
          agentBinding: "DomainOpsAgent",
          metadata: { domainId, scenario, requestedBy },
        },
      );
    } catch (error) {
      void this.sql`
        UPDATE domains
        SET active_workflow_id = ${null}, updated_at = ${new Date().toISOString()}
        WHERE id = ${domainId} AND active_workflow_id = ${workflowId}
      `;
      throw error;
    }
    this.insertEvent(
      domainId,
      "workflow",
      null,
      "running",
      "Validation workflow started.",
      "system",
      workflowId,
    );
    return workflowId;
  }

  private updateStatuses(
    domain: DomainRow,
    statuses: DomainStatuses,
    reason: string,
    workflowId: string,
  ) {
    const changes: Array<{
      category: "dns" | "hostname" | "certificate";
      previous: string;
      next: string;
    }> = [
      {
        category: "dns",
        previous: domain.dns_status,
        next: statuses.dnsStatus,
      },
      {
        category: "hostname",
        previous: domain.hostname_status,
        next: statuses.hostnameStatus,
      },
      {
        category: "certificate",
        previous: domain.certificate_status,
        next: statuses.certificateStatus,
      },
    ];

    const now = new Date().toISOString();
    void this.sql`
      UPDATE domains SET
        dns_status = ${statuses.dnsStatus},
        hostname_status = ${statuses.hostnameStatus},
        certificate_status = ${statuses.certificateStatus},
        updated_at = ${now},
        last_checked_at = ${now}
      WHERE id = ${domain.id}
    `;

    for (const change of changes) {
      if (change.previous !== change.next) {
        this.insertEvent(
          domain.id,
          change.category,
          change.previous,
          change.next,
          reason,
          "simulation",
          workflowId,
        );
      }
    }
  }

  private insertEvent(
    domainId: string,
    category: DomainStatusEvent["category"],
    previousStatus: string | null,
    nextStatus: string,
    reason: string,
    source: DomainStatusEvent["source"],
    workflowId: string | null,
  ) {
    void this.sql`
      INSERT INTO domain_status_events (
        id, domain_id, category, previous_status, next_status,
        reason, source, workflow_id, created_at
      ) VALUES (
        ${crypto.randomUUID()}, ${domainId}, ${category}, ${previousStatus},
        ${nextStatus}, ${reason}, ${source}, ${workflowId},
        ${new Date().toISOString()}
      )
    `;
  }

  private getDomainByHostname(hostname: string): DomainRow | undefined {
    this.ensureSchema();
    return this.sql<DomainRow>`
      SELECT * FROM domains WHERE hostname = ${hostname} LIMIT 1
    `[0];
  }

  private getDomainByIdOrThrow(domainId: string): DomainRow {
    this.ensureSchema();
    const domain = this.sql<DomainRow>`
      SELECT * FROM domains WHERE id = ${domainId} LIMIT 1
    `[0];
    if (!domain) throw new Error("Domain not found.");
    return domain;
  }

  private getDomainIdForWorkflow(workflowId: string): string | undefined {
    this.ensureSchema();
    return this.sql<{ id: string }>`
      SELECT id FROM domains WHERE active_workflow_id = ${workflowId} LIMIT 1
    `[0]?.id;
  }

  private updateWorkflowProgress(domainId: string, progress: WorkflowProgress) {
    this.setState({
      revision: this.state.revision + 1,
      workflowProgress: {
        ...this.state.workflowProgress,
        [domainId]: progress,
      },
    });
  }

  private bumpRevision() {
    this.setState({
      ...this.state,
      revision: this.state.revision + 1,
    });
  }
}

function toDomainRecord(row: DomainRow): DomainRecord {
  return {
    id: row.id,
    hostname: row.hostname,
    scenario: row.scenario,
    dnsStatus: row.dns_status,
    hostnameStatus: row.hostname_status,
    certificateStatus: row.certificate_status,
    activeWorkflowId: row.active_workflow_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCheckedAt: row.last_checked_at,
    ready:
      row.dns_status === "valid" &&
      row.hostname_status === "active" &&
      row.certificate_status === "active",
  };
}

function toDomainStatusEvent(row: EventRow): DomainStatusEvent {
  return {
    id: row.id,
    domainId: row.domain_id,
    category: row.category,
    previousStatus: row.previous_status,
    nextStatus: row.next_status,
    reason: row.reason,
    source: row.source,
    workflowId: row.workflow_id,
    createdAt: row.created_at,
  };
}

function isProgress(value: unknown): value is { step: string; message: string; percent: number } {
  if (!value || typeof value !== "object") return false;
  const progress = value as Record<string, unknown>;
  return (
    typeof progress.step === "string" &&
    typeof progress.message === "string" &&
    typeof progress.percent === "number"
  );
}

function getResultMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
