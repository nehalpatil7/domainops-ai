import { DomainError } from "./errors";
import type { Domain, LiveDiagnosticRun } from "./types";

type DomainRow = {
  id: string;
  workspace_id: string;
  hostname: string;
  created_at: string;
  updated_at: string;
};
type JsonRow = { result_json: string };
type StateRow = { active_request_id: string | null; active_since: string | null };
type IdempotencyRow = { operation: string; request_json: string; response_json: string };

export type NewDomain = Pick<Domain, "id" | "workspaceId" | "hostname" | "createdAt" | "updatedAt">;

export class DomainRepository {
  constructor(private readonly sql: SqlStorage) {}

  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspace_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), workspace_id TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS registered_domains (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, hostname TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id, hostname))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS diagnostic_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, domain_id TEXT NOT NULL,
      hostname TEXT NOT NULL, status TEXT NOT NULL, observed_at TEXT NOT NULL,
      completed_at TEXT NOT NULL, result_json TEXT NOT NULL,
      FOREIGN KEY (domain_id) REFERENCES registered_domains(id))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS diagnostic_runs_by_domain
      ON diagnostic_runs(workspace_id, domain_id, observed_at DESC, id DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS diagnostic_state (
      workspace_id TEXT NOT NULL, domain_id TEXT NOT NULL, active_request_id TEXT,
      active_since TEXT, PRIMARY KEY(workspace_id, domain_id),
      FOREIGN KEY (domain_id) REFERENCES registered_domains(id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS idempotency_records_v2 (
      workspace_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
      request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, idempotency_key))`);
    this.migrateLegacyData();
  }

  private migrateLegacyData(): void {
    const legacyDomains = this.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'domains'",
    );
    if (legacyDomains) {
      this.sql
        .exec(`INSERT OR IGNORE INTO registered_domains(id, workspace_id, hostname, created_at, updated_at)
        SELECT id, workspace_id, hostname, created_at, updated_at FROM domains
        WHERE hostname NOT IN ('active.demo.example', 'incorrect-dns.demo.example',
          'pending-ssl.demo.example', 'validation-failure.demo.example')`);
    }
    const legacyRuns = this.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_diagnostic_runs'",
    );
    if (legacyRuns) {
      this.sql.exec(`INSERT OR IGNORE INTO diagnostic_runs
        SELECT r.id, r.workspace_id, r.domain_id, r.hostname, r.status, r.observed_at,
          r.completed_at, r.result_json FROM live_diagnostic_runs r
        INNER JOIN registered_domains d ON d.id = r.domain_id`);
    }
  }

  bindWorkspace(workspaceId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO workspace_metadata(singleton, workspace_id) VALUES (1, ?)",
      workspaceId,
    );
    const row = this.first<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspace_metadata WHERE singleton = 1",
    );
    if (row?.workspace_id !== workspaceId)
      throw DomainError.conflict(
        "WORKSPACE_SCOPE_MISMATCH",
        "The durable object is already assigned to another workspace.",
      );
  }

  listDomains(workspaceId: string): Domain[] {
    return this.all<DomainRow>(
      "SELECT * FROM registered_domains WHERE workspace_id = ? ORDER BY hostname",
      workspaceId,
    ).map((row) => this.toDomain(row));
  }
  getDomain(workspaceId: string, domainId: string): Domain | null {
    const row = this.first<DomainRow>(
      "SELECT * FROM registered_domains WHERE workspace_id = ? AND id = ?",
      workspaceId,
      domainId,
    );
    return row ? this.toDomain(row) : null;
  }
  getDomainByHostname(workspaceId: string, hostname: string): Domain | null {
    const row = this.first<DomainRow>(
      "SELECT * FROM registered_domains WHERE workspace_id = ? AND hostname = ?",
      workspaceId,
      hostname,
    );
    return row ? this.toDomain(row) : null;
  }
  insertDomain(domain: NewDomain): void {
    this.sql.exec(
      "INSERT INTO registered_domains(id, workspace_id, hostname, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      domain.id,
      domain.workspaceId,
      domain.hostname,
      domain.createdAt,
      domain.updatedAt,
    );
  }

  listDiagnosticRuns(workspaceId: string, domainId: string, limit = 20): LiveDiagnosticRun[] {
    return this.all<JsonRow>(
      `SELECT result_json FROM diagnostic_runs WHERE workspace_id = ? AND domain_id = ?
      ORDER BY observed_at DESC, id DESC LIMIT ?`,
      workspaceId,
      domainId,
      limit,
    ).map((row) => JSON.parse(row.result_json) as LiveDiagnosticRun);
  }
  getDiagnosticRun(workspaceId: string, domainId: string, runId: string): LiveDiagnosticRun | null {
    const row = this.first<JsonRow>(
      "SELECT result_json FROM diagnostic_runs WHERE workspace_id = ? AND domain_id = ? AND id = ?",
      workspaceId,
      domainId,
      runId,
    );
    return row ? (JSON.parse(row.result_json) as LiveDiagnosticRun) : null;
  }
  insertDiagnosticRun(run: LiveDiagnosticRun): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO diagnostic_runs(id, workspace_id, domain_id, hostname, status, observed_at, completed_at, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.workspaceId,
      run.domainId,
      run.hostname,
      run.status,
      run.observedAt,
      run.completedAt,
      JSON.stringify(run),
    );
    this.sql.exec(
      `DELETE FROM diagnostic_runs WHERE workspace_id = ? AND domain_id = ? AND id NOT IN (
      SELECT id FROM diagnostic_runs WHERE workspace_id = ? AND domain_id = ? ORDER BY observed_at DESC, id DESC LIMIT 50)`,
      run.workspaceId,
      run.domainId,
      run.workspaceId,
      run.domainId,
    );
    this.sql.exec(
      "UPDATE registered_domains SET updated_at = ? WHERE workspace_id = ? AND id = ?",
      run.completedAt,
      run.workspaceId,
      run.domainId,
    );
  }

  acquireDiagnostic(
    workspaceId: string,
    domainId: string,
    requestId: string,
    timestamp: string,
    staleBefore: string,
  ): boolean {
    const current = this.first<StateRow>(
      "SELECT active_request_id, active_since FROM diagnostic_state WHERE workspace_id = ? AND domain_id = ?",
      workspaceId,
      domainId,
    );
    if (current?.active_request_id && current.active_since && current.active_since >= staleBefore)
      return false;
    this.sql.exec(
      `INSERT INTO diagnostic_state(workspace_id, domain_id, active_request_id, active_since) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, domain_id) DO UPDATE SET active_request_id = excluded.active_request_id, active_since = excluded.active_since`,
      workspaceId,
      domainId,
      requestId,
      timestamp,
    );
    return true;
  }
  releaseDiagnostic(workspaceId: string, domainId: string, requestId: string): boolean {
    return (
      this.sql.exec(
        "UPDATE diagnostic_state SET active_request_id = NULL, active_since = NULL WHERE workspace_id = ? AND domain_id = ? AND active_request_id = ?",
        workspaceId,
        domainId,
        requestId,
      ).rowsWritten > 0
    );
  }

  getIdempotency<T>(
    workspaceId: string,
    key: string,
    operation: string,
    requestJson: string,
  ): T | null {
    const row = this.first<IdempotencyRow>(
      "SELECT operation, request_json, response_json FROM idempotency_records_v2 WHERE workspace_id = ? AND idempotency_key = ?",
      workspaceId,
      key,
    );
    if (!row) return null;
    if (row.operation !== operation || row.request_json !== requestJson)
      throw DomainError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "The Idempotency-Key was already used for a different request.",
      );
    return JSON.parse(row.response_json) as T;
  }
  putIdempotency(
    workspaceId: string,
    key: string,
    operation: string,
    requestJson: string,
    response: unknown,
    timestamp: string,
  ): void {
    this.sql.exec(
      "INSERT INTO idempotency_records_v2 VALUES (?, ?, ?, ?, ?, ?)",
      workspaceId,
      key,
      operation,
      requestJson,
      JSON.stringify(response),
      timestamp,
    );
  }
  updateIdempotencyResponse(
    workspaceId: string,
    key: string,
    operation: string,
    response: unknown,
  ): void {
    this.sql.exec(
      "UPDATE idempotency_records_v2 SET response_json = ? WHERE workspace_id = ? AND idempotency_key = ? AND operation = ?",
      JSON.stringify(response),
      workspaceId,
      key,
      operation,
    );
  }

  private toDomain(row: DomainRow): Domain {
    const latest = this.listDiagnosticRuns(row.workspace_id, row.id, 1)[0] ?? null;
    const state = this.first<StateRow>(
      "SELECT active_request_id, active_since FROM diagnostic_state WHERE workspace_id = ? AND domain_id = ?",
      row.workspace_id,
      row.id,
    );
    const checking = Boolean(
      state?.active_request_id &&
      state.active_since &&
      Date.now() - new Date(state.active_since).getTime() < 60_000,
    );
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      hostname: row.hostname,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      healthStatus: checking
        ? "checking"
        : latest
          ? latest.status === "healthy"
            ? "healthy"
            : "needs_attention"
          : "unknown",
      lastCheckedAt: latest?.observedAt ?? null,
      checkDurationMs: latest?.durationMs ?? null,
      latestDiagnostic: latest,
    };
  }
  private all<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return [...this.sql.exec<T>(query, ...bindings)];
  }
  private first<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T | null {
    return this.all<T>(query, ...bindings)[0] ?? null;
  }
}
