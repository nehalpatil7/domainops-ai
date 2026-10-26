import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Domain, LiveDiagnosticRun, Workspace } from "../src/domain/types";
import worker from "../src/server";

type Envelope<T> = { data: T; meta: { source: "live_public"; workspaceId?: string } };

describe("Worker entry point", () => {
  it("reports only live public mode", async () => {
    const response = await worker.fetch(new Request("https://domainops.test/api/health"), env);
    await expect(response.json()).resolves.toEqual({
      service: "domainops-ai",
      status: "ok",
      mode: "live_public",
    });
  });
  it("routes isolated persistent chat sessions", async () => {
    const workspace = workspaceId("chat");
    await domainRequest(workspace, "");
    const response = await worker.fetch(
      new Request(`https://domainops.test/agents/domain-ops-chat-agent/${workspace}/get-messages`),
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });
  it("does not let an Agent route create or claim an unknown workspace", async () => {
    const workspace = workspaceId("unowned-agent");
    const response = await worker.fetch(
      new Request(`https://domainops.test/agents/domain-ops-chat-agent/${workspace}/get-messages`),
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WORKSPACE_FORBIDDEN" },
    });
  });
  it("fails closed on production hosts when Cloudflare Access is not configured", async () => {
    const response = await worker.fetch(
      new Request("https://domainops.example/api/workspaces"),
      env,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_NOT_CONFIGURED" },
    });
  });
});

