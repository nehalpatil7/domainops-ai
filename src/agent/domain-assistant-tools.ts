import { tool } from "ai";
import { z } from "zod";
import type { DiagnosticEvent, DnsAssessment, Domain } from "../domain/types";

export interface DomainReadBackend {
  listDomains(): Promise<Domain[]>;
  getDomain(domainId: string): Promise<Domain>;
  getDnsAssessment(domainId: string): Promise<DnsAssessment>;
  getHistory(domainId: string): Promise<DiagnosticEvent[]>;
}

type Resolution =
  | { result: "found"; domain: Domain }
  | { result: "ambiguous"; query: string; matches: Domain[] }
  | { result: "not_found"; query: string; availableHostnames: string[] };

export function createDomainToolHandlers(backend: DomainReadBackend) {
  async function resolveDomain(query: string): Promise<Resolution> {
    const domains = await backend.listDomains();
    const normalized = query.trim().toLowerCase().replace(/\.$/, "");
    const exact = domains.find(
      (domain) => domain.id.toLowerCase() === normalized || domain.hostname === normalized,
    );
    if (exact) return { result: "found", domain: exact };

    const matches = normalized
      ? domains.filter((domain) => domain.hostname.includes(normalized))
      : [];
    if (matches.length === 1) return { result: "found", domain: matches[0] };
    if (matches.length > 1) return { result: "ambiguous", query, matches };
    return {
      result: "not_found",
      query,
      availableHostnames: domains.map((domain) => domain.hostname),
    };
  }

  return {
    listDomains: async ({ readiness }: { readiness: "all" | "ready" | "attention" }) =>
      safely("listDomains", async () => {
        const domains = await backend.listDomains();
        const filtered = domains.filter(
          (domain) =>
            readiness === "all" ||
            (readiness === "ready" && domain.ready) ||
            (readiness === "attention" && !domain.ready),
        );
        return {
          result: "success" as const,
          source: "domainops_backend" as const,
          providerData: "simulation" as const,
          count: filtered.length,
          domains: filtered.map(domainSummary),
        };
      }),

    getDomainStatus: async ({ domain }: { domain: string }) =>
      safely("getDomainStatus", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolvedResponse(resolution);
        const current = await backend.getDomain(resolution.domain.id);
        return {
          result: "success" as const,
          source: "domainops_backend" as const,
          providerData: "simulation" as const,
          domain: domainSummary(current),
          timestamps: {
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
            lastValidationAttemptAt: current.lastValidationAttemptAt,
          },
          retryCount: current.retryCount,
          validationInProgress: current.activeValidationId !== null,
        };
      }),

    getDnsConfiguration: async ({ domain }: { domain: string }) =>
      safely("getDnsConfiguration", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolvedResponse(resolution);
        const assessment = await backend.getDnsAssessment(resolution.domain.id);
        return {
          result: "success" as const,
          source: "domainops_backend" as const,
          providerData: "simulation" as const,
          hostname: assessment.hostname,
          ready: assessment.ready,
          statuses: {
            dns: assessment.dnsStatus,
            hostname: assessment.hostnameStatus,
            ssl: assessment.sslStatus,
            validation: assessment.validationState,
          },
          expectedRecords: assessment.expectedRecords,
          observedRecords: assessment.observedRecords,
          matchingRecords: assessment.matchingRecords,
          missingRecords: assessment.missingRecords,
          unexpectedRecords: assessment.unexpectedRecords,
          requiredValidationRecords: assessment.requiredValidationRecords,
        };
      }),

    getValidationHistory: async ({
      domain,
      lastAttemptOnly,
    }: {
      domain: string;
      lastAttemptOnly: boolean;
    }) =>
      safely("getValidationHistory", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolvedResponse(resolution);
        const history = await backend.getHistory(resolution.domain.id);
        const attempts = history
          .map((event) => event.attempt)
          .filter((attempt): attempt is number => attempt !== null);
        const lastAttempt = attempts.length ? Math.max(...attempts) : null;
        const selected =
          lastAttemptOnly && lastAttempt !== null
            ? history.filter((event) => event.attempt === lastAttempt)
            : history;
        return {
          result: "success" as const,
          source: "domainops_backend" as const,
          providerData: "simulation" as const,
          hostname: resolution.domain.hostname,
          lastAttempt,
          events: selected.slice(0, 50).map(eventSummary),
        };
      }),

    diagnoseDomain: async ({ domain }: { domain: string }) =>
      safely("diagnoseDomain", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolvedResponse(resolution);
        const [current, assessment, history] = await Promise.all([
          backend.getDomain(resolution.domain.id),
          backend.getDnsAssessment(resolution.domain.id),
          backend.getHistory(resolution.domain.id),
        ]);
        return buildDiagnosis(current, assessment, history);
      }),
  };
}

export function createDomainAssistantTools(backend: DomainReadBackend) {
  const handlers = createDomainToolHandlers(backend);
  return {
    listDomains: tool({
      description:
        "List the workspace's domains using the DomainOps backend. Use for inventory, readiness, or when the user has not identified a domain.",
      inputSchema: z.object({
        readiness: z.enum(["all", "ready", "attention"]).default("all"),
      }),
      execute: handlers.listDomains,
    }),
    getDomainStatus: tool({
      description:
        "Get the confirmed current DNS, hostname, SSL, and aggregate validation status for one domain. The domain may be a full hostname, partial hostname, or ID.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.getDomainStatus,
    }),
    getDnsConfiguration: tool({
      description:
        "Get confirmed expected and observed DNS plus hostname ownership and SSL certificate validation records for one domain.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.getDnsConfiguration,
    }),
    getValidationHistory: tool({
      description:
        "Get timestamped validation and diagnostic history for one domain. Use lastAttemptOnly for questions about the most recent attempt.",
      inputSchema: z.object({
        domain: z.string().min(1),
        lastAttemptOnly: z.boolean().default(false),
      }),
      execute: handlers.getValidationHistory,
    }),
    diagnoseDomain: tool({
      description:
        "Diagnose one domain from current backend state, DNS evidence, SSL validation records, and history. Returns confirmed blockers separately from possible causes and recommended read-only troubleshooting steps.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.diagnoseDomain,
    }),
  };
}

