import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DiagnosticEvent, Domain, LiveDiagnosticRun } from "../src/domain/types";
import worker from "../src/server";

type Envelope<T> = { data: T; meta: { workspaceId: string; simulated: boolean } };

describe("Worker entry point", () => {
  it("reports simulation mode from the health route", async () => {
    const response = await worker.fetch(new Request("https://domainops.test/api/health"), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "domainops-ai",
      status: "ok",
      modes: {
        onboarding: "simulation",
        diagnostics: "live_public",
      },
    });
  });

  it("returns a consistent not-found error", async () => {
    const response = await worker.fetch(new Request("https://domainops.test/api/nope"), env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ROUTE_NOT_FOUND" } });
  });

  it("routes the workspace chat agent and initializes persistent message storage", async () => {
    const workspace = uniqueWorkspace("chat");
    const response = await worker.fetch(
      new Request(`https://domainops.test/agents/domain-ops-chat-agent/${workspace}/get-messages`),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual([]);
  });
});

describe("workspace domain API", () => {
  it("seeds four realistic, independently modeled demo states", async () => {
    const workspace = uniqueWorkspace("seed");
    const response = await request(workspace, "");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Envelope<Domain[]>;

    expect(payload.meta).toMatchObject({ workspaceId: workspace, simulated: true });
    expect(payload.data).toHaveLength(4);
    expect(payload.data.map((domain) => domain.simulationProfile)).toEqual([
      "active",
      "incorrect_dns",
      "pending_ssl",
      "validation_failure",
    ]);
    expect(payload.data.find((domain) => domain.simulationProfile === "active")?.ready).toBe(true);
    expect(payload.data.find((domain) => domain.simulationProfile === "pending_ssl")).toMatchObject(
      {
        hostnameStatus: "active",
        sslStatus: "pending_issuance",
        ready: false,
      },
    );
  });

  it("registers idempotently and records one registration event", async () => {
    const workspace = uniqueWorkspace("register");
    const key = "register:stable-request";
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({
        hostname: "App.Customer.Example.",
        simulationProfile: "incorrect_dns",
      }),
    };
    const first = await request(workspace, "", init);
    const second = await request(workspace, "", init);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);

    const created = ((await first.json()) as Envelope<{ domain: Domain; duplicate: boolean }>).data;
    const repeated = ((await second.json()) as Envelope<{ domain: Domain; duplicate: boolean }>)
      .data;
    expect(created).toMatchObject({
      duplicate: false,
      domain: { hostname: "app.customer.example" },
    });
    expect(repeated).toMatchObject({ duplicate: true, domain: { id: created.domain.id } });

    const history = await request(workspace, `/${created.domain.id}/history`);
    const events = ((await history.json()) as Envelope<DiagnosticEvent[]>).data;
    expect(events.filter((event) => event.eventType === "domain_registered")).toHaveLength(1);
  });

  it("isolates domain data between workspaces", async () => {
    const firstWorkspace = uniqueWorkspace("tenant-a");
    const secondWorkspace = uniqueWorkspace("tenant-b");
    const registration = await request(firstWorkspace, "", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:isolation-test" },
      body: JSON.stringify({ hostname: "isolated.customer.example", simulationProfile: "active" }),
    });
    const domain = ((await registration.json()) as Envelope<{ domain: Domain }>).data.domain;

    const crossWorkspaceRead = await request(secondWorkspace, `/${domain.id}`);
    expect(crossWorkspaceRead.status).toBe(404);
    await expect(crossWorkspaceRead.json()).resolves.toMatchObject({
      error: { code: "DOMAIN_NOT_FOUND" },
    });
  });

  it("validates input and idempotency headers consistently", async () => {
    const workspace = uniqueWorkspace("invalid");
    const response = await request(workspace, "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "not a hostname" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
      requestId: expect.any(String),
    });
  });

  it("runs deterministic revalidation and deduplicates repeated requests", async () => {
    const workspace = uniqueWorkspace("workflow");
    const list = await request(workspace, "");
    const domains = ((await list.json()) as Envelope<Domain[]>).data;
    const pending = domains.find((domain) => domain.simulationProfile === "pending_ssl");
    expect(pending).toBeDefined();

    const workflow = await introspectWorkflow(env.DOMAIN_REVALIDATION_WORKFLOW);
    try {
      await workflow.modifyAll(async (modifier) => modifier.disableSleeps());
      const key = "revalidate:stable-request";
      const first = await request(workspace, `/${pending!.id}/revalidate`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      });
      const second = await request(workspace, `/${pending!.id}/revalidate`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      });
      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      const firstResult = ((await first.json()) as Envelope<{ workflowId: string }>).data;
      const secondResult = (
        (await second.json()) as Envelope<{ workflowId: string; duplicate: boolean }>
      ).data;
      expect(secondResult).toMatchObject({ workflowId: firstResult.workflowId, duplicate: true });

      const instances = await workflow.get();
      expect(instances).toHaveLength(1);
      await instances[0].waitForStatus("complete");

      const details = await request(workspace, `/${pending!.id}`);
      const domain = ((await details.json()) as Envelope<Domain>).data;
      expect(domain).toMatchObject({
        dnsStatus: "valid",
        hostnameStatus: "active",
        sslStatus: "active",
        validationState: "active",
        retryCount: 1,
        ready: true,
      });

      const history = await request(workspace, `/${pending!.id}/history`);
      const events = ((await history.json()) as Envelope<DiagnosticEvent[]>).data;
      expect(events.filter((event) => event.eventType === "validation_started")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "validation_completed")).toHaveLength(1);
    } finally {
      await workflow.dispose();
    }
  });

  it("persists live observations separately and deduplicates diagnostic requests", async () => {
    const workspace = uniqueWorkspace("live");
    const registration = await request(workspace, "", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:live-mode" },
      body: JSON.stringify({ hostname: "www.public-domain.com", simulationProfile: "active" }),
    });
    const domain = ((await registration.json()) as Envelope<{ domain: Domain }>).data.domain;
    const store = env.WorkspaceDomainStore.get(env.WorkspaceDomainStore.idFromName(workspace));
    const prepared = await store.prepareLiveDiagnostic(workspace, domain.id, "live:stable-request");
    expect(prepared).toMatchObject({ ok: true, value: { shouldRun: true, duplicate: false } });
    if (!prepared.ok) throw new Error(prepared.error.message);

    const completed = await store.completeLiveDiagnostic(
      workspace,
      domain.id,
      "live:stable-request",
      prepared.value.requestId,
      liveRun(domain, prepared.value.requestId),
    );
    expect(completed).toMatchObject({
      ok: true,
      value: { source: "live_public", hostname: domain.hostname, status: "healthy" },
    });

    const replay = await store.prepareLiveDiagnostic(workspace, domain.id, "live:stable-request");
    expect(replay).toMatchObject({
      ok: true,
      value: { shouldRun: false, duplicate: true, existingRun: { source: "live_public" } },
    });

    const rateLimited = await store.prepareLiveDiagnostic(
      workspace,
      domain.id,
      "live:new-request-key",
    );
    expect(rateLimited).toMatchObject({
      ok: true,
      value: { shouldRun: false, duplicate: false, existingRun: { id: prepared.value.requestId } },
    });

    const history = await request(workspace, `/${domain.id}/live-diagnostics`);
    expect(history.status).toBe(200);
    const payload = (await history.json()) as Envelope<LiveDiagnosticRun[]> & {
      meta: { source: string; simulated: boolean; workspaceId: string };
    };
    expect(payload.meta).toMatchObject({ source: "live_public", simulated: false });
    expect(payload.data).toHaveLength(1);
    expect(JSON.stringify(payload.data)).not.toContain("requiredValidationRecords");
  });
});

function uniqueWorkspace(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function request(workspace: string, path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(`https://domainops.test/api/workspaces/${workspace}/domains${path}`, init),
    env,
  );
}

function liveRun(domain: Domain, id: string): LiveDiagnosticRun {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: "",
    domainId: "",
    hostname: domain.hostname,
    source: "live_public",
    status: "healthy",
    observedAt: now,
    completedAt: now,
    durationMs: 1000,
    dnsProvider: "Cloudflare DNS over HTTPS",
    dns: [],
    publicAddresses: ["104.16.1.2"],
    safety: { allowed: true, blockedAddresses: [], reason: null },
    https: {
      status: "reachable",
      url: `https://${domain.hostname}/`,
      statusCode: 200,
      responseTimeMs: 100,
      redirectLocation: null,
      headers: {},
      error: null,
    },
    tls: {
      handshake: "succeeded",
      certificateMetadataAvailable: false,
      limitation: "Certificate metadata unavailable in Workers fetch.",
    },
    findings: ["HTTPS reachable."],
    limitations: ["Point-in-time observation."],
  };
}
