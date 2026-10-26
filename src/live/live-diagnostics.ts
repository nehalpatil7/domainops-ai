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
type Resolution = {
  addresses: string[];
  chain: Array<{ from: string; to: string; depth: number }>;
  error: string | null;
};

const maxCnameDepth = 4;
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
  const firstResolution = await resolveCnameChain(hostname, fetcher, dns);
  const secondResolution = await resolveCnameChain(hostname, fetcher);
  const publicAddresses = unique(firstResolution.addresses);
  const allObservedAddresses = unique([
    ...firstResolution.addresses,
    ...secondResolution.addresses,
  ]);
  const blockedAddresses = allObservedAddresses.filter((address) => !isPublicIpAddress(address));
  const resolutionStable =
    sameStrings(firstResolution.addresses, secondResolution.addresses) &&
    sameChain(firstResolution.chain, secondResolution.chain);
  const resolutionError = firstResolution.error ?? secondResolution.error;
  const safetyAllowed =
    publicAddresses.length > 0 &&
    blockedAddresses.length === 0 &&
    resolutionStable &&
    !resolutionError;
  const safetyReason = blockedAddresses.length
    ? "HTTPS probe blocked because DNS returned a non-public address."
    : resolutionError
      ? `HTTPS probe skipped: ${resolutionError}`
      : !resolutionStable
        ? "HTTPS probe skipped because DNS changed during the safety preflight."
        : publicAddresses.length === 0
          ? "HTTPS probe skipped because no public address was observed through the bounded CNAME chain."
          : null;
  const https = safetyAllowed
    ? await probeHttps(hostname, fetcher)
    : skippedHttps(hostname, safetyReason!);
  const completed = now();
  const partialDns = dns.some((query) => query.status === "error" || query.status === "timeout");
  const nxdomain = dns.some((query) => query.status === "nxdomain");
  const httpHealthy = https.classification === "success" || https.classification === "redirected";
  const status =
    nxdomain ||
    blockedAddresses.length ||
    resolutionError ||
    !resolutionStable ||
    https.status === "unreachable" ||
    https.classification === "redirect_loop"
      ? "failed"
      : partialDns || !httpHealthy
        ? "degraded"
        : "healthy";

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
    cnameChain: firstResolution.chain,
    safety: { allowed: safetyAllowed, blockedAddresses, reason: safetyReason, resolutionStable },
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
        "Cloudflare Workers fetch confirms whether the HTTPS/TLS request succeeded but does not expose the peer certificate chain, issuer, SANs, serial number, or expiry.",
    },
    findings: buildFindings(dns, https, blockedAddresses, resolutionStable, firstResolution.chain),
    limitations: [
      "This is a point-in-time public observation and may vary during DNS propagation.",
      "Public diagnostics cannot reveal internal Cloudflare for SaaS hostname or certificate provisioning status.",
      "Redirects are reported but not followed for SSRF safety.",
      "Two DNS snapshots reduce rebinding risk, but Workers fetch cannot pin the HTTPS request to the preflight IP; Cloudflare outbound-network controls remain an additional boundary.",
    ],
  };
}

