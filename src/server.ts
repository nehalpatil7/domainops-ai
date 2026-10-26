import { routeAgentRequest } from "agents";
import { handleDomainApi } from "./api/domain-api";
import { DomainError, toBackendError } from "./domain/errors";
import { validateWorkspaceId } from "./domain/validation";
import { unwrap } from "./live/persisted-diagnostic";
import { authenticateRequest } from "./security/auth";

export { DomainOpsChatAgent } from "./agent/domain-ops-chat-agent";
export { WorkspaceDomainStore } from "./durable-object/workspace-domain-store";
export { WorkspaceCatalog } from "./durable-object/workspace-catalog";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        service: "domainops-ai",
        status: "ok",
        mode: "live_public",
      });
    }

    if (url.pathname === "/api/workspaces" || url.pathname.startsWith("/api/workspaces/")) {
      try {
        return handleDomainApi(request, env, await authenticateRequest(request, env));
      } catch (cause) {
        return authError(cause);
      }
    }

    if (url.pathname.startsWith("/agents/")) {
      try {
        const user = await authenticateRequest(request, env);
        const segments = url.pathname.split("/").filter(Boolean);
        const workspaceId = validateWorkspaceId(decodeURIComponent(segments[2] ?? ""));
        const catalog = env.WorkspaceCatalog.get(env.WorkspaceCatalog.idFromName("global"));
        unwrap(await catalog.authorize(user.id, workspaceId));
        const agentResponse = await routeAgentRequest(request, env);
        if (agentResponse) return agentResponse;
      } catch (cause) {
        return authError(cause);
      }
    }

    return Response.json(
      { error: { code: "ROUTE_NOT_FOUND", message: "Route not found." } },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;

function authError(cause: unknown): Response {
  const fallback = new DomainError("AUTHORIZATION_FAILED", "Authorization failed.", 403);
  const error = toBackendError(cause instanceof DomainError ? cause : fallback);
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}
