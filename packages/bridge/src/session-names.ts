import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Names the user gave sessions through the app.
 *
 * The transcript's `custom-title` record is last-wins, and a `claude --bg`
 * session rewrites its own auto-generated title after every turn, which
 * silently undoes a rename made from the app. The bridge therefore keeps
 * the user's choice here and overlays it on the recent-sessions list; the
 * transcript record is still written so the CLI sees the name too.
 *
 * File: ~/.ccpocket/session-names.json. Re-read when its mtime changes.
 */
export class SessionNameStore {
  private names = new Map<string, string>();
  private mtimeMs = -1;

  constructor(readonly filePath: string = join(homedir(), ".ccpocket", "session-names.json")) {}

  /** User-chosen name, or undefined when the user never renamed (or cleared) it. */
  get(sessionId: string): string | undefined {
    this.load();
    return this.names.get(sessionId);
  }

  all(): ReadonlyMap<string, string> {
    this.load();
    return this.names;
  }

  /** Remember a rename; an empty/null name clears the override. */
  set(sessionId: string, name: string | null | undefined): void {
    this.load();
    const trimmed = name?.trim() ?? "";
    if (trimmed) this.names.set(sessionId, trimmed);
    else this.names.delete(sessionId);
    this.save();
  }

  private load(): void {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.filePath).mtimeMs;
    } catch {
      return;
    }
    if (mtimeMs === this.mtimeMs) return;
    this.mtimeMs = mtimeMs;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as { names?: Record<string, unknown> };
      this.names = new Map(
        Object.entries(parsed.names ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
        ),
      );
    } catch {
      // Keep what we have.
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ version: 1, names: Object.fromEntries(this.names) }, null, 2) + "\n",
        { mode: 0o600 },
      );
      renameSync(tmp, this.filePath);
      this.mtimeMs = statSync(this.filePath).mtimeMs;
    } catch (err) {
      console.warn("[session-names] Failed to save:", err);
    }
  }
}

export const sessionNames = new SessionNameStore();
