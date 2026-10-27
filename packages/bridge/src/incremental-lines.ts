import { open, stat } from "node:fs/promises";

/**
 * Fork: read an append-only JSONL transcript incrementally.
 *
 * The app polls subagent and artifact lists every few seconds; re-reading
 * whole transcripts (tens of MB for long sessions) on each poll cost ~100 MB
 * of transient heap and seconds of CPU per request. Callers keep one state
 * per file and only the appended lines are parsed. A file that shrank (or
 * was replaced) is read again from the start.
 */
export interface LineCursor<T> {
  offset: number;
  /** Bytes of an incomplete last line, carried over to the next read. */
  carry: Buffer;
  ino: number;
  value: T;
}

const CHUNK = 1 << 20;

export async function readNewLines<T>(
  path: string,
  cursor: LineCursor<T> | undefined,
  init: () => T,
  onLine: (line: string, value: T) => void,
  chunkSize = CHUNK,
): Promise<LineCursor<T>> {
  const info = await stat(path);
  let state = cursor;
  if (!state || info.size < state.offset || info.ino !== state.ino) {
    state = { offset: 0, carry: Buffer.alloc(0), ino: info.ino, value: init() };
  }
  if (info.size === state.offset) return state;

  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(chunkSize, info.size - state.offset));
    let position = state.offset;
    while (position < info.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (bytesRead === 0) break;
      position += bytesRead;
      // Decode only up to the last newline: "\n" never occurs inside a UTF-8
      // sequence, so a character cut at the chunk edge stays in the carry.
      const chunk = Buffer.concat([state.carry, buffer.subarray(0, bytesRead)]);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) {
        state.carry = chunk;
        continue;
      }
      state.carry = Buffer.from(chunk.subarray(lastNl + 1));
      for (const line of chunk.subarray(0, lastNl).toString("utf8").split("\n")) {
        if (line) onLine(line, state.value);
      }
    }
    state.offset = position;
  } finally {
    await handle.close();
  }
  return state;
}

/** Small LRU map for per-file cursors. */
export class CursorCache<T> {
  private readonly map = new Map<string, LineCursor<T>>();
  constructor(private readonly max = 200) {}

  get(path: string): LineCursor<T> | undefined {
    const hit = this.map.get(path);
    if (hit) {
      this.map.delete(path);
      this.map.set(path, hit);
    }
    return hit;
  }

  set(path: string, cursor: LineCursor<T>): void {
    this.map.delete(path);
    this.map.set(path, cursor);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
