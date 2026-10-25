# DomainOps AI

DomainOps AI is a Cloudflare-native reference application for custom-domain onboarding and troubleshooting. It combines a React dashboard with a stateful AI assistant, durable validation workflows, and SQLite-backed history.

The first version intentionally uses deterministic simulated DNS, hostname, and certificate results. The AI, Durable Object persistence, WebSocket communication, and Workflow execution use the real Cloudflare developer platform.

## Stack

- TypeScript and React 19
- Cloudflare Workers and Static Assets
- Cloudflare Agents SDK with `AIChatAgent` and `useAgentChat`
- Workers AI with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- SQLite-backed Durable Objects
- Cloudflare Workflows
- Vite, Wrangler, and the Cloudflare Vitest integration

## What is included

- Register simulated custom domains from the dashboard.
- Track DNS, hostname activation, and certificate status.
- Preserve an immutable status-change history in Durable Object SQLite.
- Run deterministic validation scenarios through a real Cloudflare Workflow.
- Ask an AI assistant to list or inspect domains and request validation retries.
- Persist and resume chat history through `AIChatAgent`.

This is an independent implementation based on Cloudflare's public documentation. It is not connected to HubSpot systems, data, or source code.

## Get started

Prerequisites:

- Node.js 22 or newer
- A Cloudflare account
- Wrangler authentication via `npx wrangler login` or `CLOUDFLARE_API_TOKEN`

Install and generate binding types:

```bash
npm install
npm run types
```

Start local development:

```bash
npm run dev
```

Open `http://localhost:5173`. Durable Objects and Workflows run locally. Workers AI has no local simulator, so chat inference uses the remote `AI` binding and requires Cloudflare authentication.

Run validation:

```bash
npm run check
```

Deploy:

```bash
npm run deploy
```

## Simulation scenarios

Registration accepts one of four reproducible scenarios:

- `healthy`: DNS, hostname activation, and certificate issuance succeed.
- `missing_cname`: DNS validation fails because the expected CNAME is absent.
- `pending_hostname`: DNS succeeds while hostname activation remains pending.
- `certificate_error`: DNS and hostname activation succeed, then certificate issuance fails.

Every simulated result is labeled `simulation` in stored records and the UI. A future production adapter can implement the same provider boundary using Cloudflare for SaaS APIs.

## Project structure

```text
src/
  agent/       Stateful AI agent and SQLite repository boundary
  domain/      Domain types, hostname validation, and simulator
  workflows/   Durable validation workflow
  app.tsx      React dashboard and chat
  client.tsx   Browser entry point
  server.ts    Worker entry point and Agent routing
docs/
  architecture.md
test/
```

See [docs/architecture.md](docs/architecture.md) for component responsibilities, data flow, and current constraints.

## Current limitations

- Domain and certificate checks are simulated; no Cloudflare for SaaS API calls are made.
- The demo uses one Agent instance named `demo`. Production must derive the Agent name from authenticated tenant identity.
- Workers AI calls are excluded from automated tests because inference is remote.
- Llama 3.3 is configurable in code, but workflow correctness never depends on model output.

## Useful documentation

- [Cloudflare Agents](https://developers.cloudflare.com/agents/)
- [`AIChatAgent` and `useAgentChat`](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Agent state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/)
- [Agents with Workflows](https://developers.cloudflare.com/agents/concepts/workflows/)
- [Workers AI model](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
- [Cloudflare for SaaS common API calls](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/common-api-calls/)
