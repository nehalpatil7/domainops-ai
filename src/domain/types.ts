export const liveDnsRecordTypes = ["A", "AAAA", "CNAME", "TXT", "CAA"] as const;
export type LiveDnsRecordType = (typeof liveDnsRecordTypes)[number];
export type DomainHealth = "healthy" | "needs_attention" | "checking" | "unknown";

export type Domain = {
  id: string;
  workspaceId: string;
  hostname: string;
  createdAt: string;
  updatedAt: string;
  healthStatus: DomainHealth;
  lastCheckedAt: string | null;
  checkDurationMs: number | null;
  latestDiagnostic: LiveDiagnosticRun | null;
};

export type RegisterDomainInput = { hostname: string };
export type RegisterDomainResult = { domain: Domain; duplicate: boolean };

export type LiveDnsRecord = { type: LiveDnsRecordType; name: string; value: string; ttl: number };
export type LiveDnsQuery = {
  type: LiveDnsRecordType;
  status: "success" | "no_records" | "error" | "timeout";
  responseCode: number | null;
  responseCodeName: string | null;
  records: LiveDnsRecord[];
  error: string | null;
};
export type LiveHttpsObservation = {
  status: "reachable" | "unreachable" | "skipped";
  url: string;
  statusCode: number | null;
  responseTimeMs: number | null;
  redirectLocation: string | null;
  headers: Record<string, string>;
  error: string | null;
};
export type LiveTlsObservation = {
  handshake: "succeeded" | "failed" | "not_attempted";
  certificateMetadataAvailable: false;
  limitation: string;
};
export type LiveDiagnosticRun = {
  id: string;
  workspaceId: string;
  domainId: string;
  hostname: string;
  source: "live_public";
  status: "healthy" | "degraded" | "failed";
  observedAt: string;
  completedAt: string;
  durationMs: number;
  dnsProvider: "Cloudflare DNS over HTTPS";
  dns: LiveDnsQuery[];
  publicAddresses: string[];
  safety: { allowed: boolean; blockedAddresses: string[]; reason: string | null };
  https: LiveHttpsObservation;
  tls: LiveTlsObservation;
  findings: string[];
  limitations: string[];
};

export type DiagnosticChange = {
  area: "overall" | "dns" | "https" | "tls";
  previous: string;
  current: string;
  message: string;
};
export type DiagnosticHistoryItem = LiveDiagnosticRun & { changes: DiagnosticChange[] };
export type PrepareLiveDiagnosticResult = {
  domain: Domain;
  requestId: string;
  duplicate: boolean;
  shouldRun: boolean;
  existingRun: LiveDiagnosticRun | null;
};
export type Workspace = { id: string; name: string; createdAt: string; updatedAt: string };
export type BackendErrorPayload = {
  code: string;
  message: string;
  status: number;
  details?: Record<string, string | number | boolean | string[] | null>;
};
export type BackendResult<T> = { ok: true; value: T } | { ok: false; error: BackendErrorPayload };
