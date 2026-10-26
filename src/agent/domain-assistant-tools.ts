import { tool } from "ai";
import { z } from "zod";
import type { DiagnosticHistoryItem, Domain, LiveDiagnosticRun } from "../domain/types";

export interface DomainBackend {
  listDomains(): Promise<Domain[]>;
  getDomain(domainId: string): Promise<Domain>;
  getDiagnosticHistory(domainId: string): Promise<DiagnosticHistoryItem[]>;
  runDiagnostic(domainId: string): Promise<LiveDiagnosticRun | null>;
}
type Resolution =
  | { result: "found"; domain: Domain }
  | { result: "ambiguous"; query: string; matches: Domain[] }
  | { result: "not_found"; query: string; availableHostnames: string[] };

export function createDomainToolHandlers(backend: DomainBackend) {
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
    if (matches.length === 1) return { result: "found", domain: matches[0]! };
    if (matches.length > 1) return { result: "ambiguous", query, matches };
    return {
      result: "not_found",
      query,
      availableHostnames: domains.map((domain) => domain.hostname),
    };
  }

  return {
    listDomains: async ({
      health,
    }: {
      health: "all" | "healthy" | "needs_attention" | "checking" | "unknown";
    }) =>
      safely("listDomains", async () => {
        const domains = (await backend.listDomains()).filter(
          (domain) => health === "all" || domain.healthStatus === health,
        );
        return {
          result: "success" as const,
          source: "live_public" as const,
          count: domains.length,
          domains: domains.map(domainSummary),
        };
      }),
    getDomainStatus: async ({ domain }: { domain: string }) =>
      safely("getDomainStatus", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolved(resolution);
        return {
          result: "success" as const,
          source: "live_public" as const,
          domain: domainSummary(await backend.getDomain(resolution.domain.id)),
        };
      }),
    getDnsConfiguration: async ({ domain }: { domain: string }) =>
      safely("getDnsConfiguration", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolved(resolution);
        const current = await backend.getDomain(resolution.domain.id);
        if (!current.latestDiagnostic) return noObservation(current.hostname);
        return {
          result: "success" as const,
          source: "live_public" as const,
          hostname: current.hostname,
          observedAt: current.latestDiagnostic.observedAt,
          freshness: freshness(current.latestDiagnostic.observedAt),
          dns: current.latestDiagnostic.dns,
          publicAddresses: current.latestDiagnostic.publicAddresses,
          safety: current.latestDiagnostic.safety,
        };
      }),
    getDiagnosticHistory: async ({ domain }: { domain: string }) =>
      safely("getDiagnosticHistory", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolved(resolution);
        const runs = await backend.getDiagnosticHistory(resolution.domain.id);
        return {
          result: "success" as const,
          source: "live_public" as const,
          hostname: resolution.domain.hostname,
          runs: runs.map(runSummary),
        };
      }),
    diagnoseDomain: async ({ domain }: { domain: string }) =>
      safely("diagnoseDomain", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolved(resolution);
        const current = await backend.getDomain(resolution.domain.id);
        return current.latestDiagnostic
          ? buildDiagnosis(current.latestDiagnostic)
          : noObservation(current.hostname);
      }),
    runLiveDiagnostic: async ({ domain }: { domain: string }) =>
      safely("runLiveDiagnostic", async () => {
        const resolution = await resolveDomain(domain);
        if (resolution.result !== "found") return unresolved(resolution);
        const run = await backend.runDiagnostic(resolution.domain.id);
        if (!run)
          return {
            result: "in_progress" as const,
            source: "live_public" as const,
            hostname: resolution.domain.hostname,
            instruction: "Tell the user another check is already running and to retry shortly.",
          };
        return { ...buildDiagnosis(run), initiatedByAssistant: true };
      }),
  };
}

export function createDomainAssistantTools(backend: DomainBackend) {
  const handlers = createDomainToolHandlers(backend);
  return {
    listDomains: tool({
      description: "List registered domains and their latest real public diagnostic health.",
      inputSchema: z.object({
        health: z.enum(["all", "healthy", "needs_attention", "checking", "unknown"]).default("all"),
      }),
      execute: handlers.listDomains,
    }),
    getDomainStatus: tool({
      description: "Get one domain's latest real public health, observation time, and freshness.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.getDomainStatus,
    }),
    getDnsConfiguration: tool({
      description:
        "Get observed public A, AAAA, CNAME, TXT, and CAA results from the latest saved check.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.getDnsConfiguration,
    }),
    getDiagnosticHistory: tool({
      description: "Get real timestamped diagnostic history and meaningful changes between checks.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.getDiagnosticHistory,
    }),
    diagnoseDomain: tool({
      description:
        "Diagnose a domain from its latest saved public DNS, HTTPS, and TLS observation.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.diagnoseDomain,
    }),
    runLiveDiagnostic: tool({
      description:
        "Run and persist a real public DNS/HTTPS diagnostic. ONLY call when the user explicitly asks to check, run, scan, refresh, recheck, or diagnose now. Never call automatically for a general status question.",
      inputSchema: z.object({ domain: z.string().min(1) }),
      execute: handlers.runLiveDiagnostic,
    }),
  };
}

