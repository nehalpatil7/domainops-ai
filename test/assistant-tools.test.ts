import { describe, expect, it } from "vitest";
import {
  createDomainAssistantTools,
  createDomainToolHandlers,
  type DomainReadBackend,
} from "../src/agent/domain-assistant-tools";
import {
  DOMAIN_ASSISTANT_SYSTEM_PROMPT,
  prepareConversationMessages,
} from "../src/agent/domain-ops-chat-agent";
import type {
  DiagnosticEvent,
  DnsAssessment,
  Domain,
  LiveDiagnosticRun,
} from "../src/domain/types";

describe("domain assistant tools", () => {
  it("exposes only read-only simulated and live backend tools", () => {
    const tools = createDomainAssistantTools(fakeBackend());
    expect(Object.keys(tools)).toEqual([
      "listDomains",
      "getDomainStatus",
      "getDnsConfiguration",
      "getValidationHistory",
      "diagnoseDomain",
      "getLiveDiagnostics",
      "getLiveDiagnosticHistory",
      "diagnoseLiveDomain",
    ]);
    expect(Object.keys(tools).some((name) => /retry|update|delete|register/i.test(name))).toBe(
      false,
    );
  });

  it("executes the same handler attached to the AI SDK tool", async () => {
    const tools = createDomainAssistantTools(fakeBackend());
    const execute = tools.listDomains.execute as unknown as (input: {
      readiness: "all" | "ready" | "attention";
    }) => Promise<unknown>;
    await expect(execute({ readiness: "ready" })).resolves.toMatchObject({
      result: "success",
      source: "domainops_backend",
      count: 1,
      domains: [{ hostname: "active.demo.example", ready: true }],
    });
  });

  it("returns confirmed DNS and SSL validation details", async () => {
    const handlers = createDomainToolHandlers(fakeBackend());
    const result = await handlers.getDnsConfiguration({
      domain: "incorrect-dns.demo.example",
    });
    expect(result).toMatchObject({
      result: "success",
      providerData: "simulation",
      statuses: {
        dns: "invalid",
        hostname: "pending",
        ssl: "pending_validation",
      },
      expectedRecords: [{ value: "customers.domainops.example" }],
      observedRecords: [{ value: "legacy-origin.customer.example" }],
    });
    expect(result).toHaveProperty(
      "requiredValidationRecords",
      expect.arrayContaining([expect.objectContaining({ purpose: "hostname_ownership" })]),
    );
  });

  it("requires clarification when a partial hostname is ambiguous", async () => {
    const handlers = createDomainToolHandlers(fakeBackend());
    await expect(handlers.getDomainStatus({ domain: "demo.example" })).resolves.toMatchObject({
      result: "ambiguous",
      matches: [{ hostname: "active.demo.example" }, { hostname: "incorrect-dns.demo.example" }],
      instruction: expect.stringMatching(/Ask the user/),
    });
  });

  it("returns a bounded not-found result instead of inventing a domain", async () => {
    const handlers = createDomainToolHandlers(fakeBackend());
    await expect(handlers.diagnoseDomain({ domain: "missing.example" })).resolves.toEqual({
      result: "not_found",
      source: "domainops_backend",
      query: "missing.example",
      availableHostnames: ["active.demo.example", "incorrect-dns.demo.example"],
      instruction: "Say the domain was not found and ask the user to choose a listed hostname.",
    });
  });

  it("separates confirmed blockers, possible causes, and actions", async () => {
    const handlers = createDomainToolHandlers(fakeBackend());
    const result = await handlers.diagnoseDomain({ domain: "incorrect-dns.demo.example" });
    expect(result).toMatchObject({
      result: "success",
      source: "domainops_backend",
      ready: false,
      blockers: [
        { area: "dns", diagnosticCode: "DNS_CONFIGURATION_INVALID" },
        { area: "hostname", diagnosticCode: "HOSTNAME_NOT_ACTIVE" },
        { area: "ssl", diagnosticCode: "SSL_NOT_ACTIVE" },
      ],
      possibleCauses: expect.arrayContaining([expect.stringMatching(/may/)]),
      recommendedActions: expect.arrayContaining([
        expect.stringMatching(/customers\.domainops\.example/),
      ]),
    });
  });

  it("turns backend failures into explicit no-assumption tool errors", async () => {
    const handlers = createDomainToolHandlers({
      ...fakeBackend(),
      listDomains: async () => {
        const error = new Error("Domain store is unavailable") as Error & { code: string };
        error.code = "STORE_UNAVAILABLE";
        throw error;
      },
    });
    await expect(handlers.listDomains({ readiness: "all" })).resolves.toEqual({
      result: "error",
      source: "domainops_backend",
      operation: "listDomains",
      code: "STORE_UNAVAILABLE",
      message: "Domain store is unavailable",
      instruction:
        "Explain that confirmed data is unavailable; do not infer or invent domain state.",
    });
  });

  it("keeps live observations separate from simulated validation data", async () => {
    const handlers = createDomainToolHandlers(fakeBackend());
    const result = await handlers.getLiveDiagnostics({ domain: "active.demo.example" });
    expect(result).toMatchObject({
      result: "success",
      source: "live_public",
      latest: {
        source: "live_public",
        hostname: "active.demo.example",
        https: { status: "reachable" },
        tls: { certificateMetadataAvailable: false },
      },
    });
    expect(JSON.stringify(result)).not.toContain("requiredValidationRecords");
    expect(JSON.stringify(result)).not.toContain("simulationProfile");
  });

  it("does not substitute simulation data when no live observation exists", async () => {
    const backend = fakeBackend();
    backend.getLiveDiagnosticHistory = async () => [];
    const handlers = createDomainToolHandlers(backend);
    await expect(
      handlers.diagnoseLiveDomain({ domain: "active.demo.example" }),
    ).resolves.toMatchObject({
      result: "no_live_observation",
      source: "live_public",
      instruction: expect.stringMatching(/do not use simulated findings/i),
    });
  });
});

