# DomainOps AI

DomainOps AI is a Cloudflare-native reference application for custom-domain onboarding and AI-assisted troubleshooting.

The application uses real Cloudflare Workers, SQLite-backed Durable Objects, Workflows, the Agents SDK, and Workers AI. DNS, custom-hostname, and certificate provider results are deterministic simulations, clearly labeled as such in the API, tools, and dashboard. It is an independent implementation based on public Cloudflare documentation and is not connected to HubSpot systems, data, or source code.

## Included now

- Workspace-isolated domain registration and inventory
- Expected and observed DNS records
- Independent hostname activation and SSL certificate statuses
- Required hostname ownership and certificate validation records
- Deterministic revalidation through Cloudflare Workflows
- SQLite-backed status, retry, timestamp, and diagnostic event history
- Idempotent registration and revalidation mutations
- Four seeded examples per demo workspace: active, incorrect DNS, pending SSL, and validation failure
- React dashboard for registration, inspection, and retries
- Persistent, streaming `AIChatAgent` conversations scoped to each workspace
- Read-only backend tools for inventory, status, DNS/SSL details, history, and deterministic diagnosis
- Workers AI inference with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

## Stack

- TypeScript and React 19
- Cloudflare Workers and Static Assets
- SQLite-backed Durable Objects
- Cloudflare Workflows
- Cloudflare Agents SDK, `AIChatAgent`, and `useAgentChat`
- Workers AI and Llama 3.3 70B Instruct FP8 Fast
- Vite, Wrangler, and Cloudflare's Vitest integration

## Get started

Prerequisites are Node.js 22 or newer and npm.

```bash
npm install
npm run types
npx wrangler login
npm run dev
```

Open `http://localhost:5173`. The Durable Objects and Workflow run in the local Cloudflare runtime. Domain management needs no production Cloudflare for SaaS configuration. Chat inference uses the remote Workers AI binding because there is no local model emulator, so Wrangler authentication is required to start the complete application.

Run the full quality gate:

```bash
npm run check
```

Deploy after authenticating Wrangler:

```bash
npm run deploy
```

## API

All domain responses include `meta.simulated: true`. Replace `:workspaceId` with a lowercase demo workspace ID and `:domainId` with a returned UUID.

| Method | Route                                                       | Purpose                                                            |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET`  | `/api/workspaces/:workspaceId/domains`                      | List domains                                                       |
| `POST` | `/api/workspaces/:workspaceId/domains`                      | Register a domain                                                  |
| `GET`  | `/api/workspaces/:workspaceId/domains/:domainId`            | Get current domain state                                           |
| `GET`  | `/api/workspaces/:workspaceId/domains/:domainId/dns`        | Compare expected and observed DNS and show validation requirements |
| `GET`  | `/api/workspaces/:workspaceId/domains/:domainId/history`    | List diagnostic and status events                                  |
| `POST` | `/api/workspaces/:workspaceId/domains/:domainId/revalidate` | Start a durable revalidation                                       |

Mutation requests require an `Idempotency-Key` header with 8–128 URL-safe characters. Registration also requires `Content-Type: application/json`:

```json
{
  "hostname": "app.customer.example",
  "expectedDnsTarget": "customers.domainops.example",
  "observedDnsRecord": "customers.domainops.example",
  "simulationProfile": "pending_ssl"
}
```

Supported profiles are `active`, `incorrect_dns`, `pending_ssl`, and `validation_failure`. Omitting a profile defaults to `pending_ssl`. Replaying an identical mutation with the same idempotency key returns its existing result without creating another transition or event. Reusing the key for different input returns `409 IDEMPOTENCY_KEY_REUSED`.

## Readiness and status semantics

Hostname and SSL status are stored independently. A domain is ready only when:

- DNS status is `valid`;
- hostname status is `active`;
- SSL status is `active`; and
- validation state is `active`.

SSL values mirror useful Cloudflare for SaaS concepts such as `pending_validation`, `pending_issuance`, `pending_deployment`, `active`, and timeout/failure states. They are simulated here and do not represent a live Cloudflare zone.

## AI assistant

Each workspace connects to its own `DomainOpsChatAgent` Durable Object. `AIChatAgent` stores the multi-turn transcript in SQLite and `useAgentChat` provides WebSocket streaming, reconnection, and history loading.

The model has five server-side tools:

- `listDomains`
- `getDomainStatus`
- `getDnsConfiguration`
- `getValidationHistory`
- `diagnoseDomain`

The first model step of every turn must call a tool. Tool inputs never accept a workspace ID; the server derives the workspace from the Agent instance name and calls the existing `WorkspaceDomainStore`. Ambiguous matches return candidates and instruct the assistant to ask for clarification. Not-found and backend-error results explicitly prohibit inferred state. `diagnoseDomain` separates confirmed blockers from possible causes and recommended actions.

All five tools are read-only. Registration and revalidation remain dashboard/API operations and are not available to the model.

## Project structure

```text
src/
  agent/            AIChatAgent and read-only backend tools
  api/              HTTP routing and response envelopes
  domain/           Validation, simulator, repository, and domain service
  durable-object/   WorkspaceDomainStore RPC boundary
  workflows/        Durable revalidation orchestration
  app.tsx           React domain dashboard
  chat-panel.tsx    Persistent streaming chat UI
  server.ts         Worker entry point
docs/
  architecture.md
test/
```

See [docs/architecture.md](docs/architecture.md) for persistence, request flow, and implementation constraints.

## Current limitations

- Provider checks are simulations; no Cloudflare for SaaS API is called.
- Demo workspace IDs are supplied by the client. Authentication and authorization must be added before production use.
- Internationalized hostnames are not converted with IDNA; inputs must be ASCII hostnames.
- There is no cross-workspace aggregate index because Durable Object SQLite is instance-local.
- Local chat requires Cloudflare authentication because Workers AI inference is remote.

## Relevant Cloudflare documentation

- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/api/sql-storage/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [Cloudflare for SaaS custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/)
- [Cloudflare for SaaS common API calls](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/common-api-calls/)
- [Cloudflare Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Cloudflare Agents](https://developers.cloudflare.com/agents/)
- [`AIChatAgent` and `useAgentChat`](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Llama 3.3 70B Instruct FP8 Fast](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
