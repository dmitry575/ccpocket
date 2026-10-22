import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Claude session ids this bridge has created or resumed.
 *
 * Headless sessions (`claude -p`, cron writers, other SDK users) are written
 * to the same ~/.claude/projects transcripts with `"entrypoint":"sdk-cli"`,
 * and so are the sessions the bridge itself drives through the Agent SDK.
 * The entrypoint alone cannot tell them apart, so the bridge remembers its
 * own ids here and the recent-sessions list hides headless sessions that are
 * not in this set (see BRIDGE_SHOW_HEADLESS_SESSIONS).
 */
export class KnownSessionStore {
  private ids = new Set<string>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly filePath: string = join(homedir(), ".ccpocket", "known-sessions.json")) {}

  has(id: string): boolean {
    this.load();
    return this.ids.has(id);
  }

  all(): ReadonlySet<string> {
    this.load();
    return this.ids;
  }

  markKnown(id: string | undefined | null): void {
    if (!id) return;
    this.load();
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.scheduleSave();
  }

  /** Test helper: drop everything in memory (the file is left alone). */
  reset(): void {
    this.ids.clear();
    this.loaded = false;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as { sessionIds?: unknown };
      if (Array.isArray(parsed.sessionIds)) {
        for (const id of parsed.sessionIds) if (typeof id === "string") this.ids.add(id);
      }
    } catch {
      // Missing or unreadable file: start empty.
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
    this.saveTimer.unref?.();
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, sessionIds: [...this.ids] }) + "\n", { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn("[known-sessions] Failed to save:", err);
    }
  }
}

export const knownSessions = new KnownSessionStore();
