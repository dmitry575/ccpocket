import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listSubagentMeta,
  parentOutcomes,
  sliceSubagentEntries,
  subagentStateFromTail,
  toSubagentEntries,
} from "./subagent-history.js";

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
    expect(byId.a1).toMatchObject({
      agentId: "a1",
      toolUseId: "toolu_1",
      agentType: "Explore",
      description: "Find specs",
      state: "running",
    });
    expect(typeof byId.a1.updatedAt).toBe("number");
    expect(byId.b2).toMatchObject({ agentId: "b2" });
    expect(byId.b2.toolUseId).toBeUndefined();
  });

  it("returns an empty list for an unknown session", async () => {
    expect(await listSubagentMeta("99999999-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("toSubagentEntries", () => {
  it("flattens prompts, text, tool calls and results", () => {
    const entries = toSubagentEntries([
      { type: "user", message: { content: "Look for the spec" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "Grep first" },
            { type: "thinking", thinking: "  " },
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
    expect(entries).toEqual([
      { kind: "text", role: "user", text: "Look for the spec" },
      { kind: "thinking", text: "Grep first" },
      { kind: "text", role: "assistant", text: "Searching." },
      { kind: "tool_use", id: "t1", name: "Grep", input: { pattern: "spec" } },
      { kind: "tool_result", toolUseId: "t1", content: "a.md:1", isError: true },
    ]);
  });

  it("clips long tool output and keeps the latest entries", () => {
    const long = "x".repeat(9_000);
    const entries = toSubagentEntries([
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: long }] } },
    ]);
    const content = (entries[0] as { content: string }).content;
    expect(content.startsWith("x".repeat(8_000))).toBe(true);
    expect(content).toContain("1000 more characters");

    const many = Array.from({ length: 2_005 }, (_, i) => ({
      type: "user",
      message: { content: `prompt ${i}` },
    }));
    const result = sliceSubagentEntries(toSubagentEntries(many));
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(2_005);
    expect(result.entries).toHaveLength(2_000);
    expect(result.entries[0]).toEqual({ kind: "text", role: "user", text: "prompt 5" });
  });
});

describe("sliceSubagentEntries", () => {
  const all = toSubagentEntries(
    ["a", "b", "c"].map((t) => ({ type: "user", message: { content: t } })),
  );

  it("returns only entries after the given index", () => {
    expect(sliceSubagentEntries(all, 2)).toEqual({
      entries: [{ kind: "text", role: "user", text: "c" }],
      total: 3,
      truncated: false,
    });
    expect(sliceSubagentEntries(all, 3).entries).toEqual([]);
  });

  it("starts over when the index is past the end (transcript rewritten)", () => {
    expect(sliceSubagentEntries(all, 9).entries).toHaveLength(3);
  });
});

describe("subagentStateFromTail", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const now = 1_000_000_000;

  it("is interrupted after an interrupt marker", () => {
    const tail = line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    expect(subagentStateFromTail(tail, now, now)).toBe("interrupted");
  });

  it("is running while a tool call is in flight, interrupted once stale", () => {
    const tail = line({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } });
    expect(subagentStateFromTail(tail, now - 5_000, now)).toBe("running");
    expect(subagentStateFromTail(tail, now - 11 * 60 * 1000, now)).toBe("interrupted");
  });
});

describe("parentOutcomes", () => {
  const line = (o: unknown) => JSON.stringify(o);

  it("reads background notifications and foreground tool results", () => {
    const transcript = [
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: [{ type: "text", text: "Async agent launched successfully." }] }] } }),
      line({ type: "queue-operation", content: "<task-notification>\n<task-id>abg</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n</task-notification>" }),
      line({ type: "queue-operation", content: "<task-notification>\n<task-id>akill</task-id>\n<status>killed</status>\n</task-notification>" }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "report" }] } }),
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_err", content: "boom", is_error: true }] } }),
      "not json",
    ].join("\n");
    const outcomes = parentOutcomes(transcript);
    expect(outcomes.get("abg")).toBe("done");
    expect(outcomes.get("akill")).toBe("interrupted");
    expect(outcomes.get("toolu_fg")).toBe("done");
    expect(outcomes.get("toolu_err")).toBe("failed");
    expect(outcomes.has("toolu_bg")).toBe(false);
  });
});
