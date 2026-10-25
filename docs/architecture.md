# Domain management architecture

## Scope

This increment is the deterministic domain-management foundation for DomainOps AI. It deliberately excludes AI so domain state and retry behavior can be tested independently. Cloudflare for SaaS responses are simulated; storage and orchestration use the real Cloudflare development primitives.

## Components and request flow

```text
React dashboard
      |
      | workspace-scoped REST API
      v
Worker API handler
      |
      | idFromName(workspaceId) + RPC
      v
WorkspaceDomainStore (one SQLite Durable Object per workspace)
      |
      +-- DomainService: validation, idempotency, transitions, readiness
      |
      +-- DomainRepository: SQLite schema and workspace-scoped queries
      |
      +-- deterministic simulation adapter
      |
      +-- DomainRevalidationWorkflow
             durable evaluate / delay / persist steps
```

HTTP handlers only parse routes and bodies, select the workspace Durable Object, start Workflows, and produce consistent envelopes. Business rules live in `DomainService`; persistence details live in `DomainRepository`; deterministic provider behavior lives in `simulation.ts`.

## Workspace isolation

The Worker derives a Durable Object ID with `idFromName(workspaceId)`. Each instance has a `workspace_metadata` row that permanently binds it to the first workspace ID it sees. Every domain, event, and idempotency query also includes `workspace_id` as defense in depth.

This is isolation, not authentication. A production API must derive the workspace from authenticated identity instead of accepting it directly from the URL.

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

Validation, not-found, conflict, and unexpected failures use consistent `4xx`/`5xx` codes. Provider-facing values and dashboard copy always identify the data source as simulated.

## Production extension points

A production Cloudflare for SaaS adapter can replace `simulation.ts` while leaving service and repository boundaries intact. It would create and inspect custom hostnames, compare DNS, map `status` and `ssl.status`, read ownership/DCV records, and request retries.

Before that adapter is enabled, add authentication, authorization, secrets, rate limiting, audit identity, retention controls, IDNA policy, and an integration suite against a dedicated test zone. Cross-workspace reporting belongs in D1 or another aggregate store rather than scanning Durable Objects.
