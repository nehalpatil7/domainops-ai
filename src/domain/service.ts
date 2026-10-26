import { DomainError } from "./errors";
import { DomainRepository, type NewDomain } from "./repository";
import type {
  DiagnosticChange,
  DiagnosticHistoryItem,
  Domain,
  LiveDiagnosticRun,
  PrepareLiveDiagnosticResult,
  RegisterDomainInput,
  RegisterDomainResult,
} from "./types";
import {
  parseRegisterDomainInput,
  validateDomainId,
  validateIdempotencyKey,
  validateWorkspaceId,
} from "./validation";
import { validateLiveHostname } from "../live/network-safety";

type StoredRegistration = { domainId: string };
type StoredDiagnostic = {
  domainId: string;
  requestId: string;
  status: "pending" | "complete" | "failed";
  runId: string | null;
};

export class DomainService {
  constructor(
    private readonly repository: DomainRepository,
    private readonly workspaceId: string,
  ) {
    validateWorkspaceId(workspaceId);
    repository.ensureSchema();
    repository.bindWorkspace(workspaceId);
  }

  listDomains(): Domain[] {
    return this.repository.listDomains(this.workspaceId);
  }
  getDomain(domainId: string): Domain {
    validateDomainId(domainId);
    const domain = this.repository.getDomain(this.workspaceId, domainId);
    if (!domain) throw DomainError.notFound();
    return domain;
  }
  getDiagnosticHistory(domainId: string): DiagnosticHistoryItem[] {
    const domain = this.getDomain(domainId);
    const runs = this.repository.listDiagnosticRuns(this.workspaceId, domain.id);
    return runs.map((run, index) => ({ ...run, changes: compareRuns(runs[index + 1], run) }));
  }

  registerDomain(
    input: RegisterDomainInput | unknown,
    idempotencyKey: string,
  ): RegisterDomainResult {
    const key = validateIdempotencyKey(idempotencyKey);
    const parsed = parseRegisterDomainInput(input);
    validateLiveHostname(parsed.hostname);
    const requestJson = JSON.stringify(parsed);
    const stored = this.repository.getIdempotency<StoredRegistration>(
      this.workspaceId,
      key,
      "register_domain",
      requestJson,
    );
    if (stored) return { domain: this.getDomain(stored.domainId), duplicate: true };
    if (this.repository.getDomainByHostname(this.workspaceId, parsed.hostname)) {
      throw DomainError.conflict(
        "DOMAIN_ALREADY_EXISTS",
        "Hostname is already registered in this workspace.",
        { hostname: parsed.hostname },
      );
    }
    const now = new Date().toISOString();
    const domain: NewDomain = {
      id: crypto.randomUUID(),
      workspaceId: this.workspaceId,
      hostname: parsed.hostname,
      createdAt: now,
      updatedAt: now,
    };
    this.repository.insertDomain(domain);
    this.repository.putIdempotency(
      this.workspaceId,
      key,
      "register_domain",
      requestJson,
      { domainId: domain.id },
      now,
    );
    return { domain: this.getDomain(domain.id), duplicate: false };
  }

