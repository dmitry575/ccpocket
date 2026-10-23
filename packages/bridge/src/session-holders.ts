import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Detects whether a Claude Code session is already being driven by a process
 * outside this bridge: a `claude --bg` background session (registered in
 * ~/.claude/sessions) or an interactive CLI started with `--resume <id>` /
 * `--session-id <id>`. The CLI has no session lock, so a second writer would
 * interleave its turns into the same transcript; the Agent SDK refuses
 * outright for background sessions (`session_held_by_background`).
 *
 * Limitations: an interactive `claude` that resumed through the /resume
 * picker does not carry the session id in its arguments and cannot be seen.
 */
export interface ExternalSessionHolder {
  kind: "background" | "cli";
  pid: number;
  description: string;
  /** Background sessions only: registry status ("idle" | "busy" | ...). */
  status?: string;
  /** Background sessions only: short id accepted by `claude stop`. */
  jobId?: string;
  /** Background sessions only: display name from the registry, if meaningful. */
  name?: string;
}

export interface SessionHolderDeps {
  registryDir?: string;
  listProcesses?: () => Promise<Array<{ pid: number; ppid: number; args: string }>>;
  isAlive?: (pid: number) => boolean;
  selfPid?: number;
  platform?: NodeJS.Platform;
}

const execFileAsync = promisify(execFile);

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultListProcesses(): Promise<Array<{ pid: number; ppid: number; args: string }>> {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf-8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const rows: Array<{ pid: number; ppid: number; args: string }> = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return rows;
}

function readBackgroundRegistry(
  registryDir: string,
  sessionId: string,
  isAlive: (pid: number) => boolean,
): ExternalSessionHolder | null {
  let files: string[];
  try {
    files = readdirSync(registryDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8")) as Record<string, unknown>;
      if (entry.sessionId !== sessionId) continue;
      const pid = Number(entry.pid);
      if (!Number.isFinite(pid) || !isAlive(pid)) continue;
      const name = typeof entry.name === "string" ? entry.name : file.replace(/\.json$/, "");
      return {
        kind: "background",
        pid,
        description: `claude --bg session "${name}" (pid ${pid})`,
        ...(typeof entry.status === "string" ? { status: entry.status } : {}),
        jobId: typeof entry.jobId === "string" ? entry.jobId : sessionId.slice(0, 8),
        ...(typeof entry.name === "string" &&
        entry.name.trim() &&
        entry.name !== entry.jobId &&
        !sessionId.startsWith(entry.name)
          ? { name: entry.name.trim() }
          : {}),
      };
    } catch {
      // Unreadable registry entry: ignore.
    }
  }
  return null;
}

/**
 * Returns the external holder of `sessionId`, or null when nothing outside
 * this bridge process is known to drive it.
 */
export async function findExternalSessionHolder(
  sessionId: string,
  deps: SessionHolderDeps = {},
): Promise<ExternalSessionHolder | null> {
  const registryDir = deps.registryDir ?? join(homedir(), ".claude", "sessions");
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const selfPid = deps.selfPid ?? process.pid;
  const platform = deps.platform ?? process.platform;

  const background = readBackgroundRegistry(registryDir, sessionId, isAlive);
  if (background) return background;

  if (platform === "win32") return null;
  let processes: Array<{ pid: number; ppid: number; args: string }>;
  try {
    processes = await (deps.listProcesses ?? defaultListProcesses)();
  } catch (err) {
    console.warn("[session-holders] Could not list processes:", err);
    return null;
  }
  const needle = new RegExp(`(?:--resume|--session-id)[= ]+(?:\\S*/)?${sessionId}(?:\\.jsonl)?(?:\\s|$)`);
  for (const proc of processes) {
    if (proc.pid === selfPid || proc.ppid === selfPid) continue; // our own SDK children
    if (!/\bclaude(?:\.exe)?\b/.test(proc.args)) continue;
    if (!needle.test(proc.args)) continue;
    return {
      kind: "cli",
      pid: proc.pid,
      description: `claude process pid ${proc.pid} started with this session id`,
    };
  }
  return null;
}

/**
 * Stop an idle `claude --bg` session so the bridge can take the session
 * over instead of opening a copy. The conversation is kept by the CLI
 * (`claude stop` only ends the process). Resolves true once the process is
 * gone.
 */
export async function stopIdleBackgroundHolder(
  holder: ExternalSessionHolder,
  deps: {
    run?: (args: string[]) => Promise<void>;
    isAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  if (holder.kind !== "background" || holder.status !== "idle" || !holder.jobId) {
    return false;
  }
  const run =
    deps.run ??
    (async (args: string[]) => {
      await execFileAsync("claude", args, { timeout: 30_000, encoding: "utf-8" });
    });
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    await run(["stop", holder.jobId]);
  } catch (err) {
    console.warn(`[session-holders] claude stop ${holder.jobId} failed:`, err);
    return false;
  }
  for (let i = 0; i < 40; i++) {
    if (!isAlive(holder.pid)) return true;
    await sleep(250);
  }
  return !isAlive(holder.pid);
}
