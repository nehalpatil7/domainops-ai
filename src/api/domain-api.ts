import { DomainError, toBackendError } from "../domain/errors";
import {
  validateDomainId,
  validateIdempotencyKey,
  validateWorkspaceId,
} from "../domain/validation";
import { runPersistedDiagnostic, unwrap } from "../live/persisted-diagnostic";

export async function handleDomainApi(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "api" || segments[1] !== "workspaces")
      throw new DomainError("ROUTE_NOT_FOUND", "API route not found.", 404);
    const catalog = env.WorkspaceCatalog.get(env.WorkspaceCatalog.idFromName("global"));

    if (!segments[2]) {
      if (request.method === "GET") return success(unwrap(await catalog.list()), requestId);
      if (request.method === "POST") {
        const body = await readJson(request);
        return success(
          unwrap(await catalog.create((body as Record<string, unknown>).name)),
          requestId,
          201,
        );
      }
      throw new DomainError("METHOD_NOT_ALLOWED", "Method is not supported for this route.", 405);
    }

    const workspaceId = validateWorkspaceId(segments[2]);
    if (!segments[3]) {
      if (request.method === "PATCH") {
        const body = await readJson(request);
        return success(
          unwrap(await catalog.rename(workspaceId, (body as Record<string, unknown>).name)),
          requestId,
        );
      }
      throw new DomainError("METHOD_NOT_ALLOWED", "Method is not supported for this route.", 405);
    }
    if (segments[3] !== "domains")
      throw new DomainError("ROUTE_NOT_FOUND", "API route not found.", 404);
    unwrap(await catalog.ensure(workspaceId));
    const store = env.WorkspaceDomainStore.get(env.WorkspaceDomainStore.idFromName(workspaceId));
    const domainId = segments[4];
    const action = segments[5];

    if (!domainId && request.method === "GET")
      return success(unwrap(await store.listDomains(workspaceId)), requestId, 200, workspaceId);
    if (!domainId && request.method === "POST") {
      const key = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
      const result = unwrap(await store.registerDomain(workspaceId, await readJson(request), key));
      return success(result, requestId, result.duplicate ? 200 : 201, workspaceId);
    }
    if (!domainId) throw new DomainError("ROUTE_NOT_FOUND", "API route not found.", 404);
    validateDomainId(domainId);
    if (!action && request.method === "GET")
      return success(
        unwrap(await store.getDomain(workspaceId, domainId)),
        requestId,
        200,
        workspaceId,
      );
    if ((action === "diagnostics" || action === "live-diagnostics") && request.method === "GET") {
      return success(
        unwrap(await store.getDiagnosticHistory(workspaceId, domainId)),
        requestId,
        200,
        workspaceId,
      );
    }
    if ((action === "diagnostics" || action === "live-diagnostics") && request.method === "POST") {
      const key = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
      const result = await runPersistedDiagnostic(store, workspaceId, domainId, key);
      return success(result, requestId, result.run ? 200 : 202, workspaceId);
    }
    throw new DomainError("METHOD_NOT_ALLOWED", "Method is not supported for this route.", 405);
  } catch (cause) {
    const error = toBackendError(cause);
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
        requestId,
      },
      { status: error.status },
    );
  }
}

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
    throw DomainError.invalid("Content-Type must be application/json.");
  try {
    return await request.json();
  } catch {
    throw DomainError.invalid("Request body contains invalid JSON.");
  }
}
function success(data: unknown, requestId: string, status = 200, workspaceId?: string): Response {
  return Response.json(
    { data, meta: { ...(workspaceId ? { workspaceId } : {}), source: "live_public", requestId } },
    { status },
  );
}
