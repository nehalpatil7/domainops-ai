import { describe, expect, it, vi } from "vitest";
import { createDomainToolHandlers, type DomainBackend } from "../src/agent/domain-assistant-tools";
import {
  DOMAIN_ASSISTANT_SYSTEM_PROMPT,
  prepareConversationMessages,
} from "../src/agent/domain-ops-chat-agent";
import type { Domain, LiveDiagnosticRun } from "../src/domain/types";

describe("grounded assistant tools", () => {
  it("lists only real health data and reports freshness", async () => {
    const handlers = createDomainToolHandlers(backend());
    await expect(handlers.listDomains({ health: "all" })).resolves.toMatchObject({
      source: "live_public",
      domains: [{ hostname: "www.cloudflare.com", healthStatus: "healthy" }],
    });
  });
  it("asks for clarification on ambiguous hostnames", async () => {
    const first = domain("www.example-one.com");
    const second = domain("api.example-one.com");
    const handlers = createDomainToolHandlers(backend([first, second]));
    await expect(handlers.diagnoseDomain({ domain: "example-one" })).resolves.toMatchObject({
      result: "ambiguous",
      matches: [{ hostname: first.hostname }, { hostname: second.hostname }],
    });
  });
  it("runs a real check only through the explicit diagnostic handler", async () => {
    const source = backend();
    const handlers = createDomainToolHandlers(source);
    const result = await handlers.runLiveDiagnostic({ domain: "www.cloudflare.com" });
    expect(source.runDiagnostic).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      result: "success",
      source: "live_public",
      initiatedByAssistant: true,
      observedAt: "2026-10-25T12:00:00.000Z",
    });
  });
  it("returns meaningful backend errors without invented state", async () => {
    const source = backend();
    vi.mocked(source.getDomain).mockRejectedValue(
      Object.assign(new Error("Storage temporarily unavailable"), { code: "BACKEND_DOWN" }),
    );
    const result = await createDomainToolHandlers(source).getDomainStatus({
      domain: "www.cloudflare.com",
    });
    expect(result).toMatchObject({
      result: "error",
      code: "BACKEND_DOWN",
      message: "Storage temporarily unavailable",
    });
  });
  it("preserves recent multi-turn context and requires complete final answers", async () => {
    const converted = await prepareConversationMessages([
      { id: "1", role: "user", parts: [{ type: "text", text: "Check www.cloudflare.com" }] },
      { id: "2", role: "assistant", parts: [{ type: "text", text: "It is healthy." }] },
      { id: "3", role: "user", parts: [{ type: "text", text: "What should I do next?" }] },
    ]);
    expect(JSON.stringify(converted)).toContain("What should I do next?");
    expect(DOMAIN_ASSISTANT_SYSTEM_PROMPT).toContain(
      "always provide a complete user-facing answer",
    );
  });
});

function backend(domains = [domain("www.cloudflare.com")]): DomainBackend {
  return {
    listDomains: vi.fn(async () => domains),
    getDomain: vi.fn(async (id) => domains.find((item) => item.id === id)!),
    getDiagnosticHistory: vi.fn(async () =>
      domains[0]!.latestDiagnostic ? [{ ...domains[0]!.latestDiagnostic, changes: [] }] : [],
    ),
    runDiagnostic: vi.fn(async () => domains[0]!.latestDiagnostic),
  };
}
function domain(hostname: string): Domain {
  const latest = run(hostname);
  return {
    id: crypto.randomUUID(),
    workspaceId: "ws-team",
    hostname,
    createdAt: "2026-10-25T10:00:00.000Z",
    updatedAt: latest.completedAt,
    healthStatus: "healthy",
    lastCheckedAt: latest.observedAt,
    checkDurationMs: latest.durationMs,
    latestDiagnostic: latest,
  };
}
function run(hostname: string): LiveDiagnosticRun {
  return {
    id: crypto.randomUUID(),
    workspaceId: "ws-team",
    domainId: crypto.randomUUID(),
    hostname,
    source: "live_public",
    status: "healthy",
    observedAt: "2026-10-25T12:00:00.000Z",
    completedAt: "2026-10-25T12:00:01.000Z",
    durationMs: 1000,
    dnsProvider: "Cloudflare DNS over HTTPS",
    dns: [
      {
        type: "A",
        status: "success",
        responseCode: 0,
        responseCodeName: "NOERROR",
        records: [{ type: "A", name: hostname, value: "104.16.1.2", ttl: 300 }],
        error: null,
      },
    ],
    publicAddresses: ["104.16.1.2"],
    safety: { allowed: true, blockedAddresses: [], reason: null },
    https: {
      status: "reachable",
      url: `https://${hostname}/`,
      statusCode: 200,
      responseTimeMs: 40,
      redirectLocation: null,
      headers: {},
      error: null,
    },
    tls: {
      handshake: "succeeded",
      certificateMetadataAvailable: false,
      limitation: "Certificate metadata unavailable.",
    },
    findings: ["HTTPS is reachable."],
    limitations: [],
  };
}
