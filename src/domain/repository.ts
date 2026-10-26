import { DomainError } from "./errors";
import { isDomainReady } from "./simulation";
import type {
  DiagnosticEvent,
  DnsRecord,
  Domain,
  LiveDiagnosticRun,
  RevalidationOutcome,
  SimulationProfile,
  ValidationRecord,
} from "./types";

type DomainRow = {
  id: string;
  workspace_id: string;
  hostname: string;
  expected_dns_target: string;
  expected_dns_records: string;
  observed_dns_records: string;
  dns_status: Domain["dnsStatus"];
  hostname_status: Domain["hostnameStatus"];
  ssl_status: Domain["sslStatus"];
  required_validation_records: string;
  validation_state: Domain["validationState"];
  source: "simulation";
  simulation_profile: SimulationProfile;
  created_at: string;
  updated_at: string;
  last_validation_attempt_at: string | null;
  retry_count: number;
  last_applied_attempt: number;
  active_validation_id: string | null;
};

type EventRow = {
  id: string;
  workspace_id: string;
  domain_id: string;
  event_type: DiagnosticEvent["eventType"];
  category: DiagnosticEvent["category"];
  previous_value: string | null;
  next_value: string | null;
  diagnostic_code: string;
  message: string;
  metadata_json: string;
  validation_id: string | null;
  attempt: number | null;
  source: DiagnosticEvent["source"];
  created_at: string;
};

type IdempotencyRow = {
  operation: string;
  request_json: string;
  response_json: string;
};

type LiveDiagnosticRow = {
  result_json: string;
};

type LiveDiagnosticStateRow = {
  active_request_id: string | null;
  active_since: string | null;
};

export type NewDomain = Omit<Domain, "ready">;
export type NewEvent = Omit<DiagnosticEvent, "id"> & { dedupeKey: string };

