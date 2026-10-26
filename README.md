# DomainOps AI

DomainOps AI is a Cloudflare-native application for monitoring and troubleshooting public domains. It records real public DNS and HTTPS observations, keeps workspace-isolated history, and gives a stateful Workers AI copilot grounded in those results.

It does **not** report Cloudflare for SaaS custom-hostname activation or internal certificate-provisioning status. Public HTTPS reachability is a separate signal.

## Stack

- TypeScript, React 19, Vite, and Cloudflare Workers
- SQLite-backed Durable Objects for workspace registries, domain data, diagnostic history, and chat memory
- Cloudflare Agents SDK with `AIChatAgent` and `useAgentChat`
- Workers AI using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Cloudflare DNS over HTTPS plus safety-limited HTTPS probes

## Local development

Requires Node.js 22+, npm, and Wrangler authentication for remote Workers AI inference.

```bash
npm install
npm run types
npx wrangler login
npm run dev
```

Run the quality gate with `npm run check`; deploy with `npm run deploy`.

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

Registration accepts only a hostname:

```json
{ "hostname": "www.example.com" }
```

Health is derived from the latest immutable diagnostic snapshot:

- **Healthy** — all completed public checks are healthy.
- **Needs attention** — the latest snapshot is degraded or failed.
- **Checking** — a check currently holds the domain’s short-lived run lock.
- **Unknown** — no completed check exists.

## Diagnostics and safety

Each check queries `A`, `AAAA`, `CNAME`, `TXT`, and `CAA` concurrently through Cloudflare DNS over HTTPS. DNS requests time out after three seconds. If every observed address is public, the Worker makes one HTTPS `HEAD` request on port 443 with redirects disabled and a five-second timeout.

The service rejects reserved/internal hostnames and blocks HTTPS probes when DNS returns private, loopback, link-local, carrier-grade NAT, documentation, multicast, reserved, or unique-local addresses. It permits one active run per domain, caches a completed result for 30 seconds, requires idempotency keys, and retains the newest 50 snapshots.

Workers `fetch()` does not expose peer certificate issuer, SAN, serial, or expiry metadata. DomainOps records only whether HTTPS was reachable and whether the TLS handshake succeeded; unavailable certificate metadata is always labeled as such. DNS preflight cannot pin the later request to the observed IP, so Cloudflare runtime outbound restrictions remain an additional SSRF boundary.

## AI copilot

Each workspace uses a separately named `DomainOpsChatAgent`, so conversation memory does not cross workspaces. The model can list domains, inspect current DNS/HTTPS evidence, review history and changes, and diagnose observed problems. It may run a new public diagnostic only when the user explicitly requests a check or refresh.

Every domain-specific response starts with a backend tool. Tool results include observation timestamps and freshness. The prompt requires concise answers separated into observed facts, possible causes, and next steps, and the final model step is text-only so a reply cannot end on an unfinished tool call.

## Migration from the earlier demo

On first access, each existing workspace Durable Object creates the new live-only tables and copies existing non-demo domain identities and public diagnostic snapshots. The four former seeded `.demo.example` rows are not copied. Legacy simulation tables are no longer read or written, while real hostname IDs and their live history remain available.

The global workspace catalog cannot enumerate pre-existing Durable Objects. On first UI load with an empty catalog, the former default `demo-acme` object is registered as **Primary workspace**, preserving its real domains and public checks. Other previously hand-entered workspace IDs can be recovered by requesting their domain API once, which adds them to the catalog.

## Current limitations

- Authentication and authorization are not implemented; workspace IDs must be bound to authenticated membership before production use.
- Unicode domains are not converted with IDNA; register ASCII hostnames.
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
- [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
