import { DomainError, toBackendError } from "../domain/errors";
import type { BackendResult } from "../domain/types";
import {
  validateDomainId,
  validateIdempotencyKey,
  validateWorkspaceId,
} from "../domain/validation";
import { runLiveDiagnostics } from "../live/live-diagnostics";

export async function handleDomainApi(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "api" || segments[1] !== "workspaces" || segments[3] !== "domains") {
      throw new DomainError("ROUTE_NOT_FOUND", "API route not found.", 404);
    }

    const workspaceId = validateWorkspaceId(segments[2] ?? "");
    const domainId = segments[4];
    const action = segments[5];
    const storeId = env.WorkspaceDomainStore.idFromName(workspaceId);
    const store = env.WorkspaceDomainStore.get(storeId);

    if (!domainId && !action && request.method === "GET") {
      const domains = unwrap(await store.listDomains(workspaceId));
      return success(domains, workspaceId, requestId);
    }

    if (!domainId && !action && request.method === "POST") {
      const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
      const body = await readJson(request);
      const result = unwrap(await store.registerDomain(workspaceId, body, idempotencyKey));
      return success(result, workspaceId, requestId, result.duplicate ? 200 : 201);
    }

    if (!domainId) throw new DomainError("ROUTE_NOT_FOUND", "API route not found.", 404);
    validateDomainId(domainId);

    if (!action && request.method === "GET") {
      return success(unwrap(await store.getDomain(workspaceId, domainId)), workspaceId, requestId);
    }
    if (action === "dns" && request.method === "GET") {
      return success(
        unwrap(await store.getDnsAssessment(workspaceId, domainId)),
        workspaceId,
        requestId,
      );
    }
    if (action === "history" && request.method === "GET") {
      return success(unwrap(await store.getHistory(workspaceId, domainId)), workspaceId, requestId);
    }
    if (action === "live-diagnostics" && request.method === "GET") {
      return success(
        unwrap(await store.getLiveDiagnosticHistory(workspaceId, domainId)),
        workspaceId,
        requestId,
        200,
        "live_public",
      );
    }
    if (action === "live-diagnostics" && request.method === "POST") {
      const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
      const preparation = unwrap(
        await store.prepareLiveDiagnostic(workspaceId, domainId, idempotencyKey),
      );
      if (!preparation.shouldRun) {
        return success(
          {
            run: preparation.existingRun,
            duplicate: preparation.duplicate,
            pending: preparation.existingRun === null,
            cached: preparation.existingRun !== null,
          },
          workspaceId,
          requestId,
          preparation.existingRun ? 200 : 202,
          "live_public",
        );
      }
      try {
        const observed = await runLiveDiagnostics(preparation.domain.hostname, {
          requestId: preparation.requestId,
        });
        const run = unwrap(
          await store.completeLiveDiagnostic(
            workspaceId,
            domainId,
            idempotencyKey,
            preparation.requestId,
            observed,
          ),
        );
        return success(
          { run, duplicate: false, pending: false, cached: false },
          workspaceId,
          requestId,
          201,
          "live_public",
        );
      } catch (cause) {
        await store.failLiveDiagnostic(
          workspaceId,
          domainId,
          idempotencyKey,
          preparation.requestId,
        );
        if (cause instanceof DomainError) throw cause;
        throw new DomainError(
          "LIVE_DIAGNOSTIC_FAILED",
          "Live diagnostics could not be completed.",
          502,
        );
      }
    }
    if (action === "revalidate" && request.method === "POST") {
      const idempotencyKey = validateIdempotencyKey(request.headers.get("Idempotency-Key"));
      const begin = unwrap(await store.beginRevalidation(workspaceId, domainId, idempotencyKey));
      if (begin.shouldStart) {
        try {
          await env.DOMAIN_REVALIDATION_WORKFLOW.create({
            id: begin.workflowId,
            params: {
              workspaceId,
              domainId,
              workflowId: begin.workflowId,
              attempt: begin.attempt,
              profile: begin.domain.simulationProfile,
              hostname: begin.domain.hostname,
            },
          });
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : "Workflow instance could not be created.";
          await store.failRevalidationStart(
            workspaceId,
            domainId,
            begin.workflowId,
            begin.attempt,
            message,
          );
          throw new DomainError(
            "WORKFLOW_START_FAILED",
            "Revalidation workflow could not be started.",
            503,
          );
        }
      }
      return success(begin, workspaceId, requestId, begin.duplicate ? 200 : 202);
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

function unwrap<T>(result: BackendResult<T>): T {
  if (!result.ok) {
    throw new DomainError(
      result.error.code,
      result.error.message,
      result.error.status,
      result.error.details,
    );
  }
  return result.value;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw DomainError.invalid("Content-Type must be application/json.");
  }
  try {
    return await request.json();
  } catch {
    throw DomainError.invalid("Request body contains invalid JSON.");
  }
}

function success(
  data: unknown,
  workspaceId: string,
  requestId: string,
  status = 200,
  source: "simulation" | "live_public" = "simulation",
): Response {
  return Response.json(
    { data, meta: { workspaceId, simulated: source === "simulation", source, requestId } },
    { status },
  );
}
