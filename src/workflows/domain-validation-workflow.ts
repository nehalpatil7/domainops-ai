import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { DomainOpsAgent } from "../agent/domain-ops-agent";
import { simulateValidationPhase } from "../domain/simulated-provider";
import type { SimulationScenario, ValidationPhase } from "../domain/types";

export type DomainValidationParams = {
  domainId: string;
  scenario: SimulationScenario;
  requestedBy: "dashboard" | "assistant";
};

type ValidationProgress = {
  step: ValidationPhase | "complete";
  status: "running" | "complete";
  percent: number;
  message: string;
};

export type DomainValidationResult = {
  domainId: string;
  ready: boolean;
  finalPhase: ValidationPhase;
  message: string;
};

const phases: ValidationPhase[] = ["dns", "hostname", "certificate"];

export class DomainValidationWorkflow extends AgentWorkflow<
  DomainOpsAgent,
  DomainValidationParams,
  ValidationProgress
> {
  async run(
    event: AgentWorkflowEvent<DomainValidationParams>,
    step: AgentWorkflowStep,
  ): Promise<DomainValidationResult> {
    const { domainId, scenario } = event.payload;

    for (const [index, phase] of phases.entries()) {
      await this.reportProgress({
        step: phase,
        status: "running",
        percent: index / phases.length,
        message: `Checking ${phase} status`,
      });

      const result = await step.do(`simulate-${phase}`, async () =>
        simulateValidationPhase(scenario, phase),
      );

      await this.agent.applySimulationResult(domainId, result, this.workflowId);

      if (result.terminal) {
        const output: DomainValidationResult = {
          domainId,
          ready: result.ready,
          finalPhase: phase,
          message: result.message,
        };

        await this.reportProgress({
          step: "complete",
          status: "complete",
          percent: 1,
          message: result.message,
        });
        await step.reportComplete(output);
        return output;
      }

      await step.sleep(`wait-after-${phase}`, "1 second");
    }

    throw new Error("Validation workflow completed without a terminal result.");
  }
}