describe("workspace management", () => {
  it("creates, lists, and renames a stable workspace", async () => {
    const createdResponse = await fetchApi("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform team" }),
    });
    expect(createdResponse.status).toBe(201);
    const created = ((await createdResponse.json()) as Envelope<Workspace>).data;
    const renamedResponse = await fetchApi(`/api/workspaces/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Edge platform" }),
    });
    expect(((await renamedResponse.json()) as Envelope<Workspace>).data).toMatchObject({
      id: created.id,
      name: "Edge platform",
    });
    const list = ((await (await fetchApi("/api/workspaces")).json()) as Envelope<Workspace[]>).data;
    expect(list).toContainEqual(expect.objectContaining({ id: created.id, name: "Edge platform" }));
  });
  it("binds an existing workspace to its first authenticated owner", async () => {
    const catalog = env.WorkspaceCatalog.get(env.WorkspaceCatalog.idFromName("global"));
    const id = workspaceId("owned");
    expect(await catalog.ensure("owner-a", id, "Owned workspace")).toMatchObject({ ok: true });
    expect(await catalog.authorize("owner-b", id)).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_FORBIDDEN", status: 403 },
    });
  });
  it("stores SQL-like workspace names as bound data without changing the schema", async () => {
    const name = "x'); DROP TABLE workspaces; --";
    const created = await fetchApi("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as Envelope<Workspace>).data.name).toBe(name);
    expect((await fetchApi("/api/workspaces")).status).toBe(200);
  });
});

describe("live domain registry", () => {
  it("starts empty and registers a normalized public hostname idempotently", async () => {
    const workspace = workspaceId("register");
    const empty = ((await (await domainRequest(workspace, "")).json()) as Envelope<Domain[]>).data;
    expect(empty).toEqual([]);
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:stable-key" },
      body: JSON.stringify({ hostname: "WWW.Cloudflare.COM." }),
    };
    const first = await domainRequest(workspace, "", init);
    const second = await domainRequest(workspace, "", init);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const created = ((await first.json()) as Envelope<{ domain: Domain; duplicate: boolean }>).data;
    expect(created).toMatchObject({
      duplicate: false,
      domain: { hostname: "www.cloudflare.com", healthStatus: "unknown", latestDiagnostic: null },
    });
    expect(((await second.json()) as Envelope<{ duplicate: boolean }>).data.duplicate).toBe(true);
  });
  it("accepts an HTTPS URL and stores only its normalized hostname", async () => {
    const workspace = workspaceId("url");
    const response = await domainRequest(workspace, "", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:url-input" },
      body: JSON.stringify({ hostname: "https://www.cloudflare1234.com/" }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as Envelope<{ domain: Domain }>).data.domain.hostname).toBe(
      "www.cloudflare1234.com",
    );
  });
  it("keeps domains isolated by workspace", async () => {
    const first = workspaceId("one"),
      second = workspaceId("two");
    const registered = await domainRequest(first, "", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:isolation" },
      body: JSON.stringify({ hostname: "status.cloudflare.com" }),
    });
    const domain = ((await registered.json()) as Envelope<{ domain: Domain }>).data.domain;
    const cross = await domainRequest(second, `/${domain.id}`);
    expect(cross.status).toBe(404);
    await expect(cross.json()).resolves.toMatchObject({ error: { code: "DOMAIN_NOT_FOUND" } });
  });
  it("rejects reserved and non-public hostnames", async () => {
    const workspace = workspaceId("safe");
    const blocked = await domainRequest(workspace, "", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:blocked" },
      body: JSON.stringify({ hostname: "internal.example" }),
    });
    expect(blocked.status).toBe(400);
  });

  it("persists real checks idempotently and derives health from the latest snapshot", async () => {
    const workspace = workspaceId("history");
    const registered = await domainRequest(workspace, "", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:history" },
      body: JSON.stringify({ hostname: "developers.cloudflare.com" }),
    });
    const domain = ((await registered.json()) as Envelope<{ domain: Domain }>).data.domain;
    const store = env.WorkspaceDomainStore.get(env.WorkspaceDomainStore.idFromName(workspace));
    const preparation = await store.prepareDiagnostic(workspace, domain.id, "diagnostic:history");
    expect(preparation).toMatchObject({ ok: true, value: { shouldRun: true } });
    if (!preparation.ok) throw new Error("Preparation failed");
    const completed = await store.completeDiagnostic(
      workspace,
      domain.id,
      "diagnostic:history",
      preparation.value.requestId,
      diagnosticRun("developers.cloudflare.com"),
    );
    expect(completed).toMatchObject({ ok: true, value: { status: "healthy" } });
    const replay = await store.prepareDiagnostic(workspace, domain.id, "diagnostic:history");
    expect(replay).toMatchObject({ ok: true, value: { duplicate: true, shouldRun: false } });
    const current = await store.getDomain(workspace, domain.id);
    expect(current).toMatchObject({
      ok: true,
      value: { healthStatus: "healthy", lastCheckedAt: "2026-10-25T12:00:00.000Z" },
    });
    const history = await store.getDiagnosticHistory(workspace, domain.id);
    expect(history).toMatchObject({ ok: true, value: [{ source: "live_public", changes: [] }] });
  });

  it("rolls back lock release when diagnostic persistence fails", async () => {
    const workspace = workspaceId("atomic");
    const registered = await domainRequest(workspace, "", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "register:atomic" },
      body: JSON.stringify({ hostname: "blog.cloudflare.com" }),
    });
    const domain = ((await registered.json()) as Envelope<{ domain: Domain }>).data.domain;
    const store = env.WorkspaceDomainStore.get(env.WorkspaceDomainStore.idFromName(workspace));
    const preparation = await store.prepareDiagnostic(workspace, domain.id, "diagnostic:atomic");
    if (!preparation.ok) throw new Error("Preparation failed");
    const invalid = {
      ...diagnosticRun(domain.hostname),
      status: "invalid",
    } as unknown as LiveDiagnosticRun;
    expect(
      await store.completeDiagnostic(
        workspace,
        domain.id,
        "diagnostic:atomic",
        preparation.value.requestId,
        invalid,
      ),
    ).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(await store.prepareDiagnostic(workspace, domain.id, "diagnostic:second")).toMatchObject({
      ok: false,
      error: { code: "DIAGNOSTIC_IN_PROGRESS" },
    });
    expect(
      await store.failDiagnostic(
        workspace,
        domain.id,
        "diagnostic:atomic",
        preparation.value.requestId,
      ),
    ).toMatchObject({ ok: true });
  });
});

function fetchApi(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://domainops.test${path}`, init), env);
}
function domainRequest(workspace: string, suffix: string, init?: RequestInit) {
  return fetchApi(`/api/workspaces/${workspace}/domains${suffix}`, init);
}
function workspaceId(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function diagnosticRun(hostname: string): LiveDiagnosticRun {
  return {
    id: "replaced-by-service",
    workspaceId: "replaced-by-service",
    domainId: "replaced-by-service",
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
      responseTimeMs: 30,
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
