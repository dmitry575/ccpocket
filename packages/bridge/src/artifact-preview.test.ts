import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  artifactsFromTranscript,
  createArtifactToken,
  resolveArtifactFile,
  verifyArtifactToken,
  type ArtifactRecord,
} from "./artifact-preview.js";

const line = (o: unknown) => JSON.stringify(o);
const use = (id: string, input: Record<string, unknown>, ts = "2026-10-25T10:00:00Z") =>
  line({ type: "assistant", cwd: "/work", timestamp: ts, message: { content: [{ type: "tool_use", id, name: "Artifact", input }] } });
const result = (id: string, text: string) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });

describe("artifactsFromTranscript", () => {
  it("collects successful publishes, grouped by artifact url", () => {
    const transcript = [
      use("t1", { file_path: "out/report.html", description: "Report", files: { "app.js": "out/app.js", "data.json": { from: "/data/d.json" } } }),
      result("t1", "Published out/report.html at https://claude.ai/artifact/AbC123 (Version 1)"),
      use("t2", { file_path: "out/report.html" }, "2026-10-25T11:00:00Z"),
      result("t2", "Published out/report.html at https://claude.ai/artifact/AbC123 (Version 2)"),
      use("t3", { file_path: "/tmp/refused.html" }),
      result("t3", "Publishing was refused: ..."),
      use("t4", { action: "read", url: "https://claude.ai/artifact/x" }),
      use("t5", { url: "https://claude.ai/artifact/AbC123", file_path: "/tmp/logo.png", asset: true }),
    ].join("\n");
    const found = artifactsFromTranscript(transcript);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      toolUseIds: ["t1", "t2"],
      filePath: "/work/out/report.html",
      url: "https://claude.ai/artifact/AbC123",
      description: "Report",
      publishedAt: "2026-10-25T11:00:00Z",
      files: { "app.js": "/work/out/app.js", "data.json": "/data/d.json" },
    });
  });
});

describe("artifact tokens", () => {
  it("round-trips and expires", () => {
    const token = createArtifactToken("sess", "t1", 1_000);
    expect(verifyArtifactToken(token, 2_000)).toEqual({ sessionId: "sess", toolUseId: "t1" });
    expect(verifyArtifactToken(token, 1_000 + 3 * 60 * 60 * 1000)).toBeNull();
  });

  it("rejects a tampered token", () => {
    const [payload, mac] = createArtifactToken("sess", "t1").split(".");
    const forged = Buffer.from(JSON.stringify({ s: "other", t: "t1", e: Date.now() + 1e6 })).toString("base64url");
    expect(verifyArtifactToken(`${forged}.${mac}`)).toBeNull();
    expect(verifyArtifactToken(`${payload}.x${mac.slice(1)}`)).toBeNull();
    expect(verifyArtifactToken("garbage")).toBeNull();
  });
});

describe("resolveArtifactFile", () => {
  let dir: string;
  let artifact: ArtifactRecord;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "artifact-preview-"));
    mkdirSync(join(dir, "page", "img"), { recursive: true });
    mkdirSync(join(dir, "page", ".secret"));
    writeFileSync(join(dir, "page", "index.html"), "<title>T</title>");
    writeFileSync(join(dir, "page", "img", "a.png"), "png");
    writeFileSync(join(dir, "page", ".secret", "key"), "k");
    writeFileSync(join(dir, "outside.txt"), "nope");
    writeFileSync(join(dir, "mapped.js"), "js");
    symlinkSync(join(dir, "outside.txt"), join(dir, "page", "link.txt"));
    artifact = {
      toolUseIds: ["t1"],
      filePath: join(dir, "page", "index.html"),
      files: { "lib/app.js": join(dir, "mapped.js") },
      exists: true,
    };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serves the page, mapped files and neighbours", async () => {
    expect(await resolveArtifactFile(artifact, "index.html")).toBe(artifact.filePath);
    expect(await resolveArtifactFile(artifact, "")).toBe(artifact.filePath);
    expect(await resolveArtifactFile(artifact, "lib/app.js")).toBe(join(dir, "mapped.js"));
    expect(await resolveArtifactFile(artifact, "img/a.png")).toMatch(/img\/a\.png$/);
  });

  it("refuses traversal, hidden paths and symlinks out of the folder", async () => {
    expect(await resolveArtifactFile(artifact, "../outside.txt")).toBeNull();
    expect(await resolveArtifactFile(artifact, ".secret/key")).toBeNull();
    expect(await resolveArtifactFile(artifact, "link.txt")).toBeNull();
    expect(await resolveArtifactFile(artifact, "missing.css")).toBeNull();
  });
});
