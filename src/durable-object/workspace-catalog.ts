import { DurableObject } from "cloudflare:workers";
import { DomainError, toBackendError } from "../domain/errors";
import type { BackendResult, Workspace } from "../domain/types";
import { validateWorkspaceId, validateWorkspaceName } from "../domain/validation";

type WorkspaceRow = { id: string; name: string; created_at: string; updated_at: string };

export class WorkspaceCatalog extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }
  list(): BackendResult<Workspace[]> {
    return this.run(() =>
      [
        ...this.sql.exec<WorkspaceRow>(
          "SELECT * FROM workspaces ORDER BY name COLLATE NOCASE, created_at",
        ),
      ].map(toWorkspace),
    );
  }
  create(nameValue: unknown): BackendResult<Workspace> {
    return this.run(() => {
      const name = validateWorkspaceName(nameValue);
      const now = new Date().toISOString();
      const workspace: Workspace = {
        id: `ws-${crypto.randomUUID()}`,
        name,
        createdAt: now,
        updatedAt: now,
      };
      this.sql.exec(
        "INSERT INTO workspaces(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        workspace.id,
        name,
        now,
        now,
      );
      return workspace;
    });
  }
  ensure(idValue: string, nameValue?: unknown): BackendResult<Workspace> {
    return this.run(() => {
      const id = validateWorkspaceId(idValue);
      const existing = [
        ...this.sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id),
      ][0];
      if (existing) return toWorkspace(existing);
      const name = nameValue === undefined ? readableName(id) : validateWorkspaceName(nameValue);
      const now = new Date().toISOString();
      this.sql.exec("INSERT INTO workspaces VALUES (?, ?, ?, ?)", id, name, now, now);
      return { id, name, createdAt: now, updatedAt: now };
    });
  }
  rename(idValue: string, nameValue: unknown): BackendResult<Workspace> {
    return this.run(() => {
      const id = validateWorkspaceId(idValue);
      const name = validateWorkspaceName(nameValue);
      const now = new Date().toISOString();
      if (
        this.sql.exec("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?", name, now, id)
          .rowsWritten === 0
      )
        throw new DomainError("WORKSPACE_NOT_FOUND", "Workspace not found.", 404);
      return toWorkspace(
        [...this.sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id)][0]!,
      );
    });
  }
  private run<T>(action: () => T): BackendResult<T> {
    try {
      return { ok: true, value: action() };
    } catch (cause) {
      return { ok: false, error: toBackendError(cause) };
    }
  }
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at };
}
function readableName(id: string): string {
  return (
    id
      .replace(/^ws-/, "")
      .replaceAll(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Workspace"
  );
}
