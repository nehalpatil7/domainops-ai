# DomainOps AI architecture

## Goals

DomainOps AI demonstrates a stateful, Cloudflare-native domain onboarding system without requiring a production Cloudflare for SaaS account. The initial scope favors understandable boundaries over a feature-complete control plane.

The system keeps these concerns separate:

1. Product state and history are deterministic and durable.
2. The AI explains and invokes narrow tools; it is not the source of truth.
3. Long-running validation is owned by a Workflow, not a chat request.
4. Simulated provider behavior can later be replaced by production API calls.

## Components

```text
Browser
  React dashboard
  useAgent + useAgentChat
       │ WebSocket / HTTP
       ▼
Worker entry point
  routeAgentRequest
       │
       ▼
DomainOpsAgent (one Durable Object per workspace)
  AIChatAgent message persistence
  SQLite domain tables and event history
  callable dashboard methods
  narrow AI tools
       │
       ├── Workers AI / Llama 3.3
       │
       └── DomainValidationWorkflow
             durable steps, retries, sleeps, progress
                    │
                    ▼
             DomainProvider boundary
             SimulatedDomainProvider today
             CloudflareForSaaSProvider later
```

## Runtime responsibilities

### React client

- Connects to the workspace Agent named `demo` via `useAgent`.
- Uses `useAgentChat` for persisted streaming messages and tool approvals.
- Calls decorated Agent methods for domain registration, listing, history, and retry.
- Refreshes domain records when the Agent broadcasts a lightweight revision update.
- Labels all provider results as simulated.

### Worker

`src/server.ts` exports the Durable Object and Workflow classes required by Wrangler. It routes `/agents/*` traffic through the Agents SDK and exposes a small `/api/health` endpoint. Static assets are handled by Workers Static Assets.

### DomainOpsAgent

One named Agent represents one workspace. For this demo, the client always uses `demo`; production must derive this name from authenticated tenant identity.

`AIChatAgent` owns its message/session tables. DomainOps AI owns two additional SQLite tables:

```text
domains
  id, hostname, scenario
  dns_status, hostname_status, certificate_status
  active_workflow_id
  source, created_at, updated_at, last_checked_at

domain_status_events
  id, domain_id, category
  previous_status, next_status, reason
  source, workflow_id, created_at
```

Canonical domain records live in SQL. Agent state only holds a revision number and current workflow progress, keeping WebSocket state broadcasts small.

### AI layer

The assistant receives persisted chat history and uses Workers AI model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

Tools are deliberately narrow:

- `listDomains`: read-only overview.
- `inspectDomain`: domain state plus status history.
- `retryDomainValidation`: mutating operation requiring user approval.

Tool results come from SQLite, never from model-generated assumptions. `stepCountIs` bounds a model/tool loop. Workflow control never depends on LLM output.

### Validation Workflow

`DomainValidationWorkflow` performs DNS, hostname activation, and certificate phases as durable steps. Each step:

1. Calculates a deterministic provider result.
2. Persists changes through Agent RPC.
3. Appends immutable events only when a status changes.
4. Reports progress to connected clients.

Workflow step names and instance IDs act as idempotency boundaries. Durable sleeps model propagation without holding compute.

### Provider boundary

The simulator implements four deterministic scenarios. A production adapter will map the same conceptual operations to Cloudflare for SaaS APIs:

- create/get custom hostname;
- inspect hostname ownership and activation;
- inspect `ssl.status` and validation records;
- restart validation; and
- delete a custom hostname.

Production readiness must require hostname status `active`, certificate status `active`, and DNS pointing at the configured SaaS target. A TLS handshake alone is not sufficient.

## Local and production behavior

| Capability              | Local development       | Production                                   |
| ----------------------- | ----------------------- | -------------------------------------------- |
| React and Worker        | Local Vite/workerd      | Cloudflare edge                              |
| Durable Object + SQLite | Local simulation        | Cloudflare Durable Object                    |
| Workflow                | Local simulation        | Cloudflare Workflow                          |
| Workers AI              | Remote binding          | Remote binding                               |
| Domain provider         | Deterministic simulator | Simulator until a real adapter is configured |

Workers AI has no local model emulator. Automated tests therefore exercise the provider state machine, SQLite/RPC boundaries, and routes without invoking inference.

## Security and production follow-ups

- Add authentication before accepting tenant or Agent identifiers.
- Authorize every callable mutation and server-side tool.
- Store Cloudflare API credentials only as Worker secrets.
- Add explicit idempotency keys for production provider mutations.
- Validate and normalize internationalized domain names according to product policy.
- Add rate limiting, audit identity, structured logs, and retention controls.
- Move cross-workspace reporting to D1 or another aggregate store; Durable Object SQL is intentionally instance-local.
- Add an opt-in integration suite against a dedicated Cloudflare test zone before enabling the production adapter.
