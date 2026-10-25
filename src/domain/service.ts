import { DomainError } from "./errors";
import { DomainRepository, type NewDomain } from "./repository";
import { initialSimulationState } from "./simulation";
import type {
  BeginRevalidationResult,
  DiagnosticEvent,
  DnsAssessment,
  DnsRecord,
  Domain,
  RegisterDomainInput,
  RegisterDomainResult,
  RevalidationOutcome,
  SimulationProfile,
} from "./types";
import {
  parseRegisterDomainInput,
  validateDomainId,
  validateIdempotencyKey,
  validateWorkspaceId,
} from "./validation";

const seededDomains: Array<{ hostname: string; profile: SimulationProfile }> = [
  { hostname: "active.demo.example", profile: "active" },
  { hostname: "incorrect-dns.demo.example", profile: "incorrect_dns" },
  { hostname: "pending-ssl.demo.example", profile: "pending_ssl" },
  { hostname: "validation-failure.demo.example", profile: "validation_failure" },
];

type StoredRegistration = { domainId: string };
type StoredRevalidation = { domainId: string; workflowId: string; attempt: number };

export class DomainService {
  constructor(
    private readonly repository: DomainRepository,
    private readonly workspaceId: string,
  ) {
    validateWorkspaceId(workspaceId);
    repository.ensureSchema();
    repository.bindWorkspace(workspaceId);
    this.seedDemoDomains();
  }

  listDomains(): Domain[] {
    return this.repository.listDomains(this.workspaceId);
  }

  getDomain(domainId: string): Domain {
    validateDomainId(domainId);
    return this.getDomainOrThrow(domainId);
  }

  getHistory(domainId: string): DiagnosticEvent[] {
    const domain = this.getDomain(domainId);
    return this.repository.listEvents(this.workspaceId, domain.id);
  }

  assessDns(domainId: string): DnsAssessment {
    const domain = this.getDomain(domainId);
    const matchingRecords = domain.expectedDnsRecords.filter((expected) =>
      domain.observedDnsRecords.some((observed) => recordsEqual(expected, observed)),
    );
    const missingRecords = domain.expectedDnsRecords.filter(
      (expected) => !domain.observedDnsRecords.some((observed) => recordsEqual(expected, observed)),
    );
    const unexpectedRecords = domain.observedDnsRecords.filter(
      (observed) => !domain.expectedDnsRecords.some((expected) => recordsEqual(expected, observed)),
    );

    return {
      domainId: domain.id,
      hostname: domain.hostname,
      source: "simulation",
      expectedRecords: domain.expectedDnsRecords,
      observedRecords: domain.observedDnsRecords,
      matchingRecords,
      missingRecords,
      unexpectedRecords,
      requiredValidationRecords: domain.requiredValidationRecords,
      dnsStatus: domain.dnsStatus,
      hostnameStatus: domain.hostnameStatus,
      sslStatus: domain.sslStatus,
      validationState: domain.validationState,
      ready: domain.ready,
    };
  }

  registerDomain(
    input: RegisterDomainInput | unknown,
    idempotencyKey: string,
  ): RegisterDomainResult {
    const key = validateIdempotencyKey(idempotencyKey);
    const parsed = parseRegisterDomainInput(input);
    const requestJson = JSON.stringify(parsed);
    const stored = this.repository.getIdempotency<StoredRegistration>(
      this.workspaceId,
      key,
      "register_domain",
      requestJson,
    );
    if (stored) {
      return { domain: this.getDomainOrThrow(stored.domainId), duplicate: true };
    }

    if (this.repository.getDomainByHostname(this.workspaceId, parsed.hostname)) {
      throw DomainError.conflict(
        "DOMAIN_ALREADY_EXISTS",
        "Hostname is already registered in this workspace.",
        {
          hostname: parsed.hostname,
        },
      );
    }

    const now = new Date().toISOString();
    const state = initialSimulationState(
      parsed.hostname,
      parsed.expectedDnsTarget,
      parsed.simulationProfile,
      parsed.observedDnsRecord,
    );
    const domain: NewDomain = {
      id: crypto.randomUUID(),
      workspaceId: this.workspaceId,
      hostname: parsed.hostname,
      expectedDnsTarget: parsed.expectedDnsTarget,
      ...state,
      source: "simulation",
      simulationProfile: parsed.simulationProfile,
      createdAt: now,
      updatedAt: now,
      lastValidationAttemptAt: null,
      retryCount: 0,
      lastAppliedAttempt: 0,
      activeValidationId: null,
    };
    this.repository.insertDomain(domain);
    this.repository.insertEvent({
      workspaceId: this.workspaceId,
      domainId: domain.id,
      eventType: "domain_registered",
      category: "domain",
      previousValue: null,
      nextValue: "registered",
      diagnosticCode: "DOMAIN_REGISTERED",
      message: "Domain registered with deterministic simulated provider state.",
      metadata: {
        simulationProfile: domain.simulationProfile,
        expectedDnsTarget: domain.expectedDnsTarget,
      },
      validationId: null,
      attempt: null,
      source: "user",
      createdAt: now,
      dedupeKey: `register:${domain.id}`,
    });
    this.repository.putIdempotency(
      this.workspaceId,
      key,
      "register_domain",
      requestJson,
      { domainId: domain.id },
      now,
    );
    return { domain: this.getDomainOrThrow(domain.id), duplicate: false };
  }

