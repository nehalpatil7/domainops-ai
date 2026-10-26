# DomainOps AI architecture

## Scope

DomainOps AI combines a deterministic domain-management control plane with a stateful troubleshooting assistant. Cloudflare for SaaS responses are simulated; storage, orchestration, chat persistence, and model inference use Cloudflare platform primitives.

## Components and request flow

```text
React dashboard
      |                                      |
      | workspace REST API                   | useAgentChat WebSocket
      v                                      v
Worker API handler                    DomainOpsChatAgent
      |                               SQLite chat history
      | idFromName(workspaceId)              |
      |                                      +-- Workers AI / Llama 3.3
      |                                      |
      |<----------- read-only tool RPC ------+
      v
WorkspaceDomainStore (one SQLite Durable Object per workspace)
      |
      +-- DomainService: validation, idempotency, transitions, readiness
      |
      +-- DomainRepository: SQLite schema and workspace-scoped queries
      |
      +-- deterministic simulation adapter
      |
      +-- persisted live public observations
      |          ^
      |          |
      |    Worker live diagnostics
      |    Cloudflare DNS over HTTPS + HTTPS HEAD
      |
      +-- DomainRevalidationWorkflow
             durable evaluate / delay / persist steps
```

HTTP handlers only parse routes and bodies, select the workspace Durable Object, start Workflows, and produce consistent envelopes. Business rules live in `DomainService`; persistence details live in `DomainRepository`; deterministic provider behavior lives in `simulation.ts`.

The chat Durable Object is separate from domain storage. This lets `AIChatAgent` own its SQLite message and resumable-stream tables while every factual tool result still comes from `WorkspaceDomainStore` through RPC.

## AI grounding and conversation memory

The browser names the Agent instance with the current workspace ID. That gives each workspace a persistent transcript and prevents chat history from being shared between workspaces. `AIChatAgent` persists messages automatically, and the complete recent conversation—including the previous domain and follow-up question—is converted to model messages on each turn.

