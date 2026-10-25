export const simulationProfiles = [
  "active",
  "incorrect_dns",
  "pending_ssl",
  "validation_failure",
] as const;

export type SimulationProfile = (typeof simulationProfiles)[number];
export type DnsStatus = "pending" | "valid" | "invalid";
export type HostnameStatus = "pending" | "active" | "blocked" | "moved" | "deleted";
export type SslStatus =
  | "initializing"
  | "pending_validation"
  | "pending_issuance"
  | "pending_deployment"
  | "active"
  | "validation_timed_out"
  | "issuance_timed_out"
  | "deployment_timed_out"
  | "failed";
export type ValidationState =
  | "pending"
  | "checking"
  | "dns_misconfigured"
  | "pending_hostname"
  | "pending_ssl"
  | "active"
  | "failed";

export type DnsRecord = {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  ttl: number;
};

export type ValidationRecord = {
  purpose: "hostname_ownership" | "certificate";
  type: "TXT" | "HTTP";
  name: string;
  value: string;
  status: "pending" | "valid" | "failed";
};

export type Domain = {
  id: string;
  workspaceId: string;
  hostname: string;
  expectedDnsTarget: string;
  expectedDnsRecords: DnsRecord[];
  observedDnsRecords: DnsRecord[];
  dnsStatus: DnsStatus;
  hostnameStatus: HostnameStatus;
  sslStatus: SslStatus;
  requiredValidationRecords: ValidationRecord[];
  validationState: ValidationState;
  source: "simulation";
  simulationProfile: SimulationProfile;
  createdAt: string;
  updatedAt: string;
  lastValidationAttemptAt: string | null;
  retryCount: number;
  lastAppliedAttempt: number;
  activeValidationId: string | null;
  ready: boolean;
};

export type DiagnosticEvent = {
  id: string;
  workspaceId: string;
  domainId: string;
  eventType:
    | "domain_registered"
    | "validation_started"
    | "status_changed"
    | "validation_completed"
    | "validation_failed";
  category: "domain" | "dns" | "hostname" | "ssl" | "validation" | "workflow";
  previousValue: string | null;
  nextValue: string | null;
  diagnosticCode: string;
  message: string;
  metadata: Record<string, unknown>;
  validationId: string | null;
  attempt: number | null;
  source: "simulation" | "system" | "user";
  createdAt: string;
};

export type RegisterDomainInput = {
  hostname: string;
  expectedDnsTarget?: string;
  observedDnsRecord?: string | null;
  simulationProfile?: SimulationProfile;
};

export type RegisterDomainResult = {
  domain: Domain;
  duplicate: boolean;
};

export type DnsAssessment = {
  domainId: string;
  hostname: string;
  source: "simulation";
  expectedRecords: DnsRecord[];
  observedRecords: DnsRecord[];
  matchingRecords: DnsRecord[];
  missingRecords: DnsRecord[];
  unexpectedRecords: DnsRecord[];
  requiredValidationRecords: ValidationRecord[];
  dnsStatus: DnsStatus;
  hostnameStatus: HostnameStatus;
  sslStatus: SslStatus;
  validationState: ValidationState;
  ready: boolean;
};

export type BeginRevalidationResult = {
  domain: Domain;
  workflowId: string;
  attempt: number;
  duplicate: boolean;
  shouldStart: boolean;
};

export type RevalidationOutcome = {
  dnsStatus: DnsStatus;
  hostnameStatus: HostnameStatus;
  sslStatus: SslStatus;
  validationState: ValidationState;
  requiredValidationRecords: ValidationRecord[];
  diagnosticCode: string;
  message: string;
};

export type RevalidationWorkflowParams = {
  workspaceId: string;
  domainId: string;
  workflowId: string;
  attempt: number;
  profile: SimulationProfile;
  hostname: string;
};

export type BackendErrorPayload = {
  code: string;
  message: string;
  status: number;
  details?: Record<string, string | number | boolean | string[] | null>;
};

export type BackendResult<T> = { ok: true; value: T } | { ok: false; error: BackendErrorPayload };
