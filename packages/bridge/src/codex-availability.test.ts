import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isCodexOnPath, resetCodexAvailabilityCache, withTimeout } from "./codex-availability.js";

describe("isCodexOnPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-path-"));
    resetCodexAvailabilityCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetCodexAvailabilityCache();
  });

  it("finds an executable codex on PATH", async () => {
    expect(await isCodexOnPath(dir, "linux")).toBe(false);
    resetCodexAvailabilityCache();
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n");
    chmodSync(join(dir, "codex"), 0o755);
    expect(await isCodexOnPath(`/nonexistent:${dir}`, "linux")).toBe(true);
  });

  it("ignores a non-executable file and trusts Windows resolution", async () => {
    writeFileSync(join(dir, "codex"), "x");
    chmodSync(join(dir, "codex"), 0o644);
    expect(await isCodexOnPath(dir, "linux")).toBe(false);
    expect(await isCodexOnPath("", "win32")).toBe(true);
  });
});

describe("withTimeout", () => {
  it("passes a value through and rejects a hung promise", async () => {
    await expect(withTimeout(Promise.resolve(7), 50, "x")).resolves.toBe(7);
    await expect(withTimeout(new Promise(() => {}), 20, "hung")).rejects.toThrow("hung timed out after 20 ms");
  });
});
