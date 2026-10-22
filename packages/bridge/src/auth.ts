import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Constant-time comparison of a presented secret against the configured key.
 * Both sides are hashed first so the comparison length never depends on the
 * candidate and `timingSafeEqual` never throws on length mismatch.
 */
export function secretsMatch(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Parse `req.url` against a constant base. A hostile `Host` header must never
 * be able to make URL parsing throw inside a request handler.
 */
export function parseRequestUrl(req: Pick<IncomingMessage, "url">): URL | null {
  try {
    return new URL(req.url ?? "/", "http://bridge.invalid");
  } catch {
    return null;
  }
}

/**
 * Extract the presented API key from an HTTP(S)/WebSocket upgrade request:
 * `Authorization: Bearer <key>` first, then the `?token=` query parameter
 * (kept for the WebSocket handshake and for image URLs that cannot set headers).
 */
export function presentedApiKey(req: Pick<IncomingMessage, "url" | "headers">): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (match) return match[1];
  }
  const url = parseRequestUrl(req);
  return url?.searchParams.get("token") ?? null;
}

/** Anything that can resolve a presented token to a named device. */
export interface DeviceAuthenticator {
  authenticate(token: string | null | undefined): { id: string; name: string } | null;
  /** True when at least one active device token exists. */
  active(): unknown[];
}

export interface AuthConfig {
  apiKey?: string | null;
  devices?: DeviceAuthenticator | null;
}

export type AuthResult =
  | { ok: true; via: "open" }
  | { ok: true; via: "master" }
  | { ok: true; via: "device"; device: { id: string; name: string } }
  | { ok: false };

/** True when some credential is configured (master key or any active device). */
export function isAuthConfigured(config: AuthConfig): boolean {
  return Boolean(config.apiKey) || Boolean(config.devices && config.devices.active().length > 0);
}

/**
 * Authenticate a request against the master key and the device tokens.
 * With nothing configured every request is allowed (the bridge refuses to
 * start that way on a non-loopback host, see index.ts). All comparisons are
 * constant time.
 */
export function authenticateRequest(
  req: Pick<IncomingMessage, "url" | "headers">,
  config: AuthConfig,
): AuthResult {
  if (!isAuthConfigured(config)) return { ok: true, via: "open" };
  const presented = presentedApiKey(req);
  const masterOk = config.apiKey ? secretsMatch(presented, config.apiKey) : false;
  const device = config.devices ? config.devices.authenticate(presented) : null;
  if (masterOk) return { ok: true, via: "master" };
  if (device) return { ok: true, via: "device", device: { id: device.id, name: device.name } };
  return { ok: false };
}

/**
 * True when the request may proceed. Thin wrapper over
 * {@link authenticateRequest} for callers that only have the master key.
 */
export function isRequestAuthorized(
  req: Pick<IncomingMessage, "url" | "headers">,
  apiKey: string | null | undefined,
): boolean {
  return authenticateRequest(req, { apiKey }).ok;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/** True when `host` binds only the local machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}
