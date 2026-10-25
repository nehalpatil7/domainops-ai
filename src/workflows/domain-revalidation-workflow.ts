import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { evaluateRevalidation } from "../domain/simulation";
import type { Domain, RevalidationWorkflowParams } from "../domain/types";

export class DomainRevalidationWorkflow extends WorkflowEntrypoint<
  Env,
  RevalidationWorkflowParams
> {
  async run(event: WorkflowEvent<RevalidationWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const outcome = await step.do("evaluate-simulated-provider-state", async () =>
      evaluateRevalidation(params.hostname, params.profile, params.attempt),
    );

    await step.sleep("simulated-provider-latency", "1 second");

    const result = await step.do("persist-validation-result", async () => {
      const id = this.env.WorkspaceDomainStore.idFromName(params.workspaceId);
      const store = this.env.WorkspaceDomainStore.get(id);
      const rpcResult = await store.applyRevalidationResult(
        params.workspaceId,
        params.domainId,
        params.workflowId,
        params.attempt,
        outcome,
      );
      if (!rpcResult.ok) throw new Error(`${rpcResult.error.code}: ${rpcResult.error.message}`);
      const plainDomain: Domain = rpcResult.value;
      return plainDomain;
    });

    return {
      domainId: params.domainId,
      workflowId: params.workflowId,
      attempt: params.attempt,
      outcome,
      domain: result,
    };
  }
}