async function resolveCnameChain(
  hostname: string,
  fetcher: Fetcher,
  initial?: LiveDnsQuery[],
): Promise<Resolution> {
  const seen = new Set<string>();
  const chain: Resolution["chain"] = [];
  let current = hostname;
  for (let depth = 0; depth <= maxCnameDepth; depth++) {
    if (seen.has(current)) return { addresses: [], chain, error: "CNAME loop detected." };
    seen.add(current);
    const queries =
      depth === 0 && initial
        ? initial.filter(
            (query) => query.type === "A" || query.type === "AAAA" || query.type === "CNAME",
          )
        : await Promise.all(
            (["A", "AAAA", "CNAME"] as const).map((type) => queryDns(current, type, fetcher)),
          );
    if (queries.some((query) => query.status === "nxdomain"))
      return { addresses: [], chain, error: `${current} does not exist (NXDOMAIN).` };
    if (queries.some((query) => query.status === "error" || query.status === "timeout"))
      return { addresses: [], chain, error: `DNS resolution for ${current} was incomplete.` };
    const addresses = unique(
      queries
        .flatMap((query) => query.records)
        .filter((record) => record.type === "A" || record.type === "AAAA")
        .map((record) => record.value),
    );
    if (addresses.length) return { addresses, chain, error: null };
    const targets = unique(
      queries
        .flatMap((query) => query.records)
        .filter((record) => record.type === "CNAME")
        .map((record) => record.value),
    );
    if (!targets.length) return { addresses: [], chain, error: null };
    if (targets.length !== 1)
      return {
        addresses: [],
        chain,
        error: `Multiple CNAME targets were observed for ${current}.`,
      };
    if (depth === maxCnameDepth)
      return {
        addresses: [],
        chain,
        error: `CNAME chain exceeds the ${maxCnameDepth}-hop safety limit.`,
      };
    let target: string;
    try {
      target = validateLiveHostname(targets[0]);
    } catch {
      return {
        addresses: [],
        chain,
        error: `CNAME target ${targets[0]} is not a permitted public hostname.`,
      };
    }
    chain.push({ from: current, to: target, depth: depth + 1 });
    current = target;
  }
  return { addresses: [], chain, error: "CNAME resolution stopped unexpectedly." };
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
    if (!response.ok)
      return dnsFailure(type, "error", `DNS over HTTPS returned HTTP ${response.status}.`);
    const payload = (await response.json()) as DnsJsonResponse;
    const responseCode = typeof payload.Status === "number" ? payload.Status : null;
    const records = deduplicateRecords(
      (payload.Answer ?? [])
        .map(toDnsRecord)
        .filter((record): record is LiveDnsRecord => record !== null),
    );
    if (responseCode === 3)
      return {
        type,
        status: "nxdomain",
        responseCode,
        responseCodeName: "NXDOMAIN",
        records: [],
        error: "Hostname does not exist (NXDOMAIN).",
      };
    if (responseCode !== 0)
      return {
        type,
        status: "error",
        responseCode,
        responseCodeName: responseCodeNames[responseCode ?? -1] ?? "UNKNOWN",
        records,
        error: `DNS resolver returned ${responseCodeNames[responseCode ?? -1] ?? `rcode ${responseCode}`}.`,
      };
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
  const originalUrl = `https://${hostname}/`;
  let currentUrl = originalUrl;
  const visited = new Set([currentUrl]);
  const redirects: NonNullable<LiveHttpsObservation["redirects"]> = [];
  for (let hop = 0; hop <= 3; hop++) {
    let observation = await requestHttps(currentUrl, "HEAD", fetcher);
    if (observation.statusCode === 405 || observation.statusCode === 501)
      observation = await requestHttps(currentUrl, "GET", fetcher);
    const redirectStatus = observation.statusCode;
    if (!redirectStatus || ![301, 302, 307, 308].includes(redirectStatus)) {
      return {
        ...observation,
        classification:
          redirects.length && observation.classification === "success"
            ? "redirected"
            : observation.classification,
        originalUrl,
        finalUrl: currentUrl,
        redirects,
      };
    }
    const destination = redirectDestination(observation.redirectLocation, currentUrl);
    if (!destination || hop === 3) {
      redirects.push({
        from: currentUrl,
        to: destination ?? observation.redirectLocation ?? "unavailable",
        statusCode: redirectStatus,
        verified: false,
        reason: destination
          ? "Redirect hop limit reached."
          : "Redirect destination is invalid or unsafe.",
      });
      return {
        ...observation,
        classification: "redirect_unverified",
        originalUrl,
        finalUrl: destination ?? currentUrl,
        redirects,
      };
    }
    if (visited.has(destination)) {
      redirects.push({
        from: currentUrl,
        to: destination,
        statusCode: redirectStatus,
        verified: false,
        reason: "Redirect loop detected.",
      });
      return {
        ...observation,
        classification: "redirect_loop",
        originalUrl,
        finalUrl: destination,
        redirects,
        error: "Redirect loop detected.",
      };
    }
    const safety = await verifyRedirectTarget(new URL(destination).hostname, fetcher);
    redirects.push({
      from: currentUrl,
      to: destination,
      statusCode: redirectStatus,
      verified: safety.safe,
      reason: safety.reason,
    });
    if (!safety.safe)
      return {
        ...observation,
        classification: "redirect_unverified",
        originalUrl,
        finalUrl: destination,
        redirects,
        error: safety.reason,
      };
    visited.add(destination);
    currentUrl = destination;
  }
  throw new Error("Unreachable redirect state.");
}
async function requestHttps(
  url: string,
  method: "HEAD" | "GET",
  fetcher: Fetcher,
): Promise<LiveHttpsObservation> {
  const started = Date.now();
  try {
    const response = await fetcher(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: method === "GET" ? { Accept: "*/*", Range: "bytes=0-0" } : { Accept: "*/*" },
    });
    if (method === "GET") void response.body?.cancel();
    return {
      status: "reachable",
      method,
      classification: classifyHttpStatus(response.status),
      url,
      statusCode: response.status,
      responseTimeMs: Math.max(0, Date.now() - started),
      redirectLocation: sanitizeRedirect(response.headers.get("location"), url),
      headers: selectedHeaders(response.headers),
      error: null,
    };
  } catch (cause) {
    const timedOut =
      cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return {
      status: "unreachable",
      method,
      classification: "network_error",
      url,
      statusCode: null,
      responseTimeMs: Math.max(0, Date.now() - started),
      redirectLocation: null,
      headers: {},
      error: timedOut ? "HTTPS request timed out." : "HTTPS connection or TLS handshake failed.",
    };
  }
}
function classifyHttpStatus(status: number): NonNullable<LiveHttpsObservation["classification"]> {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect_unverified";
  if (status >= 400 && status < 500) return "client_error";
  return "server_error";
}

