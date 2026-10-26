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
    expect(fetcher).toHaveBeenCalledTimes(8);
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

  it("classifies NXDOMAIN explicitly and never attempts HTTPS", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "cloudflare-dns.com") throw new Error("HTTPS must not be called");
      return Response.json({ Status: 3 });
    });
    const result = await runLiveDiagnostics("missing.public.net", { fetcher });
    expect(result).toMatchObject({
      status: "failed",
      safety: { allowed: false },
      https: { status: "skipped", classification: "skipped" },
    });
    expect(result.dns.every((query) => query.status === "nxdomain")).toBe(true);
    expect(result.findings).toContain(
      "The hostname returned NXDOMAIN and does not currently exist in public DNS.",
    );
  });

  it("falls back to a bounded GET when a reachable server rejects HEAD", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.hostname === "cloudflare-dns.com")
        return dnsResponse(url.searchParams.get("type")!, "head.public.net", "104.16.1.2");
      methods.push(init?.method ?? "GET");
      return new Response(null, { status: init?.method === "HEAD" ? 405 : 206 });
    });
    const result = await runLiveDiagnostics("head.public.net", { fetcher });
    expect(methods).toEqual(["HEAD", "GET"]);
    expect(result).toMatchObject({
      status: "healthy",
      https: { status: "reachable", method: "GET", statusCode: 206, classification: "success" },
    });
  });

  it("blocks HTTPS when public DNS changes between safety snapshots", async () => {
    let aQueries = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "cloudflare-dns.com") throw new Error("HTTPS must not be called");
      const type = url.searchParams.get("type")!;
      if (type === "A") {
        aQueries++;
        return dnsAnswer("A", "rebind.public.net", aQueries === 1 ? "104.16.1.2" : "104.16.1.3");
      }
      if (type === "AAAA") return Response.json({ Status: 0 });
      return Response.json({ Status: 0 });
    });
    const result = await runLiveDiagnostics("rebind.public.net", { fetcher });
    expect(result).toMatchObject({
      status: "failed",
      safety: { allowed: false, resolutionStable: false },
      https: { status: "skipped" },
    });
  });

  it("follows a bounded public CNAME chain and records each hop", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "cloudflare-dns.com") return new Response(null, { status: 200 });
      const name = url.searchParams.get("name")!;
      const type = url.searchParams.get("type")!;
      if (name === "alias.public.net" && type === "CNAME")
        return dnsAnswer("CNAME", name, "edge.public.net.");
      if (name === "edge.public.net" && type === "A") return dnsAnswer("A", name, "104.16.1.2");
      return Response.json({ Status: 0 });
    });
    const result = await runLiveDiagnostics("alias.public.net", { fetcher });
    expect(result).toMatchObject({
      status: "healthy",
      cnameChain: [{ from: "alias.public.net", to: "edge.public.net", depth: 1 }],
      publicAddresses: ["104.16.1.2"],
      safety: { allowed: true, resolutionStable: true },
    });
  });

  it("records and blocks a CNAME that targets an internal hostname", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.hostname !== "cloudflare-dns.com") throw new Error("HTTPS must not be called");
      const type = url.searchParams.get("type")!;
      if (type === "CNAME") return dnsAnswer("CNAME", "alias.public.net", "metadata.internal.");
      return Response.json({ Status: 0 });
    });
    const result = await runLiveDiagnostics("alias.public.net", { fetcher });
    expect(result).toMatchObject({
      status: "failed",
      safety: {
        allowed: false,
        reason: expect.stringContaining("not a permitted public hostname"),
      },
      https: { status: "skipped" },
    });
  });
});

describe("live diagnostic network safety", () => {
  it.each(["localhost", "service.internal", "app.local", "demo.example", "ftp://public.com"])(
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

function dnsAnswer(type: string, hostname: string, value: string): Response {
  const typeNumber: Record<string, number> = { A: 1, AAAA: 28, CNAME: 5, TXT: 16, CAA: 257 };
  return Response.json({
    Status: 0,
    Answer: [{ name: `${hostname}.`, type: typeNumber[type], TTL: 300, data: value }],
  });
}
