import { DurableObject } from "cloudflare:workers";
import { DomainRepository } from "../domain/repository";
import { DomainService } from "../domain/service";
import type {
  BackendResult,
  BeginRevalidationResult,
  DiagnosticEvent,
  DnsAssessment,
  Domain,
  LiveDiagnosticRun,
  PrepareLiveDiagnosticResult,
  RegisterDomainInput,
  RegisterDomainResult,
  RevalidationOutcome,
} from "../domain/types";
import { toBackendError } from "../domain/errors";

export class WorkspaceDomainStore extends DurableObject<Env> {
  private readonly repository: DomainRepository;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.repository = new DomainRepository(ctx.storage.sql);
  }

  listDomains(workspaceId: string): BackendResult<Domain[]> {
    return this.execute(workspaceId, (service) => service.listDomains());
  }

  getDomain(workspaceId: string, domainId: string): BackendResult<Domain> {
    return this.execute(workspaceId, (service) => service.getDomain(domainId));
  }

  getDnsAssessment(workspaceId: string, domainId: string): BackendResult<DnsAssessment> {
    return this.execute(workspaceId, (service) => service.assessDns(domainId));
  }

  getHistory(workspaceId: string, domainId: string): BackendResult<DiagnosticEvent[]> {
    return this.execute(workspaceId, (service) => service.getHistory(domainId));
  }

  getLiveDiagnosticHistory(
    workspaceId: string,
    domainId: string,
  ): BackendResult<LiveDiagnosticRun[]> {
    return this.execute(workspaceId, (service) => service.getLiveDiagnosticHistory(domainId));
  }

  prepareLiveDiagnostic(
    workspaceId: string,
    domainId: string,
    idempotencyKey: string,
  ): BackendResult<PrepareLiveDiagnosticResult> {
    return this.execute(workspaceId, (service) =>
      service.prepareLiveDiagnostic(domainId, idempotencyKey),
    );
  }

  completeLiveDiagnostic(
    workspaceId: string,
    domainId: string,
    idempotencyKey: string,
    requestId: string,
    result: LiveDiagnosticRun,
  ): BackendResult<LiveDiagnosticRun> {
    return this.execute(workspaceId, (service) =>
      service.completeLiveDiagnostic(domainId, idempotencyKey, requestId, result),
    );
  }

  failLiveDiagnostic(
    workspaceId: string,
    domainId: string,
    idempotencyKey: string,
    requestId: string,
  ): BackendResult<void> {
    return this.execute(workspaceId, (service) =>
      service.failLiveDiagnostic(domainId, idempotencyKey, requestId),
    );
  }

  registerDomain(
    workspaceId: string,
    input: RegisterDomainInput | unknown,
    idempotencyKey: string,
  ): BackendResult<RegisterDomainResult> {
    return this.execute(workspaceId, (service) => service.registerDomain(input, idempotencyKey));
  }

  beginRevalidation(
    workspaceId: string,
    domainId: string,
    idempotencyKey: string,
  ): BackendResult<BeginRevalidationResult> {
    return this.execute(workspaceId, (service) =>
      service.beginRevalidation(domainId, idempotencyKey),
    );
  }

  applyRevalidationResult(
    workspaceId: string,
    domainId: string,
    validationId: string,
    attempt: number,
    outcome: RevalidationOutcome,
  ): BackendResult<Domain> {
    return this.execute(workspaceId, (service) =>
      service.applyRevalidationResult(domainId, validationId, attempt, outcome),
    );
  }

  failRevalidationStart(
    workspaceId: string,
    domainId: string,
    validationId: string,
    attempt: number,
    message: string,
  ): BackendResult<Domain> {
    return this.execute(workspaceId, (service) =>
      service.failRevalidationStart(domainId, validationId, attempt, message),
    );
  }

  private execute<T>(workspaceId: string, action: (service: DomainService) => T): BackendResult<T> {
    try {
      return { ok: true, value: action(new DomainService(this.repository, workspaceId)) };
    } catch (cause) {
      return { ok: false, error: toBackendError(cause) };
    }
  }
}