  beginRevalidation(domainId: string, idempotencyKey: string): BeginRevalidationResult {
    validateDomainId(domainId);
    const key = validateIdempotencyKey(idempotencyKey);
    const requestJson = JSON.stringify({ domainId });
    const stored = this.repository.getIdempotency<StoredRevalidation>(
      this.workspaceId,
      key,
      "revalidate_domain",
      requestJson,
    );
    if (stored) {
      return {
        domain: this.getDomainOrThrow(stored.domainId),
        workflowId: stored.workflowId,
        attempt: stored.attempt,
        duplicate: true,
        shouldStart: false,
      };
    }

    const domain = this.getDomainOrThrow(domainId);
    if (domain.activeValidationId) {
      throw DomainError.conflict(
        "VALIDATION_IN_PROGRESS",
        "A validation is already running for this domain.",
        {
          validationId: domain.activeValidationId,
        },
      );
    }

    const now = new Date().toISOString();
    const attempt = domain.retryCount + 1;
    const workflowId = `revalidate_${crypto.randomUUID().replaceAll("-", "")}_${attempt}`;
    this.repository.startValidation(this.workspaceId, domain.id, workflowId, attempt, now);
    this.repository.insertEvent({
      workspaceId: this.workspaceId,
      domainId: domain.id,
      eventType: "validation_started",
      category: "validation",
      previousValue: domain.validationState,
      nextValue: "checking",
      diagnosticCode: "VALIDATION_STARTED",
      message: "Deterministic simulated revalidation started.",
      metadata: { profile: domain.simulationProfile },
      validationId: workflowId,
      attempt,
      source: "user",
      createdAt: now,
      dedupeKey: `${workflowId}:started`,
    });
    this.repository.putIdempotency(
      this.workspaceId,
      key,
      "revalidate_domain",
      requestJson,
      { domainId: domain.id, workflowId, attempt },
      now,
    );

    return {
      domain: this.getDomainOrThrow(domain.id),
      workflowId,
      attempt,
      duplicate: false,
      shouldStart: true,
    };
  }

  applyRevalidationResult(
    domainId: string,
    validationId: string,
    attempt: number,
    outcome: RevalidationOutcome,
  ): Domain {
    const before = this.getDomain(domainId);
    if (before.lastAppliedAttempt >= attempt || before.activeValidationId !== validationId)
      return before;

    const now = new Date().toISOString();
    const applied = this.repository.applyOutcome(
      this.workspaceId,
      before.id,
      validationId,
      attempt,
      outcome,
      now,
    );
    if (!applied) return this.getDomainOrThrow(before.id);

    this.recordStatusChange(
      before,
      "dns",
      before.dnsStatus,
      outcome.dnsStatus,
      outcome,
      validationId,
      attempt,
      now,
    );
    this.recordStatusChange(
      before,
      "hostname",
      before.hostnameStatus,
      outcome.hostnameStatus,
      outcome,
      validationId,
      attempt,
      now,
    );
    this.recordStatusChange(
      before,
      "ssl",
      before.sslStatus,
      outcome.sslStatus,
      outcome,
      validationId,
      attempt,
      now,
    );
    this.recordStatusChange(
      before,
      "validation",
      "checking",
      outcome.validationState,
      outcome,
      validationId,
      attempt,
      now,
    );
    this.repository.insertEvent({
      workspaceId: this.workspaceId,
      domainId: before.id,
      eventType:
        outcome.validationState === "failed" ? "validation_failed" : "validation_completed",
      category: "workflow",
      previousValue: "running",
      nextValue: "complete",
      diagnosticCode: outcome.diagnosticCode,
      message: outcome.message,
      metadata: { simulated: true },
      validationId,
      attempt,
      source: "simulation",
      createdAt: now,
      dedupeKey: `${validationId}:completed`,
    });
    return this.getDomainOrThrow(before.id);
  }

