import { env } from "cloudflare:workers";
import { introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/server";

describe("Worker entry point", () => {
  it("reports simulation mode from the health route", async () => {
    const response = await worker.fetch(new Request("https://domainops.test/api/health"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "domainops-ai",
      status: "ok",
      provider: "simulation",
    });
  });
});

describe("DomainOpsAgent", () => {
  it("persists a registered domain and initial history in SQLite", async () => {
    const id = env.DomainOpsAgent.idFromName("registration-test");
    const agent = env.DomainOpsAgent.get(id);
    const workflow = await introspectWorkflow(env.DOMAIN_VALIDATION_WORKFLOW);

    try {
      await workflow.modifyAll(async (modifier) => {
        await modifier.disableSleeps();
      });
      expect(await agent.listDomains()).toEqual([]);

      const registration = await agent.registerDomain({
        hostname: "App.Example.COM.",
        scenario: "healthy",
      });
      const instances = await workflow.get();

      expect(registration.workflowId).toMatch(/^validation_/);
      expect(instances).toHaveLength(1);
      await instances[0].waitForStatus("complete");
      await expect(instances[0].getOutput()).resolves.toMatchObject({
        domainId: registration.domain.id,
        ready: true,
        finalPhase: "certificate",
      });

      const domains = await agent.listDomains();
      const history = await agent.getDomainHistory("app.example.com");
      expect(domains).toHaveLength(1);
      expect(domains[0]).toMatchObject({
        hostname: "app.example.com",
        scenario: "healthy",
        source: "simulation",
        dnsStatus: "valid",
        hostnameStatus: "active",
        certificateStatus: "active",
        ready: true,
      });
      expect(history.some((event) => event.nextStatus === "registered")).toBe(true);
      expect(history.some((event) => event.nextStatus === "complete")).toBe(true);
    } finally {
      await workflow.dispose();
    }
  });
});
