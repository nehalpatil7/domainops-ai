import {
  liveDnsRecordTypes,
  type LiveDiagnosticRun,
  type LiveDnsQuery,
  type LiveDnsRecord,
  type LiveDnsRecordType,
  type LiveHttpsObservation,
} from "../domain/types";
import { isPublicIpAddress, validateLiveHostname } from "./network-safety";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type DnsJsonResponse = {
  Status?: number;
  Answer?: Array<{ name?: string; type?: number; TTL?: number; data?: string }>;
};

const dnsTypeNumbers: Record<LiveDnsRecordType, number> = {
  A: 1,
  AAAA: 28,
  CNAME: 5,
  TXT: 16,
  CAA: 257,
};
const numberToDnsType = new Map(
  Object.entries(dnsTypeNumbers).map(([name, number]) => [number, name as LiveDnsRecordType]),
);
const responseCodeNames: Record<number, string> = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
};

export async function runLiveDiagnostics(
  hostnameInput: string,
  options: { fetcher?: Fetcher; now?: () => Date; requestId?: string } = {},
): Promise<LiveDiagnosticRun> {
  const hostname = validateLiveHostname(hostnameInput);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const started = now();
  const dns = await Promise.all(
    liveDnsRecordTypes.map((type) => queryDns(hostname, type, fetcher)),
  );
  const records = deduplicateRecords(dns.flatMap((query) => query.records));
  const publicAddresses = records
    .filter((record) => record.type === "A" || record.type === "AAAA")
    .map((record) => record.value);
  const blockedAddresses = publicAddresses.filter((address) => !isPublicIpAddress(address));
  const safetyAllowed = publicAddresses.length > 0 && blockedAddresses.length === 0;
  const safetyReason =
    blockedAddresses.length > 0
      ? "HTTPS probe blocked because DNS returned a non-public address."
      : publicAddresses.length === 0
        ? "HTTPS probe skipped because no public A or AAAA address was observed."
        : null;
  const https = safetyAllowed
    ? await probeHttps(hostname, fetcher)
    : skippedHttps(hostname, safetyReason!);
  const completed = now();
  const failedQueries = dns.filter(
    (query) => query.status === "error" || query.status === "timeout",
  );
  const hasDnsEvidence = dns.some((query) => query.status === "success");
  const status =
    blockedAddresses.length > 0 || (!hasDnsEvidence && https.status !== "reachable")
      ? "failed"
      : failedQueries.length > 0 || https.status !== "reachable"
        ? "degraded"
        : "healthy";
  const findings = buildFindings(dns, https, blockedAddresses);

  return {
    id: options.requestId ?? crypto.randomUUID(),
    workspaceId: "",
    domainId: "",
    hostname,
    source: "live_public",
    status,
    observedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    dnsProvider: "Cloudflare DNS over HTTPS",
    dns,
    publicAddresses,
    safety: { allowed: safetyAllowed, blockedAddresses, reason: safetyReason },
    https,
    tls: {
      handshake:
        https.status === "reachable"
          ? "succeeded"
          : https.status === "unreachable"
            ? "failed"
            : "not_attempted",
      certificateMetadataAvailable: false,
      limitation:
        "Cloudflare Workers fetch confirms whether the HTTPS/TLS request succeeded but does not expose the peer certificate chain, issuer, serial number, or expiry.",
    },
    findings,
    limitations: [
      "This is a point-in-time public observation and may vary during DNS propagation.",
      "Public diagnostics cannot reveal internal Cloudflare for SaaS hostname or certificate provisioning status.",
      "Redirects are reported but not followed for SSRF safety.",
    ],
  };
}

