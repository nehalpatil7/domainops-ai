import { describe, expect, it } from "vitest";
import {
  evaluateRevalidation,
  initialSimulationState,
  isDomainReady,
} from "../src/domain/simulation";
import {
  normalizeHostname,
  parseRegisterDomainInput,
  validateWorkspaceId,
} from "../src/domain/validation";

describe("input validation", () => {
  it("normalizes hostnames and defaults registration fields", () => {
    expect(normalizeHostname(" App.Customer.COM. ")).toBe("app.customer.com");
    expect(parseRegisterDomainInput({ hostname: "App.Customer.COM." })).toEqual({
      hostname: "app.customer.com",
      expectedDnsTarget: "customers.domainops.example",
      observedDnsRecord: undefined,
      simulationProfile: "pending_ssl",
    });
  });

  it.each(["", "localhost", "https://app.example.com", "app.example.com/path", "-bad.example.com"])(
    "rejects invalid hostname %s",
    (value) => expect(() => normalizeHostname(value)).toThrow(/valid fully-qualified hostname/),
  );

  it.each(["Uppercase", "spaces are bad", "too/clever"])(
    "rejects invalid workspace %s",
    (value) => {
      expect(() => validateWorkspaceId(value)).toThrow(/workspaceId/);
    },
  );
});

describe("deterministic simulated state", () => {
  it("keeps hostname and SSL statuses independent", () => {
    const state = initialSimulationState(
      "pending-ssl.demo.example",
      "customers.domainops.example",
      "pending_ssl",
    );
    expect(state.hostnameStatus).toBe("active");
    expect(state.sslStatus).toBe("pending_issuance");
    expect(
      isDomainReady(state.dnsStatus, state.hostnameStatus, state.sslStatus, state.validationState),
    ).toBe(false);
  });

  it("lets an explicit observed record override reveal a DNS mismatch", () => {
    const state = initialSimulationState(
      "active.customer.example",
      "customers.domainops.example",
      "active",
      "wrong-origin.customer.example",
    );
    expect(state).toMatchObject({
      dnsStatus: "invalid",
      hostnameStatus: "pending",
      sslStatus: "pending_validation",
      validationState: "dns_misconfigured",
    });
  });

  it("requires every readiness condition", () => {
    expect(isDomainReady("valid", "active", "active", "active")).toBe(true);
    expect(isDomainReady("valid", "active", "pending_deployment", "active")).toBe(false);
    expect(isDomainReady("valid", "pending", "active", "active")).toBe(false);
    expect(isDomainReady("invalid", "active", "active", "active")).toBe(false);
  });

  it("returns the same profile outcome for the same attempt", () => {
    const first = evaluateRevalidation("incorrect-dns.demo.example", "incorrect_dns", 2);
    const second = evaluateRevalidation("incorrect-dns.demo.example", "incorrect_dns", 2);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      dnsStatus: "invalid",
      hostnameStatus: "pending",
      sslStatus: "pending_validation",
      validationState: "dns_misconfigured",
    });
  });

  it("deterministically completes the pending SSL demo on its first retry", () => {
    expect(evaluateRevalidation("pending-ssl.demo.example", "pending_ssl", 1)).toMatchObject({
      dnsStatus: "valid",
      hostnameStatus: "active",
      sslStatus: "active",
      validationState: "active",
    });
  });
});
