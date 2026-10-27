import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findSessionJsonlPath } from "./sessions-index.js";
import { CursorCache, readNewLines } from "./incremental-lines.js";

/**
 * Fork: preview of Artifacts a session published, without claude.ai.
 *
 * The Artifact tool publishes a local file (`file_path`, plus a `files` map
 * of supporting files), so while that file is still on the server the bridge
 * can serve it. The app opens it through a signed, expiring URL
 * (`/artifact/<token>/<name>`), which also works for sub-resources a WebView
 * cannot attach an Authorization header to.
 */
export interface ArtifactRecord {
  /** Every publish of this artifact, oldest first. */
  toolUseIds: string[];
  filePath: string;
  /** published path -> absolute source path */
  files: Record<string, string>;
  /** claude.ai link from the tool result, when the publish succeeded. */
  url?: string;
  title?: string;
  description?: string;
  publishedAt?: string;
  exists: boolean;
}

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const PUBLISHED_RE = /^Published (.+?) at (https:\/\/claude\.ai\/\S+?)(?:[\s(]|$)/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/** Artifact publishes found in transcript text (one JSON entry per line). */
export function artifactsFromTranscript(transcript: string): Omit<ArtifactRecord, "exists" | "title">[] {
  const scan = newArtifactScan();
  for (const line of transcript.split("\n")) scanArtifactLine(line, scan);
  return [...scan.byKey.values()];
}

type FoundArtifact = Omit<ArtifactRecord, "exists" | "title">;

/** Parse state of one transcript, kept between incremental reads. */
export interface ArtifactScan {
  uses: Map<string, { input: Record<string, unknown>; cwd?: string; ts?: string }>;
  byKey: Map<string, FoundArtifact>;
}

export function newArtifactScan(): ArtifactScan {
  return { uses: new Map(), byKey: new Map() };
}

/** One transcript line of {@link artifactsFromTranscript}. */
export function scanArtifactLine(line: string, scan: ArtifactScan): void {
  const { uses, byKey } = scan;
  {
    if (!line.includes('"Artifact"') && !line.includes("Published ")) return;
    let entry: { type?: string; cwd?: string; timestamp?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as Array<Record<string, unknown>>) {
      if (entry.type === "assistant" && b.type === "tool_use" && b.name === "Artifact") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const action = (input.action as string | undefined) ?? "publish";
        if (action !== "publish" || input.asset === true || typeof input.file_path !== "string") continue;
        uses.set(String(b.id), { input, cwd: entry.cwd, ts: entry.timestamp });
      } else if (entry.type === "user" && b.type === "tool_result" && uses.has(String(b.tool_use_id))) {
        const id = String(b.tool_use_id);
        const use = uses.get(id)!;
        const match = PUBLISHED_RE.exec(textOf(b.content).trim());
        if (!match) continue; // refused or failed publish
        const base = use.cwd ?? "/";
        const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
        const filePath = abs(use.input.file_path as string);
        const files: Record<string, string> = {};
        const rawFiles = use.input.files;
        if (rawFiles && typeof rawFiles === "object" && !Array.isArray(rawFiles)) {
          for (const [published, source] of Object.entries(rawFiles as Record<string, unknown>)) {
            const from = typeof source === "string" ? source : (source as { from?: unknown } | null)?.from;
            if (typeof from === "string") files[published] = abs(from);
          }
        }
        const url = match[2];
        const key = url;
        const previous = byKey.get(key);
        byKey.set(key, {
          toolUseIds: [...(previous?.toolUseIds ?? []), id],
          filePath,
          files: { ...(previous?.files ?? {}), ...files },
          url,
          description: (use.input.description as string | undefined) ?? previous?.description,
          publishedAt: use.ts ?? previous?.publishedAt,
        });
      }
    }
  }
}