async function queryDns(
  hostname: string,
  type: LiveDnsRecordType,
  fetcher: Fetcher,
): Promise<LiveDnsQuery> {
  const url = new URL("https://cloudflare-dns.com/dns-query");
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return dnsFailure(type, "error", `DNS over HTTPS returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as DnsJsonResponse;
    const responseCode = typeof payload.Status === "number" ? payload.Status : null;
    const answers = (payload.Answer ?? [])
      .map(toDnsRecord)
      .filter((record): record is LiveDnsRecord => record !== null);
    const records = deduplicateRecords(answers);
    if (responseCode !== 0) {
      return {
        type,
        status: "error",
        responseCode,
        responseCodeName: responseCodeNames[responseCode ?? -1] ?? "UNKNOWN",
        records,
        error: `DNS resolver returned ${responseCodeNames[responseCode ?? -1] ?? `rcode ${responseCode}`}.`,
      };
    }
    return {
      type,
      status: records.some((record) => record.type === type) ? "success" : "no_records",
      responseCode,
      responseCodeName: "NOERROR",
      records,
      error: null,
    };
  } catch (cause) {
    const timedOut =
      cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return dnsFailure(
      type,
      timedOut ? "timeout" : "error",
      timedOut ? "DNS over HTTPS request timed out." : "DNS over HTTPS request failed.",
    );
  }
}

async function probeHttps(hostname: string, fetcher: Fetcher): Promise<LiveHttpsObservation> {
  const url = `https://${hostname}/`;
  const started = Date.now();
  try {
    const response = await fetcher(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "*/*" },
    });
    return {
      status: "reachable",
      url,
      statusCode: response.status,
      responseTimeMs: Math.max(0, Date.now() - started),
      redirectLocation: sanitizeRedirect(response.headers.get("location")),
      headers: selectedHeaders(response.headers),
      error: null,
    };
  } catch (cause) {
    const timedOut =
      cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return {
      status: "unreachable",
      url,
      statusCode: null,
      responseTimeMs: Math.max(0, Date.now() - started),
      redirectLocation: null,
      headers: {},
      error: timedOut ? "HTTPS request timed out." : "HTTPS connection or TLS handshake failed.",
    };
  }
}

function skippedHttps(hostname: string, reason: string): LiveHttpsObservation {
  return {
    status: "skipped",
    url: `https://${hostname}/`,
    statusCode: null,
    responseTimeMs: null,
    redirectLocation: null,
    headers: {},
    error: reason,
  };
}

function toDnsRecord(answer: NonNullable<DnsJsonResponse["Answer"]>[number]): LiveDnsRecord | null {
  const type = typeof answer.type === "number" ? numberToDnsType.get(answer.type) : undefined;
  if (!type || typeof answer.name !== "string" || typeof answer.data !== "string") return null;
  return {
    type,
    name: answer.name.toLowerCase().replace(/\.$/, ""),
    value: normalizeDnsValue(type, answer.data),
    ttl: typeof answer.TTL === "number" ? answer.TTL : 0,
  };
}

function normalizeDnsValue(type: LiveDnsRecordType, value: string): string {
  if (type === "CNAME") return value.toLowerCase().replace(/\.$/, "");
  if (type === "TXT") return value.replace(/^"|"$/g, "");
  return value;
}

function deduplicateRecords(records: LiveDnsRecord[]): LiveDnsRecord[] {
  return [
    ...new Map(
      records.map((record) => [`${record.type}:${record.name}:${record.value}`, record]),
    ).values(),
  ];
}

function dnsFailure(
  type: LiveDnsRecordType,
  status: "error" | "timeout",
  error: string,
): LiveDnsQuery {
  return { type, status, responseCode: null, responseCodeName: null, records: [], error };
}

function sanitizeRedirect(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of ["content-type", "server", "strict-transport-security"]) {
    const value = headers.get(name);
    if (value) selected[name] = value.slice(0, 500);
  }
  return selected;
}

function buildFindings(
  dns: LiveDnsQuery[],
  https: LiveHttpsObservation,
  blockedAddresses: string[],
): string[] {
  const findings: string[] = [];
  for (const query of dns) {
    if (query.status === "success") {
      const count = query.records.filter((record) => record.type === query.type).length;
      findings.push(`Observed ${count} public ${query.type} record(s).`);
    } else if (query.status === "error" || query.status === "timeout") {
      findings.push(`${query.type} lookup unavailable: ${query.error}`);
    }
  }
  if (blockedAddresses.length) {
    findings.push("HTTPS probe was blocked because DNS returned a non-public address.");
  } else if (https.status === "reachable") {
    findings.push(`HTTPS responded with status ${https.statusCode}; TLS handshake succeeded.`);
  } else {
    findings.push(https.error ?? "HTTPS observation was unavailable.");
  }
  return findings;
}