async function verifyRedirectTarget(
  hostname: string,
  fetcher: Fetcher,
): Promise<{ safe: boolean; reason: string | null }> {
  try {
    validateLiveHostname(hostname);
  } catch {
    return { safe: false, reason: "Redirect target is not a permitted public hostname." };
  }
  const snapshots = await Promise.all(
    [0, 1].map(async () =>
      unique(
        (
          await Promise.all(
            (["A", "AAAA"] as const).map((type) => queryDns(hostname, type, fetcher)),
          )
        )
          .flatMap((query) => query.records)
          .filter((record) => record.type === "A" || record.type === "AAAA")
          .map((record) => record.value),
      ),
    ),
  );
  if (!snapshots[0].length)
    return { safe: false, reason: "Redirect target has no directly observed public address." };
  if (!sameStrings(snapshots[0], snapshots[1]))
    return { safe: false, reason: "Redirect target DNS changed during safety validation." };
  if (snapshots[0].some((address) => !isPublicIpAddress(address)))
    return { safe: false, reason: "Redirect target resolves to a non-public address." };
  return { safe: true, reason: null };
}

function redirectDestination(location: string | null, currentUrl: string): string | null {
  if (!location) return null;
  try {
    const target = new URL(location, currentUrl);
    if (target.protocol !== "https:" || target.username || target.password || target.port)
      return null;
    target.hash = "";
    return target.toString();
  } catch {
    return null;
  }
}
function skippedHttps(hostname: string, reason: string): LiveHttpsObservation {
  return {
    status: "skipped",
    method: "HEAD",
    classification: "skipped",
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
function sanitizeRedirect(value: string | null, baseUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
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
function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
function sameStrings(a: string[], b: string[]): boolean {
  return JSON.stringify(unique(a)) === JSON.stringify(unique(b));
}
function sameChain(a: Resolution["chain"], b: Resolution["chain"]): boolean {
  return (
    JSON.stringify(a.map(({ from, to }) => ({ from, to }))) ===
    JSON.stringify(b.map(({ from, to }) => ({ from, to })))
  );
}
function buildFindings(
  dns: LiveDnsQuery[],
  https: LiveHttpsObservation,
  blocked: string[],
  stable: boolean,
  chain: Resolution["chain"],
): string[] {
  const findings: string[] = [];
  if (dns.some((query) => query.status === "nxdomain"))
    findings.push("The hostname returned NXDOMAIN and does not currently exist in public DNS.");
  for (const query of dns) {
    if (query.status === "success")
      findings.push(
        `Observed ${query.records.filter((record) => record.type === query.type).length} public ${query.type} record(s).`,
      );
    else if (query.status === "error" || query.status === "timeout")
      findings.push(`${query.type} lookup unavailable: ${query.error}`);
  }
  if (chain.length)
    findings.push(`Resolved a ${chain.length}-hop CNAME chain to ${chain.at(-1)!.to}.`);
  if (!stable)
    findings.push("DNS answers changed between safety snapshots; HTTPS was not requested.");
  if (blocked.length)
    findings.push("HTTPS probe was blocked because DNS returned a non-public address.");
  else if (https.status === "reachable")
    findings.push(
      `HTTPS ${https.method} responded with status ${https.statusCode} (${https.classification}); TLS handshake succeeded.`,
    );
  else if (https.error) findings.push(https.error);
  return unique(findings);
}
