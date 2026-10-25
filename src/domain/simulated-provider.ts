import type { DomainStatuses, SimulationScenario, ValidationPhase } from "./types";

export type SimulationResult = {
  phase: ValidationPhase;
  statuses: DomainStatuses;
  message: string;
  terminal: boolean;
  ready: boolean;
};

const pending: DomainStatuses = {
  dnsStatus: "pending",
  hostnameStatus: "pending",
  certificateStatus: "pending",
};

export function simulateValidationPhase(
  scenario: SimulationScenario,
  phase: ValidationPhase,
): SimulationResult {
  if (phase === "dns") {
    if (scenario === "missing_cname") {
      return {
        phase,
        statuses: { ...pending, dnsStatus: "invalid" },
        message: "Expected CNAME record was not found.",
        terminal: true,
        ready: false,
      };
    }

    return {
      phase,
      statuses: { ...pending, dnsStatus: "valid" },
      message: "DNS target matches the simulated SaaS CNAME.",
      terminal: false,
      ready: false,
    };
  }

  if (phase === "hostname") {
    if (scenario === "pending_hostname") {
      return {
        phase,
        statuses: { ...pending, dnsStatus: "valid" },
        message: "DNS is valid, but hostname activation is still pending.",
        terminal: true,
        ready: false,
      };
    }

    return {
      phase,
      statuses: {
        dnsStatus: "valid",
        hostnameStatus: "active",
        certificateStatus: "pending",
      },
      message: "Hostname ownership is validated and activation is complete.",
      terminal: false,
      ready: false,
    };
  }

  if (scenario === "certificate_error") {
    return {
      phase,
      statuses: {
        dnsStatus: "valid",
        hostnameStatus: "active",
        certificateStatus: "error",
      },
      message: "Certificate issuance failed in the simulated provider.",
      terminal: true,
      ready: false,
    };
  }

  return {
    phase,
    statuses: {
      dnsStatus: "valid",
      hostnameStatus: "active",
      certificateStatus: "active",
    },
    message: "Certificate is issued and the custom hostname is ready.",
    terminal: true,
    ready: true,
  };
}
