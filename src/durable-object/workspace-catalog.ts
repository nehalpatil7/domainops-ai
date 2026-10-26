import { DurableObject } from "cloudflare:workers";
import { DomainError, toBackendError } from "../domain/errors";
import type { BackendResult, Workspace } from "../domain/types";
import { validateWorkspaceId, validateWorkspaceName } from "../domain/validation";

type WorkspaceRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  owner_id: string | null;
};

export class WorkspaceCatalog extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, owner_id TEXT)`);
    const columns = [...this.sql.exec<{ name: string }>("PRAGMA table_info(workspaces)")];
    if (!columns.some((column) => column.name === "owner_id"))
      this.sql.exec("ALTER TABLE workspaces ADD COLUMN owner_id TEXT");
    this.sql.exec("CREATE INDEX IF NOT EXISTS workspaces_by_owner ON workspaces(owner_id, name)");
    this.sql.exec(`CREATE TRIGGER IF NOT EXISTS workspaces_require_owner
      BEFORE INSERT ON workspaces WHEN NEW.owner_id IS NULL OR length(NEW.owner_id) < 1
      BEGIN SELECT RAISE(ABORT, 'workspace owner is required'); END`);
  }

  list(ownerId: string): BackendResult<Workspace[]> {
    return this.run(() =>
      [
        ...this.sql.exec<WorkspaceRow>(
          "SELECT * FROM workspaces WHERE owner_id = ? ORDER BY name COLLATE NOCASE, created_at",
          ownerId,
        ),
      ].map(toWorkspace),
    );
  }
  create(ownerId: string, nameValue: unknown): BackendResult<Workspace> {
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
        "INSERT INTO workspaces(id, name, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?)",
        workspace.id,
        name,
        now,
        now,
        ownerId,
      );
      return workspace;
    });
  }
  ensure(ownerId: string, idValue: string, nameValue?: unknown): BackendResult<Workspace> {
    return this.run(() => {
      const id = validateWorkspaceId(idValue);
      const existing = [
        ...this.sql.exec<WorkspaceRow>("SELECT * FROM workspaces WHERE id = ?", id),
      ][0];
      if (existing?.owner_id && existing.owner_id !== ownerId)
        throw new DomainError(
          "WORKSPACE_FORBIDDEN",
          "You do not have access to this workspace.",
          403,
        );
      if (existing) {
        if (!existing.owner_id)
          this.sql.exec(
            "UPDATE workspaces SET owner_id = ? WHERE id = ? AND owner_id IS NULL",
            ownerId,
            id,
          );
        return toWorkspace(existing);
      }
      const name = nameValue === undefined ? readableName(id) : validateWorkspaceName(nameValue);
      const now = new Date().toISOString();
      this.sql.exec(
        "INSERT INTO workspaces(id, name, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?)",
        id,
        name,
        now,
        now,
        ownerId,
      );
      return { id, name, createdAt: now, updatedAt: now };
    });
  }
  authorize(ownerId: string, idValue: string): BackendResult<Workspace> {
    return this.run(() => {
      const id = validateWorkspaceId(idValue);
      const existing = [
        ...this.sql.exec<WorkspaceRow>(
          "SELECT * FROM workspaces WHERE id = ? AND owner_id = ?",
          id,
          ownerId,
        ),
      ][0];
      if (!existing)
        throw new DomainError(
          "WORKSPACE_FORBIDDEN",
          "You do not have access to this workspace.",
          403,
        );
      return toWorkspace(existing);
    });
  }
  rename(ownerId: string, idValue: string, nameValue: unknown): BackendResult<Workspace> {
    return this.run(() => {
      const id = validateWorkspaceId(idValue);
      const name = validateWorkspaceName(nameValue);
      const now = new Date().toISOString();
      if (
        this.sql.exec(
          "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
          name,
          now,
          id,
          ownerId,
        ).rowsWritten === 0
      )
        throw new DomainError("WORKSPACE_NOT_FOUND", "Workspace not found.", 404);
      return toWorkspace(
        [
          ...this.sql.exec<WorkspaceRow>(
            "SELECT * FROM workspaces WHERE id = ? AND owner_id = ?",
            id,
            ownerId,
          ),
        ][0]!,
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