function buildDiagnosis(domain: Domain, dns: DnsAssessment, history: DiagnosticEvent[]) {
  const blockers: Array<{ area: string; confirmedFact: string; diagnosticCode: string }> = [];
  const possibleCauses: string[] = [];
  const recommendedActions: string[] = [];

  if (domain.dnsStatus !== "valid") {
    blockers.push({
      area: "dns",
      confirmedFact: `DNS status is ${domain.dnsStatus}; ${dns.missingRecords.length} expected record(s) are missing and ${dns.unexpectedRecords.length} unexpected record(s) were observed.`,
      diagnosticCode: "DNS_CONFIGURATION_INVALID",
    });
    possibleCauses.push(
      "The customer hostname may still point to an earlier origin, contain a conflicting record, or not have propagated yet.",
    );
    for (const record of dns.expectedRecords) {
      recommendedActions.push(
        `Set ${record.name} to ${record.type} ${record.value}; remove conflicting records for the same name, then wait for DNS propagation.`,
      );
    }
  }

  if (domain.hostnameStatus !== "active") {
    blockers.push({
      area: "hostname",
      confirmedFact: `Hostname activation status is ${domain.hostnameStatus}.`,
      diagnosticCode: "HOSTNAME_NOT_ACTIVE",
    });
    possibleCauses.push(
      "Hostname ownership validation may be incomplete, blocked by DNS, or waiting for provider processing.",
    );
    const ownership = dns.requiredValidationRecords.find(
      (record) => record.purpose === "hostname_ownership",
    );
    if (ownership) {
      recommendedActions.push(
        `Verify ${ownership.type} ${ownership.name} has value ${ownership.value}; its simulated status is ${ownership.status}.`,
      );
    }
  }

  if (domain.sslStatus !== "active") {
    blockers.push({
      area: "ssl",
      confirmedFact: `SSL certificate status is ${domain.sslStatus}.`,
      diagnosticCode: "SSL_NOT_ACTIVE",
    });
    const certificate = dns.requiredValidationRecords.find(
      (record) => record.purpose === "certificate",
    );
    if (domain.sslStatus.startsWith("pending_")) {
      possibleCauses.push(
        "Certificate validation, issuance, or edge deployment may still be processing.",
      );
    } else {
      possibleCauses.push(
        "Certificate validation may have timed out or failed after the required validation record was unavailable or incorrect.",
      );
    }
    if (certificate) {
      recommendedActions.push(
        `Verify ${certificate.type} ${certificate.name} has value ${certificate.value}; its simulated status is ${certificate.status}.`,
      );
    }
  }

  if (blockers.length === 0) {
    recommendedActions.push(
      "No corrective action is currently required; continue monitoring status.",
    );
  } else {
    recommendedActions.push(
      "After correcting the confirmed configuration issue, trigger revalidation from the dashboard and review the new diagnostic events.",
    );
  }

  return {
    result: "success" as const,
    source: "domainops_backend" as const,
    providerData: "simulation" as const,
    hostname: domain.hostname,
    ready: domain.ready,
    confirmedStatus: domainSummary(domain),
    blockers,
    possibleCauses: unique(possibleCauses),
    recommendedActions: unique(recommendedActions),
    latestDiagnosticEvents: history.slice(0, 5).map(eventSummary),
    caution:
      "These findings come from the deterministic demo provider, not live public DNS or a production Cloudflare for SaaS account.",
  };
}

async function safely<T>(operation: string, action: () => Promise<T>) {
  try {
    return await action();
  } catch (cause) {
    const code =
      cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : "TOOL_BACKEND_ERROR";
    const message = cause instanceof Error ? cause.message : "The domain backend request failed.";
    return {
      result: "error" as const,
      source: "domainops_backend" as const,
      operation,
      code,
      message,
      instruction:
        "Explain that confirmed data is unavailable; do not infer or invent domain state.",
    };
  }
}

function unresolvedResponse(resolution: Exclude<Resolution, { result: "found" }>) {
  if (resolution.result === "ambiguous") {
    return {
      result: "ambiguous" as const,
      source: "domainops_backend" as const,
      query: resolution.query,
      matches: resolution.matches.map((domain) => ({ id: domain.id, hostname: domain.hostname })),
      instruction: "Ask the user which exact hostname they mean before diagnosing it.",
    };
  }
  return {
    result: "not_found" as const,
    source: "domainops_backend" as const,
    query: resolution.query,
    availableHostnames: resolution.availableHostnames,
    instruction: "Say the domain was not found and ask the user to choose a listed hostname.",
  };
}

function domainSummary(domain: Domain) {
  return {
    id: domain.id,
    hostname: domain.hostname,
    ready: domain.ready,
    dnsStatus: domain.dnsStatus,
    hostnameStatus: domain.hostnameStatus,
    sslStatus: domain.sslStatus,
    validationState: domain.validationState,
    simulationProfile: domain.simulationProfile,
    source: domain.source,
  };
}

function eventSummary(event: DiagnosticEvent) {
  return {
    eventType: event.eventType,
    category: event.category,
    previousValue: event.previousValue,
    nextValue: event.nextValue,
    diagnosticCode: event.diagnosticCode,
    message: event.message,
    attempt: event.attempt,
    source: event.source,
    createdAt: event.createdAt,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