async function titleOf(path: string): Promise<string | undefined> {
  try {
    const head = (await readFile(path, "utf8")).slice(0, 8192);
    const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(head);
    return m?.[1].trim() || undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const listCache = new Map<string, { at: number; value: Promise<ArtifactRecord[]> }>();
const LIST_CACHE_MS = 5_000;

/**
 * Artifacts published by a Claude session and its subagents, newest first.
 * Cached for a few seconds: one page load fetches many sub-resources.
 */
export function listSessionArtifacts(claudeSessionId: string): Promise<ArtifactRecord[]> {
  const now = Date.now();
  const hit = listCache.get(claudeSessionId);
  if (hit && now - hit.at < LIST_CACHE_MS) return hit.value;
  if (listCache.size > 50) listCache.clear();
  const value = scanSessionArtifacts(claudeSessionId);
  listCache.set(claudeSessionId, { at: now, value });
  value.catch(() => listCache.delete(claudeSessionId));
  return value;
}

const scanCursors = new CursorCache<ArtifactScan>(300);

async function scanSessionArtifacts(claudeSessionId: string): Promise<ArtifactRecord[]> {
  const transcript = await findSessionJsonlPath(claudeSessionId);
  if (!transcript) return [];
  const paths = [transcript];
  const subDir = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  try {
    for (const f of await readdir(subDir)) if (f.endsWith(".jsonl")) paths.push(join(subDir, f));
  } catch {
    // no subagents
  }
  const merged = new Map<string, FoundArtifact>();
  for (const p of paths) {
    let found: FoundArtifact[];
    try {
      // Only lines appended since the previous poll are parsed.
      const cursor = await readNewLines(p, scanCursors.get(p), newArtifactScan, scanArtifactLine);
      scanCursors.set(p, cursor);
      found = [...cursor.value.byKey.values()];
    } catch {
      continue;
    }
    for (const a of found) {
      const key = a.url ?? a.filePath;
      const prev = merged.get(key);
      // Never mutate `a`/`prev` in place: they live in the cursor cache.
      if (!prev || (a.publishedAt ?? "") >= (prev.publishedAt ?? "")) {
        merged.set(key, prev ? { ...a, toolUseIds: [...prev.toolUseIds, ...a.toolUseIds] } : a);
      } else {
        merged.set(key, { ...prev, toolUseIds: [...prev.toolUseIds, ...a.toolUseIds] });
      }
    }
  }
  const out: ArtifactRecord[] = [];
  for (const a of merged.values()) {
    const ok = await exists(a.filePath);
    out.push({ ...a, exists: ok, title: ok ? await titleOf(a.filePath) : undefined });
  }
  return out.sort((x, y) => (y.publishedAt ?? "").localeCompare(x.publishedAt ?? ""));
}

// ---- Signed view URLs ----

let fallbackSecret: Buffer | null = null;
function secret(): Buffer {
  const key = process.env.BRIDGE_API_KEY;
  if (key) return Buffer.from(`artifact-view:${key}`);
  fallbackSecret ??= randomBytes(32);
  return fallbackSecret;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createArtifactToken(claudeSessionId: string, toolUseId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ s: claudeSessionId, t: toolUseId, e: now + TOKEN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifyArtifactToken(token: string, now = Date.now()): { sessionId: string; toolUseId: string } | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s?: unknown; t?: unknown; e?: unknown };
    if (typeof data.s !== "string" || typeof data.t !== "string" || typeof data.e !== "number") return null;
    if (data.e < now) return null;
    return { sessionId: data.s, toolUseId: data.t };
  } catch {
    return null;
  }
}

/** Relative view path for an artifact: `/artifact/<token>/<file name>`. */
export function artifactViewPath(claudeSessionId: string, artifact: ArtifactRecord): string {
  const id = artifact.toolUseIds[artifact.toolUseIds.length - 1];
  return `/artifact/${createArtifactToken(claudeSessionId, id)}/${encodeURIComponent(basename(artifact.filePath))}`;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Local file behind `/artifact/<token>/<rest>`: the page itself, a file from
 * its `files` map, or a file under the page's own directory. Anything else
 * (traversal, symlinks out of the directory) is refused with null.
 */
export async function resolveArtifactFile(artifact: ArtifactRecord, rest: string): Promise<string | null> {
  if (rest.split("/").some((part) => part === "..")) return null;
  const pageName = basename(artifact.filePath);
  if (rest === "" || rest === pageName || rest === "index.html") return artifact.filePath;
  const mapped = artifact.files[rest];
  if (mapped) return mapped;
  const root = dirname(artifact.filePath);
  // Neighbouring files only for a page in its own folder: never next to a
  // page saved straight into the home or root directory, never hidden paths.
  if (root === "/" || root === homedir() || rest.split("/").some((part) => part.startsWith("."))) {
    return null;
  }
  const candidate = resolve(root, rest);
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
    const rel = relative(realRoot, realFile);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === "..") return null;
    return realFile;
  } catch {
    return null;
  }
}
