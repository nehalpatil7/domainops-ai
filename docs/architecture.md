# DomainOps AI architecture

## Request flow

```text
React dashboard ── Access JWT ──> Worker auth/authorization ──> REST API
       │                         │
       │                         ├── WorkspaceCatalog (global SQLite Durable Object)
       │                         │       workspace IDs + display names
       │                         │
       │                         └── WorkspaceDomainStore (one SQLite DO per workspace)
       │                                 domain registry + immutable diagnostic runs
       │                                           │
       │                                           └── bounded DNS snapshots + HTTPS HEAD/GET
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

`WorkspaceCatalog` stores stable workspace IDs, mutable display names, and the owning Cloudflare Access subject. Renaming never changes the Durable Object or Agent instance key. Every REST and Agent request verifies an Access JWT and checks catalog ownership before reaching workspace data. Direct Agent routes cannot create or claim a workspace.

Each `WorkspaceDomainStore` contains:

- `registered_domains`: hostname identity and lifecycle timestamps;
- `diagnostic_runs`: immutable complete JSON snapshots, indexed newest-first;
- `diagnostic_state`: one short-lived active-run reservation per domain;
- `idempotency_records_v2`: normalized mutation request/result pairs;
- `workspace_metadata`: a permanent binding between the object and workspace ID.

Schema initialization is additive and migration markers prevent repeated data copies. If legacy tables exist, non-demo domain identities and public live runs are copied with the same IDs into the live-only tables. Exact former seed hostnames are excluded. Existing workspace catalog rows receive a nullable owner column and are claimed only through an authenticated REST request. Application code never reads legacy provider statuses, validation records, or events.

All runtime SQL values use positional bindings. Only fixed schema/migration DDL is interpolated. Registration, diagnostic reservation, completion/failure, lock release, result persistence, and idempotency updates use synchronous Durable Object transactions. A failed insert therefore cannot release the diagnostic lock. Idempotency rows expire after 24 hours during subsequent mutations and are capped at the newest 1,000 rows per workspace. Triggers constrain hostname length, diagnostic status, and JSON validity.

The global catalog cannot discover previously named Durable Objects. The UI registers the historical default object on an empty catalog, and any legacy workspace requested through the API is also added automatically.

## Health and history

Domain health is computed, not independently persisted:

| UI state        | Source                                       |
| --------------- | -------------------------------------------- |
| Healthy         | Latest diagnostic `status` is `healthy`      |
| Needs attention | Latest diagnostic is `degraded` or `failed`  |
| Checking        | A non-stale diagnostic reservation is active |
| Unknown         | No persisted result exists                   |

History compares each result with its immediate predecessor. Changes cover overall health, actual DNS owner/value/TTL sets, DNS query status, HTTPS reachability, and TLS-handshake status. Partial DNS timeouts/errors remain explicit; they are not converted into fabricated negative records.

## Diagnostic safety and reliability

A check accepts either a normalized ASCII FQDN or an HTTP(S) URL reduced to its hostname. It queries only five displayed record types and resolves at most four CNAME hops. Two independently fetched, bounded resolution snapshots must have identical chains and address sets, and every address/target must be public. This reduces DNS-rebinding exposure before the Workers runtime performs its own resolution.

The HTTPS probe is fixed to port 443, stores only selected headers, and has a bounded timeout. It uses `HEAD`, with one range-limited `GET` fallback only for `405`/`501`. It manually follows up to three `301`/`302`/`307`/`308` hops, requiring HTTPS plus two stable public address snapshots at every destination and rejecting loops. Verified healthy destinations are healthy redirects; destinations that cannot be verified are neutral/unverified rather than confirmed failures. Original URL, final URL, and hop evidence are persisted. `NXDOMAIN`, no records, resolver failures, timeouts, HTTP response classes, and network/TLS failures stay distinct.

The Durable Object supplies idempotency, a 60-second stale-lock boundary, 30-second completed-result reuse, and a 50-result retention cap. Agent-triggered checks call this exact same pipeline, so they cannot bypass its hostname, SSRF, timeout, concurrency, or request-replay controls.

Workers cannot expose the peer certificate object. A successful fetch proves HTTPS reachability and a successful handshake, but issuer, SANs, serial, and expiry remain unavailable. The system does not equate this evidence with Cloudflare for SaaS activation or internal certificate provisioning.

## Copilot grounding

The browser and backend name the Agent with the stable workspace ID. `AIChatAgent` owns persistent messages and resumable streams. Every factual tool resolves its workspace server-side and has no workspace selector.

The model uses the minimum necessary tools: factual domain claims require backend evidence, while greetings and general explanations do not trigger calls. Ambiguous matches return candidates; missing observations return an explicit unknown state; tool failures return structured errors. `registerDomain` and `runLiveDiagnostic` require explicit user intent. Recent messages retain domain context for follow-ups. A bounded eight-step loop disables tools on later finalization steps, guaranteeing room for a natural-language conclusion.

The system prompt is divided into role, tool usage, grounding, untrusted external data, diagnostic reasoning, response format, limitations, and errors. DNS/TXT/CAA data, redirects, headers, and error strings are evidence only and cannot change instructions or authorize actions. The client renders structured summaries and safe follow-up actions without exposing raw tool JSON by default.

## Production boundaries

Production is fail-closed unless `AUTH_MODE=cloudflare_access`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` are configured. The Worker verifies JWT signatures with the team JWKS rather than trusting identity headers. Cloudflare Access should protect the entire application hostname. Current authorization is single-owner; team membership, invitations, transfers, service tokens, and administrative recovery need an explicit product model before multi-user production use.

Platform-level rate limiting, retention/privacy policy, audit export, and a final IDNA policy remain deployment decisions. Aggregate cross-workspace reporting belongs in D1 or another index rather than scanning Durable Objects.
