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

/**
 * True when the request may proceed. With no key configured every request is
 * allowed (the bridge refuses to start without a key on a non-loopback host,
 * see index.ts), otherwise the presented key must match in constant time.
 */
export function isRequestAuthorized(
  req: Pick<IncomingMessage, "url" | "headers">,
  apiKey: string | null | undefined,
): boolean {
  if (!apiKey) return true;
  return secretsMatch(presentedApiKey(req), apiKey);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

/** True when `host` binds only the local machine. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}
