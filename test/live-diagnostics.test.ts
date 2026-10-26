import { describe, expect, it, vi } from "vitest";
import { runLiveDiagnostics } from "../src/live/live-diagnostics";
import { isPublicIpAddress, validateLiveHostname } from "../src/live/network-safety";

describe("live public diagnostics", () => {
  it("collects public DNS and HTTPS facts without fabricating certificate metadata", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname === "cloudflare-dns.com") {
        return dnsResponse(url.searchParams.get("type")!, "www.public.example.net", "104.16.1.2");
      }
      return new Response(null, {
        status: 200,
        headers: {
          server: "cloudflare",
          "strict-transport-security": "max-age=31536000",
        },
      });
    });
    const times = [new Date("2026-10-26T00:00:00.000Z"), new Date("2026-10-26T00:00:01.000Z")];
    const result = await runLiveDiagnostics("www.public.example.net", {
      fetcher,
      now: () => times.shift()!,
      requestId: "run-1",
    });

    expect(result).toMatchObject({
      id: "run-1",
      source: "live_public",
      status: "healthy",
      publicAddresses: ["104.16.1.2", "2606:4700::1"],
      safety: { allowed: true, blockedAddresses: [] },
      https: { status: "reachable", statusCode: 200 },
      tls: { handshake: "succeeded", certificateMetadataAvailable: false },
    });
    expect(result.dns.map((query) => query.type)).toEqual(["A", "AAAA", "CNAME", "TXT", "CAA"]);
    expect(result.tls.limitation).toMatch(/does not expose/);
    expect(JSON.stringify(result)).not.toContain("validationRecords");
  });

  it("blocks the HTTPS probe when DNS returns a private address", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "cloudflare-dns.com") throw new Error("HTTPS must not be called");
      return dnsResponse(url.searchParams.get("type")!, "private.public.net", "127.0.0.1");
    });
    const result = await runLiveDiagnostics("private.public.net", { fetcher });

    expect(result).toMatchObject({
      status: "failed",
      safety: { allowed: false, blockedAddresses: ["127.0.0.1"] },
      https: { status: "skipped" },
      tls: { handshake: "not_attempted" },
    });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("records DNS timeouts as partial evidence and continues safely", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "cloudflare-dns.com") return new Response(null, { status: 204 });
      if (url.searchParams.get("type") === "TXT") {
        throw new DOMException("timed out", "TimeoutError");
      }
      return dnsResponse(url.searchParams.get("type")!, "timeout.public.net", "104.16.1.2");
    });
    const result = await runLiveDiagnostics("timeout.public.net", { fetcher });

    expect(result.status).toBe("degraded");
    expect(result.dns.find((query) => query.type === "TXT")).toMatchObject({
      status: "timeout",
      error: "DNS over HTTPS request timed out.",
    });
    expect(result.https.status).toBe("reachable");
  });
});

describe("live diagnostic network safety", () => {
  it.each(["localhost", "service.internal", "app.local", "demo.example", "https://public.com"])(
    "rejects unsafe hostname %s",
    (hostname) => expect(() => validateLiveHostname(hostname)).toThrow(),
  );

  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "192.0.2.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::::",
  ])("rejects non-public address %s", (address) => expect(isPublicIpAddress(address)).toBe(false));

  it.each(["104.16.1.2", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => expect(isPublicIpAddress(address)).toBe(true),
  );
});

function dnsResponse(type: string, hostname: string, address: string): Response {
  const typeNumber: Record<string, number> = { A: 1, AAAA: 28, CNAME: 5, TXT: 16, CAA: 257 };
  const data: Record<string, string> = {
    A: address,
    AAAA: "2606:4700::1",
    CNAME: "edge.public.example.net.",
    TXT: '"public-verification=ok"',
    CAA: '0 issue "letsencrypt.org"',
  };
  return Response.json({
    Status: 0,
    Answer: [{ name: `${hostname}.`, type: typeNumber[type], TTL: 300, data: data[type] }],
  });
}
