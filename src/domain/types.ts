export const simulationScenarios = [
  "healthy",
  "missing_cname",
  "pending_hostname",
  "certificate_error",
] as const;

export type SimulationScenario = (typeof simulationScenarios)[number];
export type DnsStatus = "pending" | "valid" | "invalid";
export type HostnameStatus = "pending" | "active" | "error";
export type CertificateStatus = "pending" | "active" | "error";
export type ValidationPhase = "dns" | "hostname" | "certificate";

export type DomainStatuses = {
  dnsStatus: DnsStatus;
  hostnameStatus: HostnameStatus;
  certificateStatus: CertificateStatus;
};

export type DomainRecord = DomainStatuses & {
  id: string;
  hostname: string;
  scenario: SimulationScenario;
  activeWorkflowId: string | null;
  source: "simulation";
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  ready: boolean;
};

export type DomainStatusEvent = {
  id: string;
  domainId: string;
  category: "dns" | "hostname" | "certificate" | "workflow";
  previousStatus: string | null;
  nextStatus: string;
  reason: string;
  source: "simulation" | "system" | "user";
  workflowId: string | null;
  createdAt: string;
};

export type RegisterDomainInput = {
  hostname: string;
  scenario: SimulationScenario;
};

export type DomainInspection = {
  domain: DomainRecord;
  history: DomainStatusEvent[];
};

export type WorkflowProgress = {
  workflowId: string;
  status: "running" | "complete" | "error";
  step: string;
  message: string;
  percent: number;
};

export type DomainOpsState = {
  revision: number;
  workflowProgress: Record<string, WorkflowProgress>;
};
