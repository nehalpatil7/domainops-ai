import { routeAgentRequest } from "agents";

export { DomainOpsAgent } from "./agent/domain-ops-agent";
export { DomainValidationWorkflow } from "./workflows/domain-validation-workflow";

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

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