export class DomainRepository {
  constructor(private readonly sql: SqlStorage) {}

  ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        workspace_id TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS domains (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        hostname TEXT NOT NULL,
        expected_dns_target TEXT NOT NULL,
        expected_dns_records TEXT NOT NULL,
        observed_dns_records TEXT NOT NULL,
        dns_status TEXT NOT NULL,
        hostname_status TEXT NOT NULL,
        ssl_status TEXT NOT NULL,
        required_validation_records TEXT NOT NULL,
        validation_state TEXT NOT NULL,
        source TEXT NOT NULL,
        simulation_profile TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_validation_attempt_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_applied_attempt INTEGER NOT NULL DEFAULT 0,
        active_validation_id TEXT,
        UNIQUE(workspace_id, hostname)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        category TEXT NOT NULL,
        previous_value TEXT,
        next_value TEXT,
        diagnostic_code TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        validation_id TEXT,
        attempt INTEGER,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        FOREIGN KEY (domain_id) REFERENCES domains(id)
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS domain_events_by_workspace_domain
      ON domain_events(workspace_id, domain_id, created_at DESC, id DESC)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        workspace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id, idempotency_key)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_diagnostic_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        hostname TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        result_json TEXT NOT NULL,
        FOREIGN KEY (domain_id) REFERENCES domains(id)
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS live_runs_by_workspace_domain
      ON live_diagnostic_runs(workspace_id, domain_id, observed_at DESC, id DESC)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_diagnostic_state (
        workspace_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        active_request_id TEXT,
        active_since TEXT,
        PRIMARY KEY(workspace_id, domain_id),
        FOREIGN KEY (domain_id) REFERENCES domains(id)
      )
    `);
  }

  bindWorkspace(workspaceId: string): void {
    this.sql.exec(
      "INSERT OR IGNORE INTO workspace_metadata(singleton, workspace_id) VALUES (1, ?)",
      workspaceId,
    );
    const row = this.first<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspace_metadata WHERE singleton = 1",
    );
    if (row?.workspace_id !== workspaceId) {
      throw DomainError.conflict(
        "WORKSPACE_SCOPE_MISMATCH",
        "The durable object is already assigned to another workspace.",
      );
    }
  }

  listDomains(workspaceId: string): Domain[] {
    return this.all<DomainRow>(
      "SELECT * FROM domains WHERE workspace_id = ? ORDER BY created_at ASC, hostname ASC",
      workspaceId,
    ).map(toDomain);
  }

  getDomain(workspaceId: string, domainId: string): Domain | null {
    const row = this.first<DomainRow>(
      "SELECT * FROM domains WHERE workspace_id = ? AND id = ?",
      workspaceId,
      domainId,
    );
    return row ? toDomain(row) : null;
  }

  getDomainByHostname(workspaceId: string, hostname: string): Domain | null {
    const row = this.first<DomainRow>(
      "SELECT * FROM domains WHERE workspace_id = ? AND hostname = ?",
      workspaceId,
      hostname,
    );
    return row ? toDomain(row) : null;
  }

  insertDomain(domain: NewDomain): void {
    this.sql.exec(
      `INSERT INTO domains (
        id, workspace_id, hostname, expected_dns_target, expected_dns_records,
        observed_dns_records, dns_status, hostname_status, ssl_status,
        required_validation_records, validation_state, source, simulation_profile,
        created_at, updated_at, last_validation_attempt_at, retry_count,
        last_applied_attempt, active_validation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      domain.id,
      domain.workspaceId,
      domain.hostname,
      domain.expectedDnsTarget,
      JSON.stringify(domain.expectedDnsRecords),
      JSON.stringify(domain.observedDnsRecords),
      domain.dnsStatus,
      domain.hostnameStatus,
      domain.sslStatus,
      JSON.stringify(domain.requiredValidationRecords),
      domain.validationState,
      domain.source,
      domain.simulationProfile,
      domain.createdAt,
      domain.updatedAt,
      domain.lastValidationAttemptAt,
      domain.retryCount,
      domain.lastAppliedAttempt,
      domain.activeValidationId,
    );
  }

  startValidation(
    workspaceId: string,
    domainId: string,
    validationId: string,
    attempt: number,
    timestamp: string,
  ): void {
    this.sql.exec(
      `UPDATE domains SET validation_state = 'checking', active_validation_id = ?,
       retry_count = ?, last_validation_attempt_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND active_validation_id IS NULL`,
      validationId,
      attempt,
      timestamp,
      timestamp,
      workspaceId,
      domainId,
    );
  }

  applyOutcome(
    workspaceId: string,
    domainId: string,
    validationId: string,
    attempt: number,
    outcome: RevalidationOutcome,
    timestamp: string,
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE domains SET dns_status = ?, hostname_status = ?, ssl_status = ?,
       validation_state = ?, required_validation_records = ?, updated_at = ?,
       last_applied_attempt = ?, active_validation_id = NULL
       WHERE workspace_id = ? AND id = ? AND active_validation_id = ?
       AND last_applied_attempt < ?`,
      outcome.dnsStatus,
      outcome.hostnameStatus,
      outcome.sslStatus,
      outcome.validationState,
      JSON.stringify(outcome.requiredValidationRecords),
      timestamp,
      attempt,
      workspaceId,
      domainId,
      validationId,
      attempt,
    );
    return cursor.rowsWritten > 0;
  }

  failValidationStart(
    workspaceId: string,
    domainId: string,
    validationId: string,
    timestamp: string,
  ): boolean {
    const cursor = this.sql.exec(
      `UPDATE domains SET active_validation_id = NULL, validation_state = 'failed', updated_at = ?
       WHERE workspace_id = ? AND id = ? AND active_validation_id = ?`,
      timestamp,
      workspaceId,
      domainId,
      validationId,
    );
    return cursor.rowsWritten > 0;
  }

  listEvents(workspaceId: string, domainId: string): DiagnosticEvent[] {
    return this.all<EventRow>(
      `SELECT * FROM domain_events WHERE workspace_id = ? AND domain_id = ?
       ORDER BY created_at DESC, id DESC`,
      workspaceId,
      domainId,
    ).map(toEvent);
  }

  insertEvent(event: NewEvent): boolean {
    const cursor = this.sql.exec(
      `INSERT OR IGNORE INTO domain_events (
        id, workspace_id, domain_id, event_type, category, previous_value,
        next_value, diagnostic_code, message, metadata_json, validation_id,
        attempt, source, created_at, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      event.workspaceId,
      event.domainId,
      event.eventType,
      event.category,
      event.previousValue,
      event.nextValue,
      event.diagnosticCode,
      event.message,
      JSON.stringify(event.metadata),
      event.validationId,
      event.attempt,
      event.source,
      event.createdAt,
      event.dedupeKey,
    );
    return cursor.rowsWritten > 0;
  }

  getIdempotency<T>(
    workspaceId: string,
    key: string,
    operation: string,
    requestJson: string,
  ): T | null {
    const row = this.first<IdempotencyRow>(
      "SELECT operation, request_json, response_json FROM idempotency_records WHERE workspace_id = ? AND idempotency_key = ?",
      workspaceId,
      key,
    );
    if (!row) return null;
    if (row.operation !== operation || row.request_json !== requestJson) {
      throw DomainError.conflict(
        "IDEMPOTENCY_KEY_REUSED",
        "The Idempotency-Key was already used for a different request.",
      );
    }
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
      `INSERT INTO idempotency_records (
        workspace_id, idempotency_key, operation, request_json, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
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
      `UPDATE idempotency_records SET response_json = ?
       WHERE workspace_id = ? AND idempotency_key = ? AND operation = ?`,
      JSON.stringify(response),
      workspaceId,
      key,
      operation,
    );
  }

  listLiveDiagnosticRuns(workspaceId: string, domainId: string, limit = 20): LiveDiagnosticRun[] {
    return this.all<LiveDiagnosticRow>(
      `SELECT result_json FROM live_diagnostic_runs
       WHERE workspace_id = ? AND domain_id = ?
       ORDER BY observed_at DESC, id DESC LIMIT ?`,
      workspaceId,
      domainId,
      limit,
    ).map((row) => JSON.parse(row.result_json) as LiveDiagnosticRun);
  }

  getLiveDiagnosticRun(
    workspaceId: string,
    domainId: string,
    runId: string,
  ): LiveDiagnosticRun | null {
    const row = this.first<LiveDiagnosticRow>(
      `SELECT result_json FROM live_diagnostic_runs
       WHERE workspace_id = ? AND domain_id = ? AND id = ?`,
      workspaceId,
      domainId,
      runId,
    );
    return row ? (JSON.parse(row.result_json) as LiveDiagnosticRun) : null;
  }

  insertLiveDiagnosticRun(run: LiveDiagnosticRun): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO live_diagnostic_runs (
        id, workspace_id, domain_id, hostname, status, observed_at, completed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      `DELETE FROM live_diagnostic_runs
       WHERE workspace_id = ? AND domain_id = ? AND id NOT IN (
         SELECT id FROM live_diagnostic_runs
         WHERE workspace_id = ? AND domain_id = ?
         ORDER BY observed_at DESC, id DESC LIMIT 50
       )`,
      run.workspaceId,
      run.domainId,
      run.workspaceId,
      run.domainId,
    );
  }

  acquireLiveDiagnostic(
    workspaceId: string,
    domainId: string,
    requestId: string,
    timestamp: string,
    staleBefore: string,
  ): boolean {
    const current = this.first<LiveDiagnosticStateRow>(
      `SELECT active_request_id, active_since FROM live_diagnostic_state
       WHERE workspace_id = ? AND domain_id = ?`,
      workspaceId,
      domainId,
    );
    if (current?.active_request_id && current.active_since && current.active_since >= staleBefore) {
      return false;
    }
    this.sql.exec(
      `INSERT INTO live_diagnostic_state (
        workspace_id, domain_id, active_request_id, active_since
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, domain_id) DO UPDATE SET
       active_request_id = excluded.active_request_id,
       active_since = excluded.active_since`,
      workspaceId,
      domainId,
      requestId,
      timestamp,
    );
    return true;
  }

  releaseLiveDiagnostic(workspaceId: string, domainId: string, requestId: string): boolean {
    const cursor = this.sql.exec(
      `UPDATE live_diagnostic_state SET active_request_id = NULL, active_since = NULL
       WHERE workspace_id = ? AND domain_id = ? AND active_request_id = ?`,
      workspaceId,
      domainId,
      requestId,
    );
    return cursor.rowsWritten > 0;
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

function toDomain(row: DomainRow): Domain {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    hostname: row.hostname,
    expectedDnsTarget: row.expected_dns_target,
    expectedDnsRecords: JSON.parse(row.expected_dns_records) as DnsRecord[],
    observedDnsRecords: JSON.parse(row.observed_dns_records) as DnsRecord[],
    dnsStatus: row.dns_status,
    hostnameStatus: row.hostname_status,
    sslStatus: row.ssl_status,
    requiredValidationRecords: JSON.parse(row.required_validation_records) as ValidationRecord[],
    validationState: row.validation_state,
    source: row.source,
    simulationProfile: row.simulation_profile,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastValidationAttemptAt: row.last_validation_attempt_at,
    retryCount: row.retry_count,
    lastAppliedAttempt: row.last_applied_attempt,
    activeValidationId: row.active_validation_id,
    ready: isDomainReady(row.dns_status, row.hostname_status, row.ssl_status, row.validation_state),
  };
}

function toEvent(row: EventRow): DiagnosticEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    domainId: row.domain_id,
    eventType: row.event_type,
    category: row.category,
    previousValue: row.previous_value,
    nextValue: row.next_value,
    diagnosticCode: row.diagnostic_code,
    message: row.message,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    validationId: row.validation_id,
    attempt: row.attempt,
    source: row.source,
    createdAt: row.created_at,
  };
}