function buildDiagnosis(run: LiveDiagnosticRun) {
  const possibleCauses: string[] = [];
  const nextSteps: string[] = [];
  const addresses = run.dns.filter((query) => query.type === "A" || query.type === "AAAA");
  if (addresses.every((query) => query.status === "no_records")) {
    possibleCauses.push(
      "The hostname may not have a public address target, or a recent DNS change may still be propagating.",
    );
    nextSteps.push(
      "Publish a public A/AAAA record or a CNAME that resolves publicly, then rerun the check after propagation.",
    );
  }
  if (run.dns.some((query) => query.status === "error" || query.status === "timeout")) {
    possibleCauses.push("Some DNS observations were unavailable, so the result is partial.");
    nextSteps.push(
      "Rerun the check; if the same record type fails repeatedly, verify it with another public resolver.",
    );
  }
  if (run.safety.blockedAddresses.length)
    nextSteps.push(
      "Point the hostname at a public target; private and internal addresses are intentionally not probed.",
    );
  if (run.https.status === "unreachable") {
    possibleCauses.push(
      "The origin may be unavailable, filtering requests, or failing the TLS handshake.",
    );
    nextSteps.push(
      "Verify HTTPS on port 443 and a publicly trusted certificate matching this hostname.",
    );
  }
  if (run.https.redirectLocation)
    nextSteps.push(
      `Review the redirect to ${run.https.redirectLocation}; this probe records but does not follow redirects.`,
    );
  if (!possibleCauses.length)
    possibleCauses.push("No public DNS or HTTPS failure was observed in this snapshot.");
  if (!nextSteps.length)
    nextSteps.push("No corrective action is indicated. Run another check if conditions change.");
  return {
    result: "success" as const,
    source: "live_public" as const,
    hostname: run.hostname,
    observedAt: run.observedAt,
    freshness: freshness(run.observedAt),
    status: run.status,
    observedFacts: run.findings,
    possibleCauses,
    nextSteps,
    dns: run.dns,
    https: run.https,
    tls: run.tls,
    limitations: run.limitations,
  };
}

function domainSummary(domain: Domain) {
  return {
    id: domain.id,
    hostname: domain.hostname,
    healthStatus: domain.healthStatus,
    lastCheckedAt: domain.lastCheckedAt,
    checkDurationMs: domain.checkDurationMs,
    freshness: domain.lastCheckedAt ? freshness(domain.lastCheckedAt) : "never checked",
  };
}
function runSummary(run: DiagnosticHistoryItem) {
  return {
    id: run.id,
    status: run.status,
    observedAt: run.observedAt,
    durationMs: run.durationMs,
    https: run.https,
    tls: run.tls,
    findings: run.findings,
    changes: run.changes,
  };
}
function freshness(observedAt: string): string {
  const age = Math.max(0, Date.now() - new Date(observedAt).getTime());
  if (age < 60_000) return "fresh (under 1 minute old)";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} minutes old`;
  return `${Math.floor(age / 3_600_000)} hours old (stale; consider running a new check)`;
}
function noObservation(hostname: string) {
  return {
    result: "no_observation" as const,
    source: "live_public" as const,
    hostname,
    instruction:
      "Say this domain has not been checked yet. Offer to run a live diagnostic, but do not claim current health.",
  };
}
function unresolved(resolution: Exclude<Resolution, { result: "found" }>) {
  return resolution.result === "ambiguous"
    ? {
        result: "ambiguous" as const,
        source: "live_public" as const,
        query: resolution.query,
        matches: resolution.matches.map(({ id, hostname }) => ({ id, hostname })),
        instruction: "Ask which exact hostname the user means.",
      }
    : {
        result: "not_found" as const,
        source: "live_public" as const,
        query: resolution.query,
        availableHostnames: resolution.availableHostnames,
        instruction: "Say the domain is not registered in this workspace.",
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
    return {
      result: "error" as const,
      source: "live_public" as const,
      operation,
      code,
      message: cause instanceof Error ? cause.message : "The diagnostic backend request failed.",
      instruction: "Give this meaningful error to the user and do not infer domain state.",
    };
  }
}
