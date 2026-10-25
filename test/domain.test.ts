import { describe, expect, it } from "vitest";
import { normalizeHostname } from "../src/domain/hostname";
import { simulateValidationPhase } from "../src/domain/simulated-provider";

describe("hostname normalization", () => {
  it("normalizes case and a trailing root dot", () => {
    expect(normalizeHostname(" App.Customer.COM. ")).toBe("app.customer.com");
  });

  it.each([
    "",
    "localhost",
    "https://app.example.com",
    "app.example.com/path",
    "-bad.example.com",
    "bad_.example.com",
  ])("rejects invalid input %s", (value) => {
    expect(() => normalizeHostname(value)).toThrow();
  });
});

describe("simulated domain provider", () => {
  it("moves a healthy domain through every phase", () => {
    const dns = simulateValidationPhase("healthy", "dns");
    const hostname = simulateValidationPhase("healthy", "hostname");
    const certificate = simulateValidationPhase("healthy", "certificate");

    expect(dns.statuses.dnsStatus).toBe("valid");
    expect(dns.terminal).toBe(false);
    expect(hostname.statuses.hostnameStatus).toBe("active");
    expect(hostname.terminal).toBe(false);
    expect(certificate.statuses.certificateStatus).toBe("active");
    expect(certificate.ready).toBe(true);
    expect(certificate.terminal).toBe(true);
  });

  it("stops at a missing CNAME", () => {
    const result = simulateValidationPhase("missing_cname", "dns");
    expect(result.statuses).toEqual({
      dnsStatus: "invalid",
      hostnameStatus: "pending",
      certificateStatus: "pending",
    });
    expect(result.terminal).toBe(true);
    expect(result.ready).toBe(false);
  });

  it("keeps hostname activation pending deterministically", () => {
    const result = simulateValidationPhase("pending_hostname", "hostname");
    expect(result.statuses.hostnameStatus).toBe("pending");
    expect(result.terminal).toBe(true);
  });

  it("records a certificate issuance failure", () => {
    const result = simulateValidationPhase("certificate_error", "certificate");
    expect(result.statuses.certificateStatus).toBe("error");
    expect(result.ready).toBe(false);
  });
});