  failRevalidationStart(
    domainId: string,
    validationId: string,
    attempt: number,
    message: string,
  ): Domain {
    const domain = this.getDomain(domainId);
    const now = new Date().toISOString();
    if (this.repository.failValidationStart(this.workspaceId, domain.id, validationId, now)) {
      this.repository.insertEvent({
        workspaceId: this.workspaceId,
        domainId: domain.id,
        eventType: "validation_failed",
        category: "workflow",
        previousValue: "starting",
        nextValue: "failed",
        diagnosticCode: "WORKFLOW_START_FAILED",
        message,
        metadata: {},
        validationId,
        attempt,
        source: "system",
        createdAt: now,
        dedupeKey: `${validationId}:start-failed`,
      });
    }
    return this.getDomainOrThrow(domain.id);
  }

  private recordStatusChange(
    domain: Domain,
    category: "dns" | "hostname" | "ssl" | "validation",
    previousValue: string,
    nextValue: string,
    outcome: RevalidationOutcome,
    validationId: string,
    attempt: number,
    timestamp: string,
  ): void {
    if (previousValue === nextValue) return;
    this.repository.insertEvent({
      workspaceId: this.workspaceId,
      domainId: domain.id,
      eventType: "status_changed",
      category,
      previousValue,
      nextValue,
      diagnosticCode: outcome.diagnosticCode,
      message: outcome.message,
      metadata: { simulated: true },
      validationId,
      attempt,
      source: "simulation",
      createdAt: timestamp,
      dedupeKey: `${validationId}:status:${category}`,
    });
  }

  private seedDemoDomains(): void {
    const target = "customers.domainops.example";
    for (const [index, seed] of seededDomains.entries()) {
      if (this.repository.getDomainByHostname(this.workspaceId, seed.hostname)) continue;
      const now = new Date(Date.now() + index).toISOString();
      const state = initialSimulationState(seed.hostname, target, seed.profile);
      const domain: NewDomain = {
        id: crypto.randomUUID(),
        workspaceId: this.workspaceId,
        hostname: seed.hostname,
        expectedDnsTarget: target,
        ...state,
        source: "simulation",
        simulationProfile: seed.profile,
        createdAt: now,
        updatedAt: now,
        lastValidationAttemptAt: null,
        retryCount: 0,
        lastAppliedAttempt: 0,
        activeValidationId: null,
      };
      this.repository.insertDomain(domain);
      this.repository.insertEvent({
        workspaceId: this.workspaceId,
        domainId: domain.id,
        eventType: "domain_registered",
        category: "domain",
        previousValue: null,
        nextValue: "seeded",
        diagnosticCode: "DEMO_DOMAIN_SEEDED",
        message: `Seeded ${seed.profile.replaceAll("_", " ")} simulated domain.`,
        metadata: { simulationProfile: seed.profile },
        validationId: null,
        attempt: null,
        source: "system",
        createdAt: now,
        dedupeKey: `seed:${this.workspaceId}:${seed.hostname}`,
      });
    }
  }

  private getDomainOrThrow(domainId: string): Domain {
    const domain = this.repository.getDomain(this.workspaceId, domainId);
    if (!domain) throw DomainError.notFound();
    return domain;
  }
}

function recordsEqual(left: DnsRecord, right: DnsRecord): boolean {
  return left.type === right.type && left.name === right.name && left.value === right.value;
}
