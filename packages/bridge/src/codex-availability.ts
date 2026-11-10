import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * Fork: whether the `codex` CLI can be spawned at all.
 *
 * Without it the standalone app-server never answers `initialize`, and the
 * all-providers recent-session list (which waits for the Codex branch) never
 * replied — clients without a local cache (the web app) showed no sessions.
 * Cached briefly so installing Codex later is picked up without a restart.
 */
const CACHE_MS = 60_000;
let cached: { at: number; value: boolean } | null = null;

export async function isCodexOnPath(
  pathEnv = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
  now = Date.now(),
): Promise<boolean> {
  // Windows resolves codex.cmd/.exe through cmd.exe; do not second-guess it.
  if (platform === "win32") return true;
  if (cached && now - cached.at < CACHE_MS && pathEnv === (process.env.PATH ?? "")) return cached.value;
  let found = false;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, "codex"), constants.X_OK);
      found = true;
      break;
    } catch {
      // not in this directory
    }
  }
  cached = { at: now, value: found };
  return found;
}

export function resetCodexAvailabilityCache(): void {
  cached = null;
}

/** Reject after `ms` so a wedged provider cannot hold a reply forever. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
