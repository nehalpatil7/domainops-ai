import { DomainError } from "../domain/errors";
import type {
  BackendResult,
  LiveDiagnosticRun,
  PrepareLiveDiagnosticResult,
} from "../domain/types";
import { runLiveDiagnostics } from "./live-diagnostics";

export interface DiagnosticStore {
  prepareDiagnostic(
    workspaceId: string,
    domainId: string,
    key: string,
  ): Promise<BackendResult<PrepareLiveDiagnosticResult>>;
  completeDiagnostic(
    workspaceId: string,
    domainId: string,
    key: string,
    requestId: string,
    run: LiveDiagnosticRun,
  ): Promise<BackendResult<LiveDiagnosticRun>>;
  failDiagnostic(
    workspaceId: string,
    domainId: string,
    key: string,
    requestId: string,
  ): Promise<BackendResult<void>>;
}

export async function runPersistedDiagnostic(
  store: DiagnosticStore,
  workspaceId: string,
  domainId: string,
  key: string,
): Promise<{ run: LiveDiagnosticRun | null; pending: boolean; cached: boolean }> {
  const preparation = unwrap(await store.prepareDiagnostic(workspaceId, domainId, key));
  if (!preparation.shouldRun)
    return {
      run: preparation.existingRun,
      pending: preparation.existingRun === null,
      cached: preparation.existingRun !== null,
    };
  try {
    const observed = await runLiveDiagnostics(preparation.domain.hostname, {
      requestId: preparation.requestId,
    });
    const run = unwrap(
      await store.completeDiagnostic(workspaceId, domainId, key, preparation.requestId, observed),
    );
    return { run, pending: false, cached: false };
  } catch (cause) {
    await store.failDiagnostic(workspaceId, domainId, key, preparation.requestId);
    if (cause instanceof DomainError) throw cause;
    throw new DomainError(
      "DIAGNOSTIC_FAILED",
      "The public diagnostic check could not be completed.",
      502,
    );
  }
}

export function unwrap<T>(result: BackendResult<T>): T {
  if (result.ok) return result.value;
  throw new DomainError(
    result.error.code,
    result.error.message,
    result.error.status,
    result.error.details,
  );
}
