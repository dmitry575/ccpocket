import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Per-device access tokens.
 *
 * Upstream authenticates every client with the single BRIDGE_API_KEY. This
 * store adds named device tokens that can be issued, rotated and revoked one
 * by one (`ccpocket-bridge devices ...`). Only SHA-256 hashes are persisted;
 * the plaintext token is shown once when the device is added or rotated.
 *
 * File: ~/.ccpocket/devices.json (mode 0600). The bridge re-reads it when its
 * mtime changes, so CLI edits apply to a running bridge without a restart.
 */
export interface DeviceRecord {
  id: string;
  name: string;
  /** Hex SHA-256 of the token. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface IssuedDevice {
  device: DeviceRecord;
  /** Plaintext token, shown once. */
  token: string;
}

interface DevicesFile {
  version: 1;
  devices: DeviceRecord[];
}

export const DEFAULT_DEVICES_FILE = join(homedir(), ".ccpocket", "devices.json");

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class DeviceTokenStore {
  private cache: DeviceRecord[] = [];
  private cacheMtimeMs = -1;
  private lastSeenWrites = new Map<string, number>();

  constructor(readonly filePath: string = DEFAULT_DEVICES_FILE) {}

  /** Active (non-revoked) devices. */
  active(): DeviceRecord[] {
    return this.load().filter((d) => !d.revokedAt);
  }

  list(): DeviceRecord[] {
    return this.load().map((d) => ({ ...d }));
  }

  get(id: string): DeviceRecord | undefined {
    return this.load().find((d) => d.id === id);
  }

  /** Issue a new device token. */
  add(name: string): IssuedDevice {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Device name must not be empty");
    const token = randomBytes(32).toString("hex");
    const device: DeviceRecord = {
      id: randomUUID().slice(0, 8),
      name: trimmed,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    };
    const devices = this.load();
    devices.push(device);
    this.save(devices);
    return { device: { ...device }, token };
  }

  /** Revoke a device; its token stops working immediately. */
  revoke(id: string): boolean {
    const devices = this.load();
    const device = devices.find((d) => d.id === id);
    if (!device || device.revokedAt) return false;
    device.revokedAt = new Date().toISOString();
    this.save(devices);
    return true;
  }

  /** Replace a device's token, keeping its id and name. */
  rotate(id: string): IssuedDevice | null {
    const devices = this.load();
    const device = devices.find((d) => d.id === id && !d.revokedAt);
    if (!device) return null;
    const token = randomBytes(32).toString("hex");
    device.tokenHash = hashToken(token);
    device.createdAt = new Date().toISOString();
    this.save(devices);
    return { device: { ...device }, token };
  }

  /** Remove a device record entirely (revoked or not). */
  remove(id: string): boolean {
    const devices = this.load();
    const next = devices.filter((d) => d.id !== id);
    if (next.length === devices.length) return false;
    this.save(next);
    return true;
  }

  /**
   * Constant-time lookup of a presented token among active devices.
   * Returns the matching device or null.
   */
  authenticate(token: string | null | undefined): DeviceRecord | null {
    if (typeof token !== "string" || token.length === 0) return null;
    const presented = Buffer.from(hashToken(token), "hex");
    let match: DeviceRecord | null = null;
    for (const device of this.active()) {
      const stored = Buffer.from(device.tokenHash, "hex");
      // Compare every record so timing does not reveal which one matched.
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
        match = device;
      }
    }
    if (match) this.touch(match.id);
    return match ? { ...match } : null;
  }

  /** Record activity for a device; written at most once a minute per device. */
  private touch(id: string): void {
    const now = Date.now();
    const last = this.lastSeenWrites.get(id) ?? 0;
    if (now - last < LAST_SEEN_WRITE_INTERVAL_MS) return;
    this.lastSeenWrites.set(id, now);
    const devices = this.load();
    const device = devices.find((d) => d.id === id);
    if (!device) return;
    device.lastSeenAt = new Date(now).toISOString();
    try {
      this.save(devices);
    } catch (err) {
      console.warn("[devices] Failed to record last-seen time:", err);
    }
  }

  private load(): DeviceRecord[] {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.filePath).mtimeMs;
    } catch {
      this.cache = [];
      this.cacheMtimeMs = -1;
      return this.cache;
    }
    if (mtimeMs === this.cacheMtimeMs) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<DevicesFile>;
      const devices = Array.isArray(parsed.devices) ? parsed.devices : [];
      this.cache = devices.filter(
        (d): d is DeviceRecord =>
          typeof d === "object" && d !== null &&
          typeof (d as DeviceRecord).id === "string" &&
          typeof (d as DeviceRecord).tokenHash === "string",
      );
    } catch (err) {
      console.error(`[devices] Cannot read ${this.filePath}; treating as empty:`, err);
      this.cache = [];
    }
    this.cacheMtimeMs = mtimeMs;
    return this.cache;
  }

  private save(devices: DeviceRecord[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: DevicesFile = { version: 1, devices };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort (e.g. Windows).
    }
    this.cache = devices;
    this.cacheMtimeMs = statSync(this.filePath).mtimeMs;
  }
}
