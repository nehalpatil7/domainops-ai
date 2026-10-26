import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/domain/service";
import {
  normalizeHostname,
  parseRegisterDomainInput,
  validateWorkspaceName,
} from "../src/domain/validation";
import type { LiveDiagnosticRun } from "../src/domain/types";

describe("domain inputs", () => {
  it("normalizes public hostnames and accepts only the live registration shape", () => {
    expect(parseRegisterDomainInput({ hostname: "WWW.Cloudflare.COM." })).toEqual({
      hostname: "www.cloudflare.com",
    });
    expect(normalizeHostname("https://www.cloudflare1234.com/")).toBe("www.cloudflare1234.com");
    expect(() => normalizeHostname("ftp://cloudflare.com")).toThrow();
    expect(() => normalizeHostname("https://user:secret@cloudflare.com")).toThrow();
    expect(() => normalizeHostname("https://cloudflare.com:8443")).toThrow();
  });
  it("validates workspace display names", () => {
    expect(validateWorkspaceName("  Platform   team ")).toBe("Platform team");
    expect(() => validateWorkspaceName(" ")).toThrow(/1-80/);
  });
});

describe("diagnostic changes", () => {
  it("highlights meaningful health, DNS, HTTPS, and TLS changes", () => {
    const previous = run({
      status: "failed",
      dnsStatus: "no_records",
      https: "unreachable",
      tls: "failed",
    });
    const current = run({
      status: "healthy",
      dnsStatus: "success",
      https: "reachable",
      tls: "succeeded",
    });
    expect(compareRuns(previous, current)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "overall", current: "healthy" }),
        expect.objectContaining({ area: "dns", current: "A: success" }),
        expect.objectContaining({ area: "https", current: "reachable" }),
        expect.objectContaining({ area: "tls", current: "succeeded" }),
      ]),
    );
  });
  it("does not invent changes for a first observation", () =>
    expect(compareRuns(undefined, run({}))).toEqual([]));
  it("detects changed DNS values even when the query status is unchanged", () => {
    const previous = run({ address: "104.16.1.2" });
    const current = run({ address: "104.16.1.3" });
    expect(compareRuns(previous, current)).toContainEqual(
      expect.objectContaining({ area: "dns", message: expect.stringContaining("records changed") }),
    );
  });
});

function run(options: {
  status?: LiveDiagnosticRun["status"];
  dnsStatus?: "success" | "no_records";
  https?: "reachable" | "unreachable";
  tls?: "succeeded" | "failed";
  address?: string;
}): LiveDiagnosticRun {
  return {
    id: crypto.randomUUID(),
    workspaceId: "ws-test",
    domainId: crypto.randomUUID(),
    hostname: "www.cloudflare.com",
    source: "live_public",
    status: options.status ?? "healthy",
    observedAt: "2026-10-25T12:00:00.000Z",
    completedAt: "2026-10-25T12:00:01.000Z",
    durationMs: 1000,
    dnsProvider: "Cloudflare DNS over HTTPS",
    dns: [
      {
        type: "A",
        status: options.dnsStatus ?? "success",
        responseCode: 0,
        responseCodeName: "NOERROR",
        records: options.address
          ? [{ type: "A", name: "www.cloudflare.com", value: options.address, ttl: 300 }]
          : [],
        error: null,
      },
    ],
    publicAddresses: ["104.16.1.2"],
    safety: { allowed: true, blockedAddresses: [], reason: null },
    https: {
      status: options.https ?? "reachable",
      url: "https://www.cloudflare.com/",
      statusCode: 200,
      responseTimeMs: 30,
      redirectLocation: null,
      headers: {},
      error: null,
    },
    tls: {
      handshake: options.tls ?? "succeeded",
      certificateMetadataAvailable: false,
      limitation: "Certificate metadata unavailable.",
    },
    findings: [],
    limitations: [],
  };
}
