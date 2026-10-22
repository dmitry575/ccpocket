import { describe, expect, it } from "vitest";
import {
  isLoopbackHost,
  isRequestAuthorized,
  parseRequestUrl,
  presentedApiKey,
  secretsMatch,
} from "./auth.js";

describe("secretsMatch", () => {
  it("accepts the exact key and rejects everything else", () => {
    expect(secretsMatch("abc123", "abc123")).toBe(true);
    expect(secretsMatch("abc124", "abc123")).toBe(false);
    expect(secretsMatch("abc1234", "abc123")).toBe(false);
    expect(secretsMatch("", "abc123")).toBe(false);
    expect(secretsMatch(null, "abc123")).toBe(false);
    expect(secretsMatch(undefined, "abc123")).toBe(false);
  });
});

describe("parseRequestUrl", () => {
  it("parses a path with query regardless of the Host header", () => {
    const url = parseRequestUrl({ url: "/?token=x&y=1" });
    expect(url?.pathname).toBe("/");
    expect(url?.searchParams.get("token")).toBe("x");
  });

  it("returns null instead of throwing on unparseable input", () => {
    expect(parseRequestUrl({ url: "http://[::1" })).toBeNull();
  });
});

describe("presentedApiKey", () => {
  it("prefers the Authorization bearer header", () => {
    expect(
      presentedApiKey({ url: "/?token=query", headers: { authorization: "Bearer header" } }),
    ).toBe("header");
  });

  it("falls back to the token query parameter", () => {
    expect(presentedApiKey({ url: "/?token=query", headers: {} })).toBe("query");
    expect(presentedApiKey({ url: "/api/gallery", headers: {} })).toBeNull();
  });

  it("ignores non-bearer Authorization schemes", () => {
    expect(presentedApiKey({ url: "/?token=q", headers: { authorization: "Basic abc" } })).toBe("q");
  });
});

describe("isRequestAuthorized", () => {
  it("allows everything when no key is configured", () => {
    expect(isRequestAuthorized({ url: "/", headers: {} }, undefined)).toBe(true);
    expect(isRequestAuthorized({ url: "/", headers: {} }, "")).toBe(true);
  });

  it("requires a matching key via header or query when configured", () => {
    expect(isRequestAuthorized({ url: "/", headers: {} }, "k")).toBe(false);
    expect(isRequestAuthorized({ url: "/?token=k", headers: {} }, "k")).toBe(true);
    expect(isRequestAuthorized({ url: "/", headers: { authorization: "Bearer k" } }, "k")).toBe(true);
    expect(isRequestAuthorized({ url: "/?token=wrong", headers: {} }, "k")).toBe(false);
    // A hostile Host header must not throw; parsing uses a constant base.
    expect(
      isRequestAuthorized({ url: "/?token=k", headers: { host: "a b", authorization: undefined } }, "k"),
    ).toBe(true);
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback addresses only", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});
