import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface ArchivedSession {
  sessionId: string;
  provider: "claude" | "codex";
  projectPath: string;
  archivedAt: string;
}

interface ArchiveStoreData {
  version: 1;
  archivedSessions: ArchivedSession[];
}

/**
 * Manages a persistent set of archived session IDs.
 * Data is stored in `~/.ccpocket/archived-sessions.json`.
 */
export class ArchiveStore {
  private readonly dirPath: string;
  private readonly filePath: string;
  /** In-memory cache of archived session IDs for O(1) lookup. */
  private cache = new Set<string>();
  private data: ArchiveStoreData = { version: 1, archivedSessions: [] };

  constructor() {
    this.dirPath = join(homedir(), ".ccpocket");
    this.filePath = join(this.dirPath, "archived-sessions.json");
  }

  /** Initialise the store: create directory if needed and load existing data. */
  async init(): Promise<void> {
    await mkdir(this.dirPath, { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as ArchiveStoreData;
      if (parsed.version === 1 && Array.isArray(parsed.archivedSessions)) {
        this.data = parsed;
        this.cache = new Set(parsed.archivedSessions.map((s) => s.sessionId));
      }
    } catch {
      // File doesn't exist or is corrupted – start fresh.
      this.data = { version: 1, archivedSessions: [] };
      this.cache = new Set();
    }
    console.log(
      `[archive-store] Loaded ${this.cache.size} archived session(s)`,
    );
  }

  /** Archive a session. Idempotent – archiving an already-archived session is a no-op. */
  async archive(
    sessionId: string,
    provider: "claude" | "codex",
    projectPath: string,
  ): Promise<void> {
    if (this.cache.has(sessionId)) return;
    const entry: ArchivedSession = {
      sessionId,
      provider,
      projectPath,
      archivedAt: new Date().toISOString(),
    };
    this.data.archivedSessions.push(entry);
    this.cache.add(sessionId);
    await this.save();
    console.log(`[archive-store] Archived session ${sessionId}`);
  }

  /**
   * Remove a session from the archive so it shows up in the recent list
   * again. Returns false when it was not archived.
   */
  async unarchive(sessionId: string): Promise<boolean> {
    if (!this.cache.has(sessionId)) return false;
    this.data.archivedSessions = this.data.archivedSessions.filter(
      (s) => s.sessionId !== sessionId,
    );
    this.cache.delete(sessionId);
    await this.save();
    console.log(`[archive-store] Unarchived session ${sessionId}`);
    return true;
  }

  /** Archived entries, oldest first. */
  list(): ArchivedSession[] {
    return this.data.archivedSessions.map((s) => ({ ...s }));
  }

  /** Check whether a session is archived. */
  isArchived(sessionId: string): boolean {
    this.reloadIfChanged();
    return this.cache.has(sessionId);
  }

  /** Return the full set of archived session IDs (for bulk filtering). */
  archivedIds(): ReadonlySet<string> {
    this.reloadIfChanged();
    return this.cache;
  }

  private lastSeenMtimeMs = -1;

  /**
   * Pick up edits made by another process (`ccpocket-bridge archive restore`)
   * without restarting the bridge: re-read when the file's mtime changed.
   */
  private reloadIfChanged(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.filePath).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs === this.lastSeenMtimeMs) return;
    this.lastSeenMtimeMs = mtimeMs;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as ArchiveStoreData;
      if (parsed.version === 1 && Array.isArray(parsed.archivedSessions)) {
        this.data = parsed;
        this.cache = new Set(parsed.archivedSessions.map((s) => s.sessionId));
      }
    } catch {
      // Keep the in-memory state when the file is mid-write or unreadable.
    }
  }

  // ---- internal ----

  /** Atomic write: write to temp file, then rename. */
  private async save(): Promise<void> {
    const tmp = join(this.dirPath, `archived-sessions.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    await rename(tmp, this.filePath);
    try {
      this.lastSeenMtimeMs = statSync(this.filePath).mtimeMs;
    } catch {
      // ignore
    }
  }
}
