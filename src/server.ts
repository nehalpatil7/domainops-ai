import { handleDomainApi } from "./api/domain-api";

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

    return Response.json(
      { error: { code: "ROUTE_NOT_FOUND", message: "Route not found." } },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