  prepareDiagnostic(domainId: string, idempotencyKey: string): PrepareLiveDiagnosticResult {
    const domain = this.getDomain(domainId);
    validateLiveHostname(domain.hostname);
    const key = validateIdempotencyKey(idempotencyKey);
    const requestJson = JSON.stringify({ domainId });
    const stored = this.repository.getIdempotency<StoredDiagnostic>(
      this.workspaceId,
      key,
      "diagnostic",
      requestJson,
    );
    if (stored) {
      if (stored.status === "failed")
        throw DomainError.conflict(
          "DIAGNOSTIC_PREVIOUSLY_FAILED",
          "This diagnostic request previously failed; retry with a new Idempotency-Key.",
        );
      return {
        domain,
        requestId: stored.requestId,
        duplicate: true,
        shouldRun: false,
        existingRun: stored.runId
          ? this.repository.getDiagnosticRun(this.workspaceId, domain.id, stored.runId)
          : null,
      };
    }
    const now = new Date();
    const latest = this.repository.listDiagnosticRuns(this.workspaceId, domain.id, 1)[0];
    if (latest && now.getTime() - new Date(latest.observedAt).getTime() < 30_000) {
      const saved = {
        domainId,
        requestId: latest.id,
        status: "complete" as const,
        runId: latest.id,
      };
      this.repository.putIdempotency(
        this.workspaceId,
        key,
        "diagnostic",
        requestJson,
        saved,
        now.toISOString(),
      );
      return {
        domain,
        requestId: latest.id,
        duplicate: false,
        shouldRun: false,
        existingRun: latest,
      };
    }
    const requestId = crypto.randomUUID();
    if (
      !this.repository.acquireDiagnostic(
        this.workspaceId,
        domain.id,
        requestId,
        now.toISOString(),
        new Date(now.getTime() - 60_000).toISOString(),
      )
    ) {
      throw DomainError.conflict(
        "DIAGNOSTIC_IN_PROGRESS",
        "A diagnostic check is already running for this domain.",
      );
    }
    this.repository.putIdempotency(
      this.workspaceId,
      key,
      "diagnostic",
      requestJson,
      { domainId, requestId, status: "pending", runId: null },
      now.toISOString(),
    );
    return { domain, requestId, duplicate: false, shouldRun: true, existingRun: null };
  }

  completeDiagnostic(
    domainId: string,
    idempotencyKey: string,
    requestId: string,
    result: LiveDiagnosticRun,
  ): LiveDiagnosticRun {
    const domain = this.getDomain(domainId);
    const run: LiveDiagnosticRun = {
      ...result,
      id: requestId,
      workspaceId: this.workspaceId,
      domainId: domain.id,
      hostname: domain.hostname,
      source: "live_public",
    };
    if (!this.repository.releaseDiagnostic(this.workspaceId, domain.id, requestId)) {
      const existing = this.repository.getDiagnosticRun(this.workspaceId, domain.id, requestId);
      if (existing) return existing;
      throw DomainError.conflict(
        "STALE_DIAGNOSTIC",
        "This diagnostic request is no longer active.",
      );
    }
    this.repository.insertDiagnosticRun(run);
    this.repository.updateIdempotencyResponse(this.workspaceId, idempotencyKey, "diagnostic", {
      domainId,
      requestId,
      status: "complete",
      runId: run.id,
    });
    return run;
  }

  failDiagnostic(domainId: string, idempotencyKey: string, requestId: string): void {
    const domain = this.getDomain(domainId);
    this.repository.releaseDiagnostic(this.workspaceId, domain.id, requestId);
    this.repository.updateIdempotencyResponse(this.workspaceId, idempotencyKey, "diagnostic", {
      domainId,
      requestId,
      status: "failed",
      runId: null,
    });
  }
}

export function compareRuns(
  previous: LiveDiagnosticRun | undefined,
  current: LiveDiagnosticRun,
): DiagnosticChange[] {
  if (!previous) return [];
  const changes: DiagnosticChange[] = [];
  if (previous.status !== current.status)
    changes.push({
      area: "overall",
      previous: previous.status,
      current: current.status,
      message: `Overall health changed from ${previous.status} to ${current.status}.`,
    });
  for (const type of ["A", "AAAA", "CNAME", "TXT", "CAA"] as const) {
    const before = previous.dns.find((query) => query.type === type)?.status ?? "unavailable";
    const after = current.dns.find((query) => query.type === type)?.status ?? "unavailable";
    if (before !== after)
      changes.push({
        area: "dns",
        previous: `${type}: ${before}`,
        current: `${type}: ${after}`,
        message: `${type} lookup changed from ${before} to ${after}.`,
      });
  }
  if (previous.https.status !== current.https.status)
    changes.push({
      area: "https",
      previous: previous.https.status,
      current: current.https.status,
      message: `HTTPS reachability changed from ${previous.https.status} to ${current.https.status}.`,
    });
  if (previous.tls.handshake !== current.tls.handshake)
    changes.push({
      area: "tls",
      previous: previous.tls.handshake,
      current: current.tls.handshake,
      message: `TLS handshake changed from ${previous.tls.handshake} to ${current.tls.handshake}.`,
    });
  return changes;
}
