import { routeAgentRequest } from "agents";
import { handleDomainApi } from "./api/domain-api";

export { DomainOpsChatAgent } from "./agent/domain-ops-chat-agent";
export { WorkspaceDomainStore } from "./durable-object/workspace-domain-store";
export { DomainRevalidationWorkflow } from "./workflows/domain-revalidation-workflow";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        service: "domainops-ai",
        status: "ok",
        provider: "simulation",
      });
    }

    if (url.pathname.startsWith("/api/workspaces/")) {
      return handleDomainApi(request, env);
    }

    if (url.pathname.startsWith("/agents/")) {
      const agentResponse = await routeAgentRequest(request, env);
      if (agentResponse) return agentResponse;
    }

    return Response.json(
      { error: { code: "ROUTE_NOT_FOUND", message: "Route not found." } },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