describe("assistant conversation context", () => {
  it("keeps the prior domain discussion when preparing a follow-up turn", async () => {
    const prepared = await prepareConversationMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Why is incorrect-dns.demo.example failing?" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "The backend confirms incorrect-dns.demo.example has an invalid CNAME.",
          },
        ],
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "How do I fix it?" }],
      },
    ]);
    const serialized = JSON.stringify(prepared);
    expect(serialized).toContain("incorrect-dns.demo.example");
    expect(serialized).toContain("How do I fix it?");
  });

  it("instructs the model to refresh tools and distinguish uncertainty", () => {
    expect(DOMAIN_ASSISTANT_SYSTEM_PROMPT).toMatch(/Every turn must use at least one tool/);
    expect(DOMAIN_ASSISTANT_SYSTEM_PROMPT).toMatch(/Separate confirmed facts from possible causes/);
    expect(DOMAIN_ASSISTANT_SYSTEM_PROMPT).toMatch(/Never invent a hostname/);
    expect(DOMAIN_ASSISTANT_SYSTEM_PROMPT).toMatch(/two strictly separate evidence modes/);
    expect(DOMAIN_ASSISTANT_SYSTEM_PROMPT).toMatch(
      /Never report simulated expected records.*as live findings/,
    );
  });
});

function fakeBackend(): DomainReadBackend {
  const active = makeDomain({
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "active.demo.example",
    ready: true,
    dnsStatus: "valid",
    hostnameStatus: "active",
    sslStatus: "active",
    validationState: "active",
    simulationProfile: "active",
  });
  const incorrect = makeDomain({
    id: "22222222-2222-4222-8222-222222222222",
    hostname: "incorrect-dns.demo.example",
    ready: false,
    dnsStatus: "invalid",
    hostnameStatus: "pending",
    sslStatus: "pending_validation",
    validationState: "dns_misconfigured",
    simulationProfile: "incorrect_dns",
  });
  const domains = [active, incorrect];
  return {
    listDomains: async () => domains,
    getDomain: async (id) => domains.find((domain) => domain.id === id)!,
    getDnsAssessment: async (id) => makeAssessment(domains.find((domain) => domain.id === id)!),
    getHistory: async (id) => [makeEvent(id)],
    getLiveDiagnosticHistory: async (id) => [
      makeLiveRun(domains.find((domain) => domain.id === id)!),
    ],
  };
}