The assistant uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` through the Workers AI binding and Cloudflare's AI SDK provider. The first step has `toolChoice: "required"`; later steps may call additional tools or produce the answer. A bounded six-step loop prevents runaway tool calls.

Grounding is enforced at multiple layers:

1. The system prompt says backend tools are the only source of domain facts.
2. Every turn must begin with a tool call, including multi-turn follow-ups.
3. Tools derive the workspace server-side and expose no cross-workspace selector.
4. Ambiguous, missing, and backend-error results are explicit structured outcomes.
5. Deterministic diagnosis separates confirmed facts, possible causes, and actions.
6. There are no mutating tools.

Simulated tool calls return `providerData: "simulation"` so the assistant cannot present them as live DNS or production Cloudflare for SaaS observations.

Live assistant tools instead return `source: "live_public"`, an observation timestamp, and only persisted public results. They never include expected SaaS DNS targets, validation records, hostname activation, or SSL provisioning state. If no live snapshot exists, the tool instructs the assistant to ask the user to run one from the dashboard rather than substituting simulation data.

## Live diagnostic pipeline

`POST .../live-diagnostics` uses three boundaries:

1. `WorkspaceDomainStore` validates the domain, reserves one active run, enforces idempotency, and returns a result cached within the previous 30 seconds.
2. The Worker queries Cloudflare's DNS-over-HTTPS JSON endpoint for exactly `A`, `AAAA`, `CNAME`, `TXT`, and `CAA` with per-request timeouts.
3. Only when every observed address is public does the Worker send a non-redirecting HTTPS `HEAD` request to port 443. The completed result is written back through Durable Object RPC.

`live_diagnostic_runs` stores the complete immutable JSON snapshot with observation/completion timestamps and retains the newest 50 snapshots per domain. `live_diagnostic_state` prevents concurrent runs for a domain and allows stale reservations to expire. The same workspace and domain predicates used elsewhere protect history reads.

Safety checks reject reserved/internal hostname suffixes and non-public IPv4/IPv6 answers before HTTPS. Redirects are recorded without being followed. Response headers are allowlisted and length-bounded. The result records partial DNS failures and timeouts rather than converting unavailable data into negative findings.

The application cannot pin Workers `fetch()` to the exact IP returned by the DNS-over-HTTPS preflight. The preflight and Cloudflare runtime outbound restrictions therefore work together as defense in depth against rebinding; production should also require authenticated, authorized workspaces and platform-level rate limiting.

Workers `fetch()` exposes no peer certificate object. The TLS model therefore records only `succeeded`, `failed`, or `not_attempted`, and always includes the certificate-metadata limitation.

## Workspace isolation

The Worker derives a Durable Object ID with `idFromName(workspaceId)`. Each instance has a `workspace_metadata` row that permanently binds it to the first workspace ID it sees. Every domain, event, and idempotency query also includes `workspace_id` as defense in depth.

This is isolation, not authentication. A production API must derive the workspace from authenticated identity instead of accepting it directly from the URL.

The same limitation currently applies to Agent instance names. Authentication must bind both REST and chat routes to an authorized workspace before production use.

## SQLite model

`domains` stores:

- domain and workspace IDs;
- hostname and expected DNS target;
- expected and observed DNS record JSON;
- independent DNS, hostname, and SSL statuses;
- required validation record JSON and aggregate validation state;
- simulation profile and source label;
- creation, update, and last-attempt timestamps;
- retry count, last applied attempt, and active validation ID.

`domain_events` is an append-only diagnostic history. Events contain the category, previous and next values, a stable diagnostic code, human-readable message, metadata, workflow/validation ID, attempt, source, and timestamp. A unique `dedupe_key` prevents a retried Workflow step from appending the same event twice.

`idempotency_records` associates a workspace and caller-supplied key with a normalized request and stored result. The same key and request return the prior result. The same key with different input is rejected.

`workspace_metadata` prevents accidental reuse of one Durable Object for another workspace.

## Status model

The status dimensions are intentionally independent:

| Dimension  | Representative values                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| DNS        | `pending`, `valid`, `invalid`                                                                                    |
| Hostname   | `pending`, `active`, `blocked`, `moved`, `deleted`                                                               |
| SSL        | `initializing`, `pending_validation`, `pending_issuance`, `pending_deployment`, `active`, timeout/failure states |
| Validation | `pending`, `checking`, `dns_misconfigured`, `pending_hostname`, `pending_ssl`, `active`, `failed`                |

`ready` is derived and never persisted. It is true only for DNS `valid`, hostname `active`, SSL `active`, and validation `active`. This prevents an active hostname from hiding a pending certificate, or an active certificate from hiding incorrect DNS.

## Deterministic revalidation

`POST .../revalidate` first performs an atomic Durable Object transition:

1. Validate the domain and idempotency key.
2. Reject a different request if a validation is already active.
3. Increment the attempt, set validation to `checking`, and append one start event.
4. Persist the idempotency result.
5. Start a Workflow with the generated validation ID.

The Workflow calculates an outcome from only the profile, hostname, and attempt, waits for a short simulated provider delay, and writes the result back through Durable Object RPC. Persistence accepts the result only when its validation ID matches the active ID and its attempt is newer than the last applied attempt. Workflow retries therefore cannot regress state or duplicate events.

Current profile behavior is fixed:

- `active` remains ready.
- `incorrect_dns` remains blocked on the mismatched observed CNAME.
- `pending_ssl` becomes active on its first explicit retry.
- `validation_failure` remains failed.

## HTTP contracts

Successful requests return:

```json
{
  "data": {},
  "meta": {
    "workspaceId": "demo-acme",
    "simulated": true,
    "requestId": "..."
  }
}
```

Errors return:

```json
{
  "error": {
    "code": "DOMAIN_NOT_FOUND",
    "message": "Domain not found in this workspace."
  },
  "requestId": "..."
}
```

Validation, not-found, conflict, and unexpected failures use consistent `4xx`/`5xx` codes. API metadata and dashboard copy identify results as either `simulation` or `live_public`; those sources are never merged into one status.

## Production extension points

A production Cloudflare for SaaS adapter can replace `simulation.ts` while leaving service and repository boundaries intact. It would create and inspect custom hostnames, compare DNS, map `status` and `ssl.status`, read ownership/DCV records, and request retries.

Before that adapter is enabled, add authentication, authorization, secrets, rate limiting, audit identity, retention controls, IDNA policy, and an integration suite against a dedicated test zone. Cross-workspace reporting belongs in D1 or another aggregate store rather than scanning Durable Objects.
