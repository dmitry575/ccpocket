import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import { findSessionJsonlPath } from "./sessions-index.js";

/**
 * Fork: read-only view of a subagent's transcript for the app.
 *
 * Claude Code stores each subagent next to the parent transcript:
 *   <project>/<sessionId>/subagents/agent-<agentId>.jsonl
 *   <project>/<sessionId>/subagents/agent-<agentId>.meta.json
 * The meta file carries the parent's Agent/Task `toolUseId`, which is how a
 * card in the chat is mapped to its subagent.
 */
export interface SubagentMeta {
  agentId: string;
  toolUseId?: string;
  agentType?: string;
  description?: string;
  parentAgentId?: string;
}

export type SubagentEntry =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean };

export interface SubagentHistory {
  agent: SubagentMeta;
  /** Other subagents of the same parent session (for navigation). */
  siblings: SubagentMeta[];
  entries: SubagentEntry[];
  truncated: boolean;
}

const MAX_TEXT = 20_000;
const MAX_RESULT = 8_000;
const MAX_ENTRIES = 2_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && (b as { type?: string }).type === "text"
          ? String((b as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** List subagents of a Claude session with their meta data. */
export async function listSubagentMeta(claudeSessionId: string): Promise<SubagentMeta[]> {
  const transcript = await findSessionJsonlPath(claudeSessionId);
  if (!transcript) return [];
  const dir = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const metas: SubagentMeta[] = [];
  for (const file of files) {
    const match = /^agent-(.+)\.jsonl$/.exec(file);
    if (!match) continue;
    const agentId = match[1];
    const meta: SubagentMeta = { agentId };
    try {
      const raw = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), "utf8")) as Record<string, unknown>;
      if (typeof raw.toolUseId === "string") meta.toolUseId = raw.toolUseId;
      if (typeof raw.agentType === "string") meta.agentType = raw.agentType;
      if (typeof raw.description === "string") meta.description = raw.description;
      if (typeof raw.parentAgentId === "string") meta.parentAgentId = raw.parentAgentId;
    } catch {
      // No meta file (older CLI): the agent is still listed.
    }
    metas.push(meta);
  }
  return metas;
}

/** Convert SDK session messages into flat, render-friendly entries. */
export function toSubagentEntries(messages: Array<{ type: string; message: unknown }>): {
  entries: SubagentEntry[];
  truncated: boolean;
} {
  const entries: SubagentEntry[] = [];
  for (const m of messages) {
    const msg = (m.message ?? {}) as { content?: unknown };
    const content = msg.content;
    if (m.type === "assistant" && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          entries.push({ kind: "text", role: "assistant", text: clip(b.text, MAX_TEXT) });
        } else if (b.type === "tool_use") {
          entries.push({
            kind: "tool_use",
            id: String(b.id ?? ""),
            name: String(b.name ?? "tool"),
            input: (b.input as Record<string, unknown>) ?? {},
          });
        }
      }
    } else if (m.type === "user") {
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === "tool_result") {
            entries.push({
              kind: "tool_result",
              toolUseId: String(b.tool_use_id ?? ""),
              content: clip(textOf(b.content), MAX_RESULT),
              isError: b.is_error === true,
            });
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            entries.push({ kind: "text", role: "user", text: clip(b.text, MAX_TEXT) });
          }
        }
      } else {
        const text = textOf(content);
        if (text.trim()) entries.push({ kind: "text", role: "user", text: clip(text, MAX_TEXT) });
      }
    }
  }
  const truncated = entries.length > MAX_ENTRIES;
  return { entries: truncated ? entries.slice(-MAX_ENTRIES) : entries, truncated };
}

/**
 * History of the subagent started by `toolUseId` (or with `agentId`) in the
 * given Claude session; null when it cannot be found (yet).
 */
export async function getSubagentHistory(
  claudeSessionId: string,
  ref: { toolUseId?: string; agentId?: string },
): Promise<SubagentHistory | null> {
  const metas = await listSubagentMeta(claudeSessionId);
  const agent =
    metas.find((m) => ref.agentId && m.agentId === ref.agentId) ??
    metas.find((m) => ref.toolUseId && m.toolUseId === ref.toolUseId);
  if (!agent) return null;
  const messages = await getSubagentMessages(claudeSessionId, agent.agentId);
  const { entries, truncated } = toSubagentEntries(
    messages as unknown as Array<{ type: string; message: unknown }>,
  );
  return {
    agent,
    siblings: metas.filter((m) => m.agentId !== agent.agentId),
    entries,
    truncated,
  };
}