function makeLiveRun(domain: Domain): LiveDiagnosticRun {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: "tools-test",
    domainId: domain.id,
    hostname: domain.hostname,
    source: "live_public",
    status: "healthy",
    observedAt: "2026-10-26T00:00:00.000Z",
    completedAt: "2026-10-26T00:00:01.000Z",
    durationMs: 1000,
    dnsProvider: "Cloudflare DNS over HTTPS",
    dns: [
      {
        type: "A",
        status: "success",
        responseCode: 0,
        responseCodeName: "NOERROR",
        records: [{ type: "A", name: domain.hostname, value: "104.16.1.2", ttl: 300 }],
        error: null,
      },
    ],
    publicAddresses: ["104.16.1.2"],
    safety: { allowed: true, blockedAddresses: [], reason: null },
    https: {
      status: "reachable",
      url: `https://${domain.hostname}/`,
      statusCode: 200,
      responseTimeMs: 80,
      redirectLocation: null,
      headers: { server: "cloudflare" },
      error: null,
    },
    tls: {
      handshake: "succeeded",
      certificateMetadataAvailable: false,
      limitation: "Workers fetch does not expose certificate metadata.",
    },
    findings: ["Observed one public A record.", "HTTPS responded with status 200."],
    limitations: ["Point-in-time observation."],
  };
}

function makeDomain(overrides: Partial<Domain> & Pick<Domain, "id" | "hostname">): Domain {
  const { id, hostname, ...rest } = overrides;
  return {
    id,
    workspaceId: "tools-test",
    hostname,
    expectedDnsTarget: "customers.domainops.example",
    expectedDnsRecords: [
      {
        type: "CNAME",
        name: hostname,
        value: "customers.domainops.example",
        ttl: 300,
      },
    ],
    observedDnsRecords: [
      {
        type: "CNAME",
        name: hostname,
        value:
          overrides.dnsStatus === "invalid"
            ? "legacy-origin.customer.example"
            : "customers.domainops.example",
        ttl: 300,
      },
    ],
    dnsStatus: "valid",
    hostnameStatus: "active",
    sslStatus: "active",
    requiredValidationRecords: [
      {
        purpose: "hostname_ownership",
        type: "TXT",
        name: `_cf-custom-hostname.${hostname}`,
        value: "sim-ownership",
        status: overrides.dnsStatus === "invalid" ? "pending" : "valid",
      },
      {
        purpose: "certificate",
        type: "TXT",
        name: `_acme-challenge.${hostname}`,
        value: "sim-dcv",
        status: overrides.sslStatus === "active" ? "valid" : "pending",
      },
    ],
    validationState: "active",
    source: "simulation",
    simulationProfile: "active",
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    lastValidationAttemptAt: null,
    retryCount: 0,
    lastAppliedAttempt: 0,
    activeValidationId: null,
    ready: true,
    ...rest,
  };
}

function makeAssessment(domain: Domain): DnsAssessment {
  const matches = domain.dnsStatus === "valid" ? domain.expectedDnsRecords : [];
  return {
    domainId: domain.id,
    hostname: domain.hostname,
    source: "simulation",
    expectedRecords: domain.expectedDnsRecords,
    observedRecords: domain.observedDnsRecords,
    matchingRecords: matches,
    missingRecords: domain.dnsStatus === "valid" ? [] : domain.expectedDnsRecords,
    unexpectedRecords: domain.dnsStatus === "valid" ? [] : domain.observedDnsRecords,
    requiredValidationRecords: domain.requiredValidationRecords,
    dnsStatus: domain.dnsStatus,
    hostnameStatus: domain.hostnameStatus,
    sslStatus: domain.sslStatus,
    validationState: domain.validationState,
    ready: domain.ready,
  };
}

function makeEvent(domainId: string): DiagnosticEvent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: "tools-test",
    domainId,
    eventType: "validation_completed",
    category: "workflow",
    previousValue: "running",
    nextValue: "complete",
    diagnosticCode: "DNS_TARGET_MISMATCH",
    message: "Observed CNAME does not match the expected SaaS target.",
    metadata: {},
    validationId: "validation-1",
    attempt: 1,
    source: "simulation",
    createdAt: "2026-10-25T00:00:00.000Z",
  };
}
