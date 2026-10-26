<div align="center">

# 🌐 DomainOps AI

**AI-powered domain diagnostics and troubleshooting on Cloudflare**

[![Live Demo](https://img.shields.io/badge/🚀_Launch_Live_Demo-Visit_App-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://domainops-ai.nehal-d-patil7.workers.dev)

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Workers AI](https://img.shields.io/badge/Workers-AI-blue)
![Durable Objects](https://img.shields.io/badge/Durable_Objects-SQLite-green)

<p> Access: Authentication is managed through Cloudflare Zero Trust. <br>
Sign-in requires an authorized email address. Sign-Up can be done using email, SSO or another IAM provider like Google, Apple, etc. </p>

</div>


# DomainOps AI
DomainOps AI is a Cloudflare-native application for monitoring and troubleshooting public domains. It records real public DNS and HTTPS observations, keeps workspace-isolated history, and gives a stateful Workers AI copilot grounded in those results.

It does **not** report Cloudflare for SaaS custom-hostname activation or internal certificate-provisioning status. Public HTTPS reachability is a separate signal.

<img width="500" height="300" alt="Screenshot 2026-10-25 at 9 34 27 PM" src="https://github.com/user-attachments/assets/ad478547-da4d-4853-b212-f7e261419086" />
<img width="500" height="300" alt="Screenshot 2026-10-25 at 9 38 39 PM" src="https://github.com/user-attachments/assets/2931e077-ef0d-4a49-bfa7-147790bd67db" />

## Stack
- TypeScript, React 19, Vite, and Cloudflare Workers
- SQLite-backed Durable Objects for workspace registries, domain data, diagnostic history, and chat memory
- Cloudflare Agents SDK with `AIChatAgent` and `useAgentChat`
- Workers AI using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Cloudflare DNS over HTTPS plus safety-limited HTTPS probes

<img width="700" height="265" alt="image" src="https://github.com/user-attachments/assets/d6b8e4c9-a025-4e3e-a2b9-5ea78df681c4" />

## Local development
Requires Node.js 22+, npm, and Wrangler authentication for remote Workers AI inference.
```bash
npm install
npm run types
npx wrangler login
npm run dev
```

Run the quality gate with `npm run check`.

### Authentication before deployment
Production API and Agent routes fail closed unless Cloudflare Access is configured. Create an Access self-hosted application covering the entire deployed hostname, then configure these Worker variables:
```text
AUTH_MODE=cloudflare_access
CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CF_ACCESS_AUD=your-access-application-audience-tag
```

The Worker verifies the Access JWT signature, issuer, audience, expiry, and subject against the team JWKS. Forwarded identity headers alone are not trusted. `localhost`, `127.0.0.1`, and the test host use a fixed development identity; `AUTH_MODE=development` is available for an explicit non-production development deployment and must not be used publicly.

After configuring Access and the variables, deploy with `npm run deploy`.

## API
All successful responses include `meta.source: "live_public"`. Mutations that register a domain or run a check require an `Idempotency-Key` header containing 8–128 URL-safe characters.

| Method  | Route                                                        | Purpose                            |
| ------- | ------------------------------------------------------------ | ---------------------------------- |
| `GET`   | `/api/workspaces`                                            | List workspaces                    |
| `POST`  | `/api/workspaces`                                            | Create a workspace                 |
| `PATCH` | `/api/workspaces/:workspaceId`                               | Rename a workspace                 |
| `GET`   | `/api/workspaces/:workspaceId/domains`                       | List registered domains and health |
| `POST`  | `/api/workspaces/:workspaceId/domains`                       | Register a public hostname         |
| `GET`   | `/api/workspaces/:workspaceId/domains/:domainId`             | Get the latest domain health       |
| `GET`   | `/api/workspaces/:workspaceId/domains/:domainId/diagnostics` | Get saved checks and changes       |
| `POST`  | `/api/workspaces/:workspaceId/domains/:domainId/diagnostics` | Run and persist a public check     |

Registration accepts a hostname or an HTTP(S) URL. URLs are reduced to their hostname; credentials, custom ports, non-HTTP schemes, IP literals, and reserved/internal hostnames are rejected.

```json
{ "hostname": "www.example.com" }
```

```json
{ "hostname": "https://www.example.com/" }
```

Health is derived from the latest immutable diagnostic snapshot:

- **Healthy** — all completed public checks are healthy.
- **Needs attention** — the latest snapshot is degraded or failed.
- **Checking** — a check currently holds the domain’s short-lived run lock.
- **Unknown** — no completed check exists.

## Diagnostics and safety
Each check queries `A`, `AAAA`, `CNAME`, `TXT`, and `CAA` through Cloudflare DNS over HTTPS. It follows at most four CNAME hops and records the chain. DNS requests time out after three seconds and `NXDOMAIN` is distinct from resolver errors and empty record sets.

The resolver performs a second bounded address/CNAME snapshot immediately before HTTPS. HTTPS is skipped if either snapshot is incomplete, includes a non-public target, exceeds the CNAME bound, or differs from the first snapshot. A permitted target receives an HTTPS `HEAD` request on port 443 with redirects handled manually and a five-second timeout. Servers returning `405` or `501` receive one bounded `GET` fallback with `Range: bytes=0-0`; its body is cancelled after headers.

The probe follows at most three `301`, `302`, `307`, or `308` responses. Every destination must use HTTPS, pass hostname validation, return two stable public A/AAAA snapshots, and not revisit an earlier URL. A healthy destination produces **Healthy (Redirected)**. Unsafe, unresolved, unsupported, or over-limit destinations produce **Redirect Detected (Unverified)**; redirect loops are explicit failures. Original and final URLs plus every hop remain in the saved observation.

The service rejects reserved/internal hostnames and blocks HTTPS probes when DNS or any CNAME hop returns private, loopback, link-local, carrier-grade NAT, documentation, multicast, reserved, or unique-local addresses. A complete diagnostic is bounded to 34 outbound requests in the worst-case four-hop/HEAD-fallback path. It permits one active run per domain, caches a completed result for 30 seconds, requires idempotency keys, and retains the newest 50 snapshots.

Workers `fetch()` does not expose peer certificate issuer, SAN, serial, or expiry metadata. DomainOps records only whether HTTPS was reachable and whether the TLS handshake succeeded; unavailable certificate metadata is always labeled as such. DNS preflight cannot pin the later request to the observed IP, so Cloudflare runtime outbound restrictions remain an additional SSRF boundary.

## AI copilot
Each workspace uses a separately named `DomainOpsChatAgent`, so conversation memory does not cross workspaces. The model can register domains, list inventory, inspect current DNS/HTTPS evidence, review history and changes, and diagnose observed problems. Registration and a subsequent check can be chained only when the user explicitly requests them; the model may use a domain from recent conversation context.

Tools are used only when domain facts or actions are needed—not for greetings or general explanations. The chat renders every tool name, target, progress, and a compact result; raw JSON stays hidden unless the user asks for it. Tool results can expose safe action buttons, such as registering a missing hostname or running a fresh check. The prompt treats DNS values, HTTP headers, redirects, and tool errors as untrusted data, requires concise observed facts/possible causes/next steps, and reserves later model steps for a complete natural-language answer.

## Migration from the earlier demo
On first access, each existing workspace Durable Object creates the new live-only tables and copies existing non-demo domain identities and public diagnostic snapshots. The four former seeded `.demo.example` rows are not copied. Legacy simulation tables are no longer read or written, while real hostname IDs and their live history remain available.

The global workspace catalog cannot enumerate pre-existing Durable Objects. On first UI load with an empty catalog, the former default `demo-acme` object is registered as **Primary workspace**, preserving its real domains and public checks. Other previously hand-entered workspace IDs can be recovered by requesting their domain API once, which adds them to the catalog.

## Current limitations
- Workspace authorization currently supports one owning Access identity per workspace; shared-team membership and ownership transfer are not implemented.
- Domain storage is ASCII. Standard HTTP(S) URL parsing converts supported internationalized hostnames to punycode; direct hostname input must already be ASCII.
- Results are point-in-time observations and can differ across resolvers during propagation.
- TLS certificate metadata is unavailable in the Workers fetch API.
- Public checks cannot reveal any provider’s internal hostname or certificate lifecycle state.

See [docs/architecture.md](docs/architecture.md) for component boundaries and migration details.

## Cloudflare documentation
- [Agents](https://developers.cloudflare.com/agents/)
- [`AIChatAgent` and `useAgentChat`](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Workers AI Llama 3.3 70B](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
- [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/api/sql-storage/)
- [DNS over HTTPS](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
