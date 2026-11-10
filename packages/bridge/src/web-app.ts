import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Fork: serve the Flutter web build of the app at `/app/` from the bridge,
 * so it opens in a browser on the same https origin (and certificate) as the
 * bridge and can be added to the iPhone home screen as a web app.
 *
 * The build is a release asset (CC-Pocket-web-*.tar.gz) unpacked by
 * deploy/install-web.sh into BRIDGE_WEB_APP_DIR (~/.ccpocket/web-app).
 * It holds no secrets; the app asks for the bridge URL and key as usual.
 */
export const WEB_APP_PREFIX = "/app";

export function webAppDir(): string {
  return process.env.BRIDGE_WEB_APP_DIR || join(homedir(), ".ccpocket", "web-app");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function webAppContentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Files whose name never changes between builds: the browser must revalidate
 * them, or an installed home-screen app keeps running an old build.
 */
export function isEntryFile(rel: string): boolean {
  return (
    rel === "index.html" ||
    rel === "flutter_service_worker.js" ||
    rel === "flutter_bootstrap.js" ||
    rel === "version.json" ||
    rel === "manifest.json" ||
    rel === "main.dart.js" ||
    rel === "main.dart.wasm" ||
    rel === "main.dart.mjs"
  );
}

/**
 * Local file for a request path under {@link WEB_APP_PREFIX}, or null. The
 * app is a single page: unknown paths without an extension get index.html.
 * Traversal and symlinks out of the build folder are refused.
 */
export async function resolveWebAppFile(
  dir: string,
  pathname: string,
): Promise<{ file: string; rel: string } | null> {
  if (pathname !== WEB_APP_PREFIX && !pathname.startsWith(`${WEB_APP_PREFIX}/`)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice(WEB_APP_PREFIX.length)).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (rel.split("/").some((part) => part === ".." || part.startsWith("."))) return null;
  if (rel === "") rel = "index.html";

  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    return null;
  }
  const tryFile = async (r: string): Promise<{ file: string; rel: string } | null> => {
    try {
      const real = await realpath(resolve(root, r));
      const inside = relative(root, real);
      if (inside.startsWith("..") || isAbsolute(inside)) return null;
      return (await stat(real)).isFile() ? { file: real, rel: r } : null;
    } catch {
      return null;
    }
  };
  return (await tryFile(rel)) ?? (extname(rel) === "" ? tryFile("index.html") : null);
}
