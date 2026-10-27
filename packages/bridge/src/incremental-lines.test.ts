import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CursorCache, readNewLines, type LineCursor } from "./incremental-lines.js";

describe("readNewLines", () => {
  let dir: string;
  let file: string;
  const collect = async (cursor: LineCursor<string[]> | undefined, chunk?: number) =>
    readNewLines(file, cursor, () => [] as string[], (line, acc) => acc.push(line), chunk);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "incremental-lines-"));
    file = join(dir, "t.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("parses only appended lines and holds back an unfinished one", async () => {
    writeFileSync(file, "a\nb\npart");
    let c = await collect(undefined);
    expect(c.value).toEqual(["a", "b"]);
    appendFileSync(file, "ial\nc\n");
    c = await collect(c);
    expect(c.value).toEqual(["a", "b", "partial", "c"]);
    expect(await collect(c)).toBe(c);
  });

  it("keeps multi-byte characters intact across chunk edges", async () => {
    const lines = ["привет мир", "ёжик в тумане", "日本語テキスト"];
    writeFileSync(file, lines.join("\n") + "\n");
    for (const size of [1, 2, 3, 5, 7]) {
      const c = await collect(undefined, size);
      expect(c.value).toEqual(lines);
    }
  });

  it("starts over when the file shrank or was replaced", async () => {
    writeFileSync(file, "a\nb\n");
    let c = await collect(undefined);
    writeFileSync(file, "x\n");
    c = await collect(c);
    expect(c.value).toEqual(["x"]);
    const other = join(dir, "other.jsonl");
    writeFileSync(other, "y\nz\n");
    renameSync(other, file);
    c = await collect(c);
    expect(c.value).toEqual(["y", "z"]);
  });
});

describe("CursorCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new CursorCache<number>(2);
    const cur = (v: number): LineCursor<number> => ({ offset: 0, carry: Buffer.alloc(0), ino: 1, value: v });
    cache.set("a", cur(1));
    cache.set("b", cur(2));
    cache.get("a");
    cache.set("c", cur(3));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.value).toBe(1);
    expect(cache.get("c")?.value).toBe(3);
  });
});
