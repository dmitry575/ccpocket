import { open, readdir, readFile, stat } from "node:fs/promises";
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
 * card in the chat is mapped to its subagent. The transcript is written block
 * by block, so polling it with `after` gives the same granularity the CLI's
 * own subagent view has.
 */
export type SubagentState = "running" | "done" | "failed" | "interrupted";

export interface SubagentMeta {
  agentId: string;
  toolUseId?: string;
  agentType?: string;
  description?: string;
  parentAgentId?: string;
  /** mtime of the transcript, ms since epoch. */
  updatedAt?: number;
  state?: SubagentState;
}

export type SubagentEntry =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean };

export interface SubagentHistory {
  agent: SubagentMeta;
  /** Other subagents of the same parent session (for navigation). */
  siblings: SubagentMeta[];
  entries: SubagentEntry[];
  /** Number of entries in the whole transcript; pass it back as `after`. */
  total: number;
  truncated: boolean;
}

const MAX_TEXT = 20_000;
const MAX_THINKING = 8_000;
const MAX_RESULT = 8_000;
const MAX_ENTRIES = 2_000;
/** A transcript untouched this long without a final answer was cut off. */
const STALE_MS = 10 * 60 * 1000;
const TAIL_BYTES = 64 * 1024;

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

async function readTail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Fallback when the parent transcript says nothing yet: an interrupt marker
 * means the subagent was cut off, a long silence too (bridge restart, crash);
 * otherwise it is still working. A finished subagent's own transcript may end
 * with a tool result (background agents hand their report back to the
 * parent), so "done" only comes from the parent transcript.
 */
export function subagentStateFromTail(tail: string, updatedAt: number, now = Date.now()): SubagentState {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // first line of the tail may be cut in half
    }
    if (entry.type === "user" && textOf(entry.message?.content).startsWith("[Request interrupted")) {
      return "interrupted";
    }
    if (entry.type === "user" || entry.type === "assistant") break;
  }
  return now - updatedAt > STALE_MS ? "interrupted" : "running";
}

const NOTIFICATION_RE =
  /<task-id>([A-Za-z0-9_-]+)<\/task-id>(?:(?!<\/task-notification>)[\s\S])*?<status>([a-z_]+)<\/status>/g;

/**
 * Outcomes the parent transcript records: `<task-notification>` for
 * background agents (keyed by agent id) and the Agent/Task tool_result for
 * foreground ones (keyed by tool_use id).
 */
export function parentOutcomes(transcript: string): Map<string, SubagentState> {
  const outcomes = new Map<string, SubagentState>();
  for (const line of transcript.split("\n")) {
    if (!line) continue;
    if (line.includes("<task-notification>")) {
      // JSON-escaped newlines stay as "\n" here; the pattern skips them.
      for (const m of line.replaceAll("\\n", "\n").matchAll(NOTIFICATION_RE)) {
        const status = m[2];
        outcomes.set(
          m[1],
          status === "completed" ? "done" : status === "failed" ? "failed" : status === "pending" || status === "running" ? "running" : "interrupted",
        );
      }
    }
    if (!line.includes('"tool_result"')) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" || !Array.isArray(entry.message?.content)) continue;
    for (const b of entry.message.content as Array<Record<string, unknown>>) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const text = textOf(b.content);
      // A background launch answers at once; its end comes as a notification.
      if (text.startsWith("Async agent launched")) continue;
      if (!outcomes.has(b.tool_use_id)) {
        outcomes.set(b.tool_use_id, b.is_error === true ? "failed" : "done");
      }
    }
  }
  return outcomes;
}

const outcomeCache = new Map<string, { mtimeMs: number; size: number; outcomes: Map<string, SubagentState> }>();

async function cachedParentOutcomes(transcript: string): Promise<Map<string, SubagentState>> {
  try {
    const info = await stat(transcript);
    const cached = outcomeCache.get(transcript);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.outcomes;
    const outcomes = parentOutcomes(await readFile(transcript, "utf8"));
    if (outcomeCache.size > 50) outcomeCache.clear();
    outcomeCache.set(transcript, { mtimeMs: info.mtimeMs, size: info.size, outcomes });
    return outcomes;
  } catch {
    return new Map();
  }
}

/** List subagents of a Claude session with their meta data and state. */
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
  const outcomes = await cachedParentOutcomes(transcript);
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
    try {
      const path = join(dir, file);
      meta.updatedAt = (await stat(path)).mtimeMs;
      meta.state =
        outcomes.get(agentId) ??
        (meta.toolUseId ? outcomes.get(meta.toolUseId) : undefined) ??
        subagentStateFromTail(await readTail(path, TAIL_BYTES), meta.updatedAt);
    } catch {
      // Raced with a cleanup: keep the agent without state.
    }
    metas.push(meta);
  }
  return metas.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Convert SDK session messages into flat, render-friendly entries. */
export function toSubagentEntries(messages: Array<{ type: string; message: unknown }>): SubagentEntry[] {
  const entries: SubagentEntry[] = [];
  for (const m of messages) {
    const msg = (m.message ?? {}) as { content?: unknown };
    const content = msg.content;
    if (m.type === "assistant" && Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          entries.push({ kind: "text", role: "assistant", text: clip(b.text, MAX_TEXT) });
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          entries.push({ kind: "thinking", text: clip(b.thinking, MAX_THINKING) });
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
  return entries;
}

/**
 * Entries after index `after` (all when omitted), keeping at most the latest
 * MAX_ENTRIES. `total` is the full count, for the next `after`.
 */
export function sliceSubagentEntries(
  all: SubagentEntry[],
  after?: number,
): { entries: SubagentEntry[]; total: number; truncated: boolean } {
  const from = after !== undefined && after >= 0 && after <= all.length ? after : 0;
  const fresh = all.slice(from);
  const truncated = fresh.length > MAX_ENTRIES;
  return {
    entries: truncated ? fresh.slice(-MAX_ENTRIES) : fresh,
    total: all.length,
    truncated,
  };
}

/**
 * History of the subagent started by `toolUseId` (or with `agentId`) in the
 * given Claude session; null when it cannot be found (yet).
 */
export async function getSubagentHistory(
  claudeSessionId: string,
  ref: { toolUseId?: string; agentId?: string; after?: number },
): Promise<SubagentHistory | null> {
  const metas = await listSubagentMeta(claudeSessionId);
  const agent =
    metas.find((m) => ref.agentId && m.agentId === ref.agentId) ??
    metas.find((m) => ref.toolUseId && m.toolUseId === ref.toolUseId);
  if (!agent) return null;
  const messages = await getSubagentMessages(claudeSessionId, agent.agentId);
  const all = toSubagentEntries(messages as unknown as Array<{ type: string; message: unknown }>);
  return {
    agent,
    siblings: metas.filter((m) => m.agentId !== agent.agentId),
    ...sliceSubagentEntries(all, ref.after),
  };
}
