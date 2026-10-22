import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceTokenStore, hashToken } from "./device-tokens.js";
import { authenticateRequest, isAuthConfigured } from "./auth.js";

describe("DeviceTokenStore", () => {
  let dir: string;
  let store: DeviceTokenStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccpocket-devices-"));
    store = new DeviceTokenStore(join(dir, "devices.json"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("issues a token that authenticates and stores only its hash", () => {
    const { device, token } = store.add("phone");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.authenticate(token)?.id).toBe(device.id);
    const raw = readFileSync(store.filePath, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));
    if (process.platform !== "win32") {
      expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects unknown, empty and revoked tokens", () => {
    const { device, token } = store.add("laptop");
    expect(store.authenticate("nope")).toBeNull();
    expect(store.authenticate("")).toBeNull();
    expect(store.authenticate(null)).toBeNull();
    expect(store.revoke(device.id)).toBe(true);
    expect(store.revoke(device.id)).toBe(false);
    expect(store.authenticate(token)).toBeNull();
    expect(store.active()).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
  });

  it("rotates a token in place and records last-seen on use", () => {
    const first = store.add("tablet");
    const rotated = store.rotate(first.device.id);
    expect(rotated?.device.id).toBe(first.device.id);
    expect(store.authenticate(first.token)).toBeNull();
    expect(store.authenticate(rotated!.token)?.name).toBe("tablet");
    expect(store.get(first.device.id)?.lastSeenAt).toBeTruthy();
    expect(store.rotate("missing")).toBeNull();
  });

  it("picks up edits made to the file by another process", () => {
    const { token } = store.add("phone");
    expect(store.authenticate(token)).not.toBeNull();
    // Simulate `devices revoke` from the CLI: rewrite the file externally.
    const parsed = JSON.parse(readFileSync(store.filePath, "utf8"));
    parsed.devices[0].revokedAt = new Date().toISOString();
    writeFileSync(store.filePath, JSON.stringify(parsed));
    // Force a different mtime even on coarse filesystems.
    const future = Date.now() / 1000 + 5;
    utimesSync(store.filePath, future, future);
    expect(store.authenticate(token)).toBeNull();
  });

  it("integrates with authenticateRequest next to the master key", () => {
    const { device, token } = store.add("desk");
    const config = { apiKey: "master", devices: store };
    expect(isAuthConfigured(config)).toBe(true);
    expect(isAuthConfigured({ apiKey: "", devices: store })).toBe(true);
    expect(authenticateRequest({ url: `/?token=${token}`, headers: {} }, config)).toEqual({
      ok: true,
      via: "device",
      device: { id: device.id, name: "desk" },
    });
    expect(authenticateRequest({ url: "/", headers: { authorization: "Bearer master" } }, config)).toEqual({
      ok: true,
      via: "master",
    });
    expect(authenticateRequest({ url: "/?token=wrong", headers: {} }, config)).toEqual({ ok: false });
    store.revoke(device.id);
    expect(authenticateRequest({ url: `/?token=${token}`, headers: {} }, config)).toEqual({ ok: false });
  });
});
