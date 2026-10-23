import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExternalSessionHolder, stopIdleBackgroundHolder } from "./session-holders.js";

const SESSION = "11111111-2222-4333-8444-555555555555";

describe("findExternalSessionHolder", () => {
  let registry: string;
  beforeEach(() => {
    registry = mkdtempSync(join(tmpdir(), "ccpocket-sessions-"));
  });
  afterEach(() => {
    rmSync(registry, { recursive: true, force: true });
  });

  it("reports a live claude --bg session from the registry", async () => {
    writeFileSync(join(registry, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SESSION, kind: "bg", name: "nightly job" }));
    const holder = await findExternalSessionHolder(SESSION, {
      registryDir: registry,
      isAlive: (pid) => pid === 4242,
      listProcesses: async () => [],
    });
    expect(holder).toMatchObject({ kind: "background", pid: 4242 });
    expect(holder?.description).toContain("nightly job");
  });

  it("ignores registry entries whose process is gone", async () => {
    writeFileSync(join(registry, "4242.json"), JSON.stringify({ pid: 4242, sessionId: SESSION, kind: "bg" }));
    const holder = await findExternalSessionHolder(SESSION, {
      registryDir: registry,
      isAlive: () => false,
      listProcesses: async () => [],
    });
    expect(holder).toBeNull();
  });

  it("reports a terminal claude started with --resume or --session-id, but not our own children", async () => {
    const processes = [
      { pid: 10, ppid: 1, args: `claude --resume ${SESSION}` },
      { pid: 11, ppid: 999, args: `/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --resume /root/.claude/projects/-root/${SESSION}.jsonl` },
      { pid: 12, ppid: 1, args: "claude --resume other-session" },
    ];
    const cli = await findExternalSessionHolder(SESSION, {
      registryDir: registry,
      isAlive: () => true,
      listProcesses: async () => processes,
      selfPid: 999,
      platform: "linux",
    });
    expect(cli).toMatchObject({ kind: "cli", pid: 10 });

    const ownOnly = await findExternalSessionHolder(SESSION, {
      registryDir: registry,
      isAlive: () => true,
      listProcesses: async () => [processes[1]],
      selfPid: 999,
      platform: "linux",
    });
    expect(ownOnly).toBeNull();

    const sessionIdFlag = await findExternalSessionHolder(SESSION, {
      registryDir: registry,
      isAlive: () => true,
      listProcesses: async () => [{ pid: 20, ppid: 1, args: `claude --session-id=${SESSION} -p hi` }],
      selfPid: 999,
      platform: "linux",
    });
    expect(sessionIdFlag).toMatchObject({ kind: "cli", pid: 20 });
  });

  it("skips the process scan on Windows and tolerates ps failures", async () => {
    const win = await findExternalSessionHolder(SESSION, {
      registryDir: registry,
      listProcesses: async () => [{ pid: 10, ppid: 1, args: `claude --resume ${SESSION}` }],
      platform: "win32",
    });
    expect(win).toBeNull();
    const failing = await findExternalSessionHolder(SESSION, {
      registryDir: registry,
      listProcesses: async () => { throw new Error("ps missing"); },
      platform: "linux",
    });
    expect(failing).toBeNull();
  });
});

describe("stopIdleBackgroundHolder", () => {
  it("stops only idle background holders and waits for the process to exit", async () => {
    const run = vi.fn(async () => {});
    let alive = true;
    const ok = await stopIdleBackgroundHolder(
      { kind: "background", pid: 5, status: "idle", jobId: "abcd1234", description: "x" },
      { run, isAlive: () => { const a = alive; alive = false; return a; }, sleep: async () => {} },
    );
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledWith(["stop", "abcd1234"]);

    const busy = await stopIdleBackgroundHolder(
      { kind: "background", pid: 5, status: "busy", jobId: "abcd1234", description: "x" },
      { run },
    );
    expect(busy).toBe(false);
    const cli = await stopIdleBackgroundHolder({ kind: "cli", pid: 6, description: "x" }, { run });
    expect(cli).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
