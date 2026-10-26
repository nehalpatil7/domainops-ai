import { DurableObject } from "cloudflare:workers";
import { toBackendError } from "../domain/errors";
import { DomainRepository } from "../domain/repository";
import { DomainService } from "../domain/service";
import type {
  BackendResult,
  DiagnosticHistoryItem,
  Domain,
  LiveDiagnosticRun,
  PrepareLiveDiagnosticResult,
  RegisterDomainInput,
  RegisterDomainResult,
} from "../domain/types";

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
  getDiagnosticHistory(
    workspaceId: string,
    domainId: string,
  ): BackendResult<DiagnosticHistoryItem[]> {
    return this.execute(workspaceId, (service) => service.getDiagnosticHistory(domainId));
  }
  registerDomain(
    workspaceId: string,
    input: RegisterDomainInput | unknown,
    key: string,
  ): BackendResult<RegisterDomainResult> {
    return this.execute(workspaceId, (service) => service.registerDomain(input, key));
  }
  prepareDiagnostic(
    workspaceId: string,
    domainId: string,
    key: string,
  ): BackendResult<PrepareLiveDiagnosticResult> {
    return this.execute(workspaceId, (service) => service.prepareDiagnostic(domainId, key));
  }
  completeDiagnostic(
    workspaceId: string,
    domainId: string,
    key: string,
    requestId: string,
    result: LiveDiagnosticRun,
  ): BackendResult<LiveDiagnosticRun> {
    return this.execute(workspaceId, (service) =>
      service.completeDiagnostic(domainId, key, requestId, result),
    );
  }
  failDiagnostic(
    workspaceId: string,
    domainId: string,
    key: string,
    requestId: string,
  ): BackendResult<void> {
    return this.execute(workspaceId, (service) => service.failDiagnostic(domainId, key, requestId));
  }

  private execute<T>(workspaceId: string, action: (service: DomainService) => T): BackendResult<T> {
    try {
      return { ok: true, value: action(new DomainService(this.repository, workspaceId)) };
    } catch (cause) {
      return { ok: false, error: toBackendError(cause) };
    }
  }
}
