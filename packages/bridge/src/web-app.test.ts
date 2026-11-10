import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isEntryFile, resolveWebAppFile, webAppContentType } from "./web-app.js";

describe("resolveWebAppFile", () => {
  let base: string;
  let dir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "web-app-"));
    dir = join(base, "web-app");
    mkdirSync(join(dir, "assets", "fonts"), { recursive: true });
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, "index.html"), "<html>");
    writeFileSync(join(dir, "main.dart.js"), "js");
    writeFileSync(join(dir, "assets", "fonts", "a.ttf"), "ttf");
    writeFileSync(join(dir, ".hidden", "x"), "x");
    writeFileSync(join(base, "secret.txt"), "nope");
    symlinkSync(join(base, "secret.txt"), join(dir, "link.txt"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("serves index, files and falls back to index for app routes", async () => {
    expect((await resolveWebAppFile(dir, "/app/"))?.rel).toBe("index.html");
    expect((await resolveWebAppFile(dir, "/app/main.dart.js"))?.rel).toBe("main.dart.js");
    expect((await resolveWebAppFile(dir, "/app/assets/fonts/a.ttf"))?.file).toMatch(/a\.ttf$/);
    expect((await resolveWebAppFile(dir, "/app/sessions/abc"))?.rel).toBe("index.html");
    expect(await resolveWebAppFile(dir, "/app/missing.js")).toBeNull();
  });

  it("refuses traversal, hidden paths, symlinks out and other prefixes", async () => {
    expect(await resolveWebAppFile(dir, "/app/../secret.txt")).toBeNull();
    expect(await resolveWebAppFile(dir, "/app/%2e%2e/secret.txt")).toBeNull();
    expect(await resolveWebAppFile(dir, "/app/.hidden/x")).toBeNull();
    expect(await resolveWebAppFile(dir, "/app/link.txt")).toBeNull();
    expect(await resolveWebAppFile(dir, "/apps/index.html")).toBeNull();
    expect(await resolveWebAppFile(join(base, "absent"), "/app/")).toBeNull();
  });
});

describe("web app headers", () => {
  it("knows wasm and marks entry files for revalidation", () => {
    expect(webAppContentType("main.dart.wasm")).toBe("application/wasm");
    expect(isEntryFile("flutter_service_worker.js")).toBe(true);
    expect(isEntryFile("assets/fonts/a.ttf")).toBe(false);
  });
});
