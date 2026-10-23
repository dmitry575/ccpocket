import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSubagentMeta, toSubagentEntries } from "./subagent-history.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

describe("listSubagentMeta", () => {
  const oldHome = process.env.HOME;
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "subagent-history-"));
    process.env.HOME = tempHome;
    const project = join(tempHome, ".claude", "projects", "-root-demo");
    mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
    writeFileSync(join(project, `${SESSION}.jsonl`), "{}\n");
    const dir = join(project, SESSION, "subagents");
    writeFileSync(join(dir, "agent-a1.jsonl"), "{}\n");
    writeFileSync(
      join(dir, "agent-a1.meta.json"),
      JSON.stringify({ toolUseId: "toolu_1", agentType: "Explore", description: "Find specs" }),
    );
    // No meta file: still listed.
    writeFileSync(join(dir, "agent-b2.jsonl"), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "ignored");
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("lists subagents with their meta data", async () => {
    const metas = await listSubagentMeta(SESSION);
    const byId = Object.fromEntries(metas.map((m) => [m.agentId, m]));
    expect(Object.keys(byId).sort()).toEqual(["a1", "b2"]);
    expect(byId.a1).toEqual({
      agentId: "a1",
      toolUseId: "toolu_1",
      agentType: "Explore",
      description: "Find specs",
    });
    expect(byId.b2).toEqual({ agentId: "b2" });
  });

  it("returns an empty list for an unknown session", async () => {
    expect(await listSubagentMeta("99999999-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("toSubagentEntries", () => {
  it("flattens prompts, text, tool calls and results", () => {
    const { entries, truncated } = toSubagentEntries([
      { type: "user", message: { content: "Look for the spec" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Searching." },
            { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "spec" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "a.md:1" }],
              is_error: true,
            },
          ],
        },
      },
      { type: "system", message: { content: "ignored" } },
    ]);
    expect(truncated).toBe(false);
    expect(entries).toEqual([
      { kind: "text", role: "user", text: "Look for the spec" },
      { kind: "text", role: "assistant", text: "Searching." },
      { kind: "tool_use", id: "t1", name: "Grep", input: { pattern: "spec" } },
      { kind: "tool_result", toolUseId: "t1", content: "a.md:1", isError: true },
    ]);
  });

  it("clips long tool output and keeps the latest entries", () => {
    const long = "x".repeat(9_000);
    const { entries } = toSubagentEntries([
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }] } },
    ]);
    const content = (entries[0] as { content: string }).content;
    expect(content.startsWith("x".repeat(8_000))).toBe(true);
    expect(content).toContain("1000 more characters");

    const many = Array.from({ length: 2_005 }, (_, i) => ({
      type: "user",
      message: { content: `prompt ${i}` },
    }));
    const result = toSubagentEntries(many);
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(2_000);
    expect(result.entries[0]).toEqual({ kind: "text", role: "user", text: "prompt 5" });
  });
});
