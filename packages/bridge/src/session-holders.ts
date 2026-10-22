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
