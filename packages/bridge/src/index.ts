import { createServer } from "node:http";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setupProxy } from "./proxy.js";
import { authenticateRequest, isAuthConfigured, isLoopbackHost, parseRequestUrl } from "./auth.js";
import { DeviceTokenStore } from "./device-tokens.js";
import { getSubagentHistory, listSubagentMeta } from "./subagent-history.js";
import {
  artifactViewPath,
  contentTypeFor,
  listSessionArtifacts,
  resolveArtifactFile,
  verifyArtifactToken,
} from "./artifact-preview.js";
import { createReadStream } from "node:fs";
import { BridgeWebSocketServer } from "./websocket.js";
import { ImageStore } from "./image-store.js";
import { MediaStore } from "./media-store.js";
import { UploadStore } from "./upload-store.js";
import { GalleryStore } from "./gallery-store.js";
import { printStartupInfo } from "./startup-info.js";
import { MdnsAdvertiser, shouldAdvertiseMdns } from "./mdns.js";
import { ProjectHistory } from "./project-history.js";
import { WorkspaceStore } from "./workspace-store.js";
import { getVersionInfo } from "./version.js";
import { fetchAllUsage } from "./usage.js";
import { runDoctor } from "./doctor.js";
import { DebugTraceStore } from "./debug-trace-store.js";
import { RecordingStore } from "./recording-store.js";
import { FirebaseAuthClient } from "./firebase-auth.js";
import { PromptHistoryBackupStore } from "./prompt-history-backup.js";
import {
  promptHistoryStoreFileForPort,
  PromptHistoryStore,
} from "./prompt-history-store.js";
import { parseAllowedDirectories } from "./path-utils.js";
import { parseBridgePort } from "./bridge-port.js";
import { listenForStartup } from "./server-listen.js";

function startupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function startServer() {
  const PORT = parseBridgePort();
  const HOST = process.env.BRIDGE_HOST ?? "0.0.0.0";
  const API_KEY = process.env.BRIDGE_API_KEY;
  // Named per-device tokens (ccpocket-bridge devices add|revoke|rotate),
  // accepted alongside the master key.
  const deviceTokens = new DeviceTokenStore();
  const authConfig = { apiKey: API_KEY, devices: deviceTokens };
  const MDNS_ENABLED = shouldAdvertiseMdns(
    process.platform,
    !!process.env.BRIDGE_DISABLE_MDNS,
  );

  // Unrestricted access requires the exact value "*".
  const ALLOWED_DIRS = parseAllowedDirectories(
    process.env.BRIDGE_ALLOWED_DIRS,
    process.platform,
    [homedir()],
  );

  console.log("[bridge] Starting ccpocket bridge server...");

  // A crash inside one request or SDK callback must not take every live
  // Claude session down with it. Log and keep serving; systemd restarts the
  // process only if it really dies.
  process.on("unhandledRejection", (reason) => {
    console.error("[bridge] Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[bridge] Uncaught exception:", err);
  });

  const activeDevices = deviceTokens.active().length;
  if (API_KEY || activeDevices > 0) {
    console.log(
      `[bridge] Authentication enabled (${API_KEY ? "master key" : "no master key"}, ${activeDevices} device token(s) in ${deviceTokens.filePath})`,
    );
  } else if (!isLoopbackHost(HOST) && process.env.BRIDGE_ALLOW_NO_AUTH !== "1") {
    // Without a key every client that can reach the port gets a shell on this
    // machine through Claude. Refuse to listen on a non-loopback address.
    console.error(
      `[bridge] Refusing to start: BRIDGE_API_KEY is not set while BRIDGE_HOST=${HOST} is reachable from other machines.\n` +
        "[bridge] Set BRIDGE_API_KEY (or BRIDGE_HOST=127.0.0.1 behind a reverse proxy). " +
        "To run without authentication anyway, set BRIDGE_ALLOW_NO_AUTH=1.",
    );
    process.exit(1);
  } else {
    console.warn("[bridge] WARNING: authentication is disabled");
  }
  void isAuthConfigured; // re-exported helper used by HTTP handlers below via authenticateRequest

  if (!MDNS_ENABLED) {
    console.log(
      process.platform === "darwin"
        ? "[bridge] mDNS advertisement disabled on macOS"
        : "[bridge] mDNS advertisement disabled",
    );
  }

  console.log(
    `[bridge] Allowed dirs: ${
      ALLOWED_DIRS.length > 0 ? ALLOWED_DIRS.join(", ") : "(unrestricted)"
    }`,
  );

  // Initialize Firebase Anonymous Auth for push notifications
  let firebaseAuth: FirebaseAuthClient | undefined;
  try {
    firebaseAuth = new FirebaseAuthClient();
    await firebaseAuth.initialize();
    console.log("[bridge] Push relay enabled (Firebase Anonymous Auth)");
  } catch (err) {
    console.warn("[bridge] Push relay disabled: Firebase auth failed:", err);
    firebaseAuth = undefined;
  }

  const imageStore = new ImageStore();
  const mediaStore = new MediaStore();
  const uploadStore = new UploadStore({
    maxReservedBytes:
      positiveEnvInt("BRIDGE_FILE_UPLOAD_MAX_RESERVED_MB", 2048) *
      1024 *
      1024,
    maxConcurrentReceives: positiveEnvInt(
      "BRIDGE_FILE_UPLOAD_MAX_CONCURRENT",
      4,
    ),
  });
  const galleryStore = new GalleryStore();
  const projectHistory = new ProjectHistory();
  const workspaceStore = new WorkspaceStore({
    ...(process.env.BRIDGE_WORKSPACE_FILE
      ? { filePath: process.env.BRIDGE_WORKSPACE_FILE }
      : {}),
  });
  const debugTraceStore = new DebugTraceStore();
  const RECORDING_ENABLED = !!process.env.BRIDGE_RECORDING;
  const recordingStore = RECORDING_ENABLED ? new RecordingStore() : undefined;
  const promptHistoryBackup = new PromptHistoryBackupStore();
  const promptHistoryStore = new PromptHistoryStore(
    promptHistoryStoreFileForPort(
      PORT,
      process.env.BRIDGE_PROMPT_HISTORY_FILE,
    ),
  );
  const mdns = MDNS_ENABLED ? new MdnsAdvertiser() : undefined;

  // Initialize stores (async)
  galleryStore.init().then(() => {
    console.log("[bridge] Gallery store initialized");
  }).catch((err) => {
    console.error("[bridge] Failed to initialize gallery store:", err);
  });

  projectHistory.init().then(() => {
    console.log("[bridge] Project history initialized");
  }).catch((err) => {
    console.error("[bridge] Failed to initialize project history:", err);
  });

  await workspaceStore.init().then(() => {
    console.log("[bridge] Workspace store initialized");
  }).catch((err) => {
    console.error("[bridge] Failed to initialize workspace store:", err);
  });

  debugTraceStore.init().then(() => {
    console.log("[bridge] Debug trace store initialized");
  }).catch((err) => {
    console.error("[bridge] Failed to initialize debug trace store:", err);
  });

  if (recordingStore) {
    recordingStore.init().then(() => {
      console.log("[bridge] Recording enabled");
    }).catch((err) => {
      console.error("[bridge] Failed to initialize recording store:", err);
    });
  }

  promptHistoryBackup.init().then(() => {
    console.log("[bridge] Prompt history backup store initialized");
  }).catch((err) => {
    console.error("[bridge] Failed to initialize prompt history backup store:", err);
  });

  await promptHistoryStore.init().then(() => {
    console.log("[bridge] Prompt history store initialized");
  }).catch((err) => {
    console.error("[bridge] Failed to initialize prompt history store:", err);
  });

  const startedAt = Date.now();
  let wsServer: BridgeWebSocketServer | null = null;

  const httpServer = createServer((req, res) => {
    const defaultBodyDeadline = setTimeout(
      () => req.destroy(),
      5 * 60 * 1000,
    );
    defaultBodyDeadline.unref();
    const clearDefaultBodyDeadline = () => {
      clearTimeout(defaultBodyDeadline);
    };
    req.once("end", clearDefaultBodyDeadline);
    req.once("close", clearDefaultBodyDeadline);

    // CORS headers for Flutter Web clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, HEAD, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Content-Length, Range");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range, X-File-SHA256, X-Received-Bytes",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = parseRequestUrl(req);
    if (!requestUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }
    const pathname = requestUrl.pathname;
    const authorized = authenticateRequest(req, authConfig).ok;
    const unauthorized = () => {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="ccpocket-bridge"',
      });
      res.end(JSON.stringify({ error: "Unauthorized" }));
    };

    // Health check endpoint: reachable without the key so clients can probe
    // the bridge, but session/client counters are only revealed to holders of it.
    if (pathname === "/health" && req.method === "GET") {
      const body = JSON.stringify({
        status: "ok",
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        ...(authorized
          ? {
              sessions: wsServer?.sessionCount ?? 0,
              clients: wsServer?.clientCount ?? 0,
              busy: wsServer?.busySessions ?? [],
            }
          : {}),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Version info endpoint
    if (pathname === "/version" && req.method === "GET") {
      const body = JSON.stringify(getVersionInfo(startedAt));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Everything below either spends the owner's provider quota, runs
    // commands, or reads/writes files: the API key is mandatory.
    const needsKey =
      pathname === "/api/subagent" ||
      pathname === "/api/subagents" ||
      pathname === "/api/artifacts" ||
      pathname === "/usage" ||
      pathname === "/doctor" ||
      // Gallery: list, upload and delete need the key. GET /api/gallery/:id
      // stays capability-based (unguessable UUID) so <img> loads keep working.
      pathname === "/api/gallery" ||
      pathname === "/api/gallery/upload" ||
      (pathname.startsWith("/api/gallery/") && req.method !== "GET");
    if (needsKey && !authorized) {
      unauthorized();
      return;
    }

    // Fork: subagent transcript viewer.
    // GET /api/subagent?session=<bridge or Claude session id>&toolUseId=...|agentId=...
    if (pathname === "/api/subagent" && req.method === "GET") {
      const ref = requestUrl.searchParams.get("session") ?? "";
      const toolUseId = requestUrl.searchParams.get("toolUseId") ?? undefined;
      const agentId = requestUrl.searchParams.get("agentId") ?? undefined;
      const afterRaw = requestUrl.searchParams.get("after");
      const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : undefined;
      const claudeSessionId = wsServer?.claudeSessionIdFor(ref) ?? ref;
      if (!claudeSessionId || (!toolUseId && !agentId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session and toolUseId or agentId are required" }));
        return;
      }
      getSubagentHistory(claudeSessionId, { toolUseId, agentId, after })
        .then((history) => {
          if (!history) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Subagent not found (it may not have started yet)" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(history));
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Fork: subagents of a session with their state (running/done/interrupted).
    // GET /api/subagents?session=<bridge or Claude session id>
    if (pathname === "/api/subagents" && req.method === "GET") {
      const ref = requestUrl.searchParams.get("session") ?? "";
      const claudeSessionId = wsServer?.claudeSessionIdFor(ref) ?? ref;
      if (!claudeSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session is required" }));
        return;
      }
      listSubagentMeta(claudeSessionId)
        .then((agents) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ agents }));
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Fork: Artifacts the session published, with signed view paths.
    // GET /api/artifacts?session=<bridge or Claude session id>
    if (pathname === "/api/artifacts" && req.method === "GET") {
      const ref = requestUrl.searchParams.get("session") ?? "";
      const claudeSessionId = wsServer?.claudeSessionIdFor(ref) ?? ref;
      if (!claudeSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session is required" }));
        return;
      }
      listSessionArtifacts(claudeSessionId)
        .then((artifacts) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              artifacts: artifacts.map(({ files, ...a }) => ({
                ...a,
                fileName: a.filePath.split("/").pop(),
                supportingFiles: Object.keys(files).length,
                ...(a.exists ? { viewPath: artifactViewPath(claudeSessionId, { files, ...a }) } : {}),
              })),
            }),
          );
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Fork: the artifact files themselves. The signed token in the path
    // replaces the API key so WebView sub-resource loads work; the page is
    // served sandboxed (opaque origin) so its scripts cannot use the bridge.
    // GET /artifact/<token>/<published path>
    if (pathname.startsWith("/artifact/") && (req.method === "GET" || req.method === "HEAD")) {
      const [, , token = "", ...restParts] = pathname.split("/");
      const grant = verifyArtifactToken(token);
      const notFound = (code: number, message: string) => {
        res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(message);
      };
      if (!grant) {
        notFound(403, "This preview link has expired. Open the artifact again from the app.");
        return;
      }
      let rest: string;
      try {
        rest = restParts.map((p) => decodeURIComponent(p)).join("/");
      } catch {
        notFound(400, "Bad path");
        return;
      }
      listSessionArtifacts(grant.sessionId)
        .then(async (artifacts) => {
          const artifact = artifacts.find((a) => a.toolUseIds.includes(grant.toolUseId));
          const file = artifact?.exists ? await resolveArtifactFile(artifact, rest) : null;
          if (!file) {
            notFound(404, "Not found");
            return;
          }
          const stream = createReadStream(file);
          stream.once("error", () => notFound(404, "Not found"));
          stream.once("open", () => {
            res.writeHead(200, {
              "Content-Type": contentTypeFor(file),
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads",
              "Referrer-Policy": "no-referrer",
            });
            if (req.method === "HEAD") {
              stream.destroy();
              res.end();
              return;
            }
            stream.pipe(res);
          });
        })
        .catch(() => notFound(500, "Error"));
      return;
    }

    // Usage endpoint
    if (pathname === "/usage" && req.method === "GET") {
      fetchAllUsage()
        .then((providers) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ providers }));
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Doctor endpoint
    if (pathname === "/doctor" && req.method === "GET") {
      runDoctor()
        .then((report) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(report));
        })
        .catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }

    // Serve images via ImageStore (in-memory, session-scoped)
    if (imageStore.handleRequest(req, res)) return;

    // Stream local media registered by an authenticated read_file request.
    if (mediaStore.handleRequest(req, res)) return;

    // Receive files through short-lived capabilities prepared over WebSocket.
    if (uploadStore.handleRequest(req, res, clearDefaultBodyDeadline)) return;

    // Serve gallery images via GalleryStore (disk-persistent)
    if (galleryStore.handleRequest(req, res)) return;

    // Upload images via POST /api/gallery/upload
    if (galleryStore.handleUploadRequest(req, res, (meta) => {
      if (wsServer) {
        const info = galleryStore.metaToInfo(meta);
        wsServer.broadcastGalleryNewImage(info);
      }
    })) return;

    // Default 404 for unknown HTTP requests
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
  // UploadStore applies its own one-hour total and one-minute idle deadlines.
  // Other HTTP requests retain a five-minute total deadline above.
  httpServer.requestTimeout = 60 * 60 * 1000;

  wsServer = new BridgeWebSocketServer({
    server: httpServer,
    apiKey: API_KEY,
    deviceTokens,
    allowedDirs: ALLOWED_DIRS,
    fileDownloadAllowAllPaths: process.env.BRIDGE_FILE_DOWNLOAD_ALLOW_ALL_PATHS === "1",
    imageStore,
    mediaStore,
    uploadStore,
    galleryStore,
    projectHistory,
    workspaceStore,
    debugTraceStore,
    recordingStore,
    firebaseAuth,
    promptHistoryBackup,
    promptHistoryStore,
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[bridge] Shutting down gracefully...");
    mdns?.stop();
    wsServer?.close();
    await uploadStore.dispose();
    httpServer.close();
    process.exit(0);
  }

  try {
    await listenForStartup(httpServer, PORT, HOST);
  } catch (err) {
    wsServer.close();
    httpServer.close();
    throw err;
  }

  console.log(
    `[bridge] Ready. Listening on http://${HOST}:${PORT} (HTTP + WebSocket)`,
  );
  mdns?.start(PORT, API_KEY);
  printStartupInfo(PORT, HOST, API_KEY);

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// Auto-start when executed directly (node dist/index.js, tsx src/index.ts)
const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  setupProxy();
  startServer().catch((err) => {
    console.error(`[bridge] Failed to start: ${startupErrorMessage(err)}`);
    process.exit(1);
  });
}
