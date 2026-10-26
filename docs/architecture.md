# DomainOps AI architecture

## Request flow

```text
React dashboard ── REST ──> Worker API
       │                         │
       │                         ├── WorkspaceCatalog (global SQLite Durable Object)
       │                         │       workspace IDs + display names
       │                         │
       │                         └── WorkspaceDomainStore (one SQLite DO per workspace)
       │                                 domain registry + immutable diagnostic runs
       │                                           │
       │                                           └── DNS over HTTPS + HTTPS HEAD
       │
       └── useAgentChat WebSocket ──> DomainOpsChatAgent (one per workspace)
                                          chat history + Workers AI
                                                   │
                                                   └── scoped domain/check RPC tools
```

The Worker parses HTTP contracts and orchestrates network checks. `DomainService` owns validation, idempotency, run locking, and history comparisons. `DomainRepository` owns SQLite migration and workspace-scoped queries. The network probe remains isolated in `src/live/`.

## Component layout

The React shell has a sticky header containing workspace selection and management. The main dashboard is a responsive two-column grid: a searchable/filterable/sortable domain inventory and a selected-domain detail view. On narrow screens they stack. The copilot is a fixed right-side drawer with a backdrop, independent scroll areas, and a full-width mobile layout.

Workspace changes clear domain selection immediately and use a request epoch so a slower response from the previous workspace cannot overwrite current state. The selected workspace ID is stored in `localStorage`; its display name lives in the catalog.

## Storage and migration

`WorkspaceCatalog` stores stable workspace IDs and mutable display names. Renaming never changes the Durable Object or Agent instance key.

Each `WorkspaceDomainStore` contains:

- `registered_domains`: hostname identity and lifecycle timestamps;
- `diagnostic_runs`: immutable complete JSON snapshots, indexed newest-first;
- `diagnostic_state`: one short-lived active-run reservation per domain;
- `idempotency_records_v2`: normalized mutation request/result pairs;
- `workspace_metadata`: a permanent binding between the object and workspace ID.

Schema initialization is additive. If legacy tables exist, non-demo domain identities and their public live runs are copied with the same IDs into the live-only tables. Exact former seed hostnames are excluded. Application code never reads legacy provider statuses, validation records, or events. Keeping the legacy tables physically present avoids a risky destructive migration and permits safe rollback; they receive no new writes.

The global catalog cannot discover previously named Durable Objects. The UI registers the historical default object on an empty catalog, and any legacy workspace requested through the API is also added automatically.

## Health and history

Domain health is computed, not independently persisted:

| UI state        | Source                                       |
| --------------- | -------------------------------------------- |
| Healthy         | Latest diagnostic `status` is `healthy`      |
| Needs attention | Latest diagnostic is `degraded` or `failed`  |
| Checking        | A non-stale diagnostic reservation is active |
| Unknown         | No persisted result exists                   |

History compares each result with its immediate predecessor. Changes cover overall health, each DNS query status, HTTPS reachability, and TLS-handshake status. Partial DNS timeouts/errors remain explicit; they are not converted into fabricated negative records.

## Diagnostic safety and reliability

A check validates a normalized ASCII FQDN, queries only five supported record types, and proceeds to HTTPS only when every observed address is public. The HTTPS probe is fixed to port 443, uses `HEAD`, does not follow redirects, stores only selected headers, and has a bounded timeout. DNS queries also have independent timeouts.

The Durable Object supplies idempotency, a 60-second stale-lock boundary, 30-second completed-result reuse, and a 50-result retention cap. Agent-triggered checks call this exact same pipeline, so they cannot bypass its hostname, SSRF, timeout, concurrency, or request-replay controls.

Workers cannot expose the peer certificate object. A successful fetch proves HTTPS reachability and a successful handshake, but issuer, SANs, serial, and expiry remain unavailable. The system does not equate this evidence with Cloudflare for SaaS activation or internal certificate provisioning.

## Copilot grounding

The browser and backend name the Agent with the stable workspace ID. `AIChatAgent` owns persistent messages and resumable streams. Every factual tool resolves its workspace server-side and has no workspace selector.

The model is required to use a tool at the start of every turn, including follow-ups. Ambiguous matches return candidates; missing observations return an explicit unknown state; tool failures return structured errors. The `runLiveDiagnostic` tool is narrowly described and prompted for explicit user requests only. A bounded eight-step loop forces tool choice on step zero and disables tools on later finalization steps, guaranteeing room for a natural-language conclusion.

## Production boundaries

Workspace isolation is defense in depth, not authentication. A production deployment must derive workspace membership from identity, add authorization and platform-level rate limits, define retention/privacy policy, and decide on an IDNA conversion policy. Aggregate cross-workspace reporting belongs in D1 or another index rather than scanning Durable Objects.
