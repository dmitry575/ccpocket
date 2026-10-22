#!/usr/bin/env node
import { setupProxy } from "./proxy.js";
import { platform } from "node:os";
import { startServer } from "./index.js";
import { getPackageVersion } from "./version.js";
import { hasFlag, parseCliArgs, parseFlag } from "./cli-args.js";

function startupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const args = process.argv.slice(2);
const parsed = parseCliArgs(args);

function printHelp(): void {
  console.log(`ccpocket-bridge

Usage:
  ccpocket-bridge [options]
  ccpocket-bridge <command> [options]

Commands:
  help                  Show this help
  version               Show the installed Bridge version
  doctor [--json]       Check the local Bridge environment
  setup [options]       Register Bridge as a macOS launchd or Linux systemd service
  devices [action]      Per-device access tokens (fork): list | add <name> |
                        revoke <id> | rotate <id> | remove <id>. Stored as hashes
                        in ~/.ccpocket/devices.json; accepted alongside BRIDGE_API_KEY

Options:
  -h, --help            Show this help
  -v, --version         Show the installed Bridge version
      --port <port>     WebSocket port (default: 8765)
      --host <host>     Bind address (default: 0.0.0.0)
      --api-key <key>   Enable API key authentication
      --public-ws-url <url>
                         Public ws:// or wss:// URL used in QR codes
      --no-mdns         Disable mDNS auto-discovery advertisement
      --codex-app-server-mode <mode>
                         Codex app-server mode: private, managed, or external
      --codex-shared-app-server-url <url>
                         Shared Codex app-server ws:// URL

Setup options:
      --uninstall       Remove the registered service
      setup persists --port, --host, --api-key, --public-ws-url,
      --no-mdns, Codex app-server options, BRIDGE_ALLOWED_DIRS, and
      BRIDGE_ALLOW_CLAUDE_OAUTH, BRIDGE_CODEX_ASSIST_MODEL, and
      BRIDGE_CODEX_ASSIST_REASONING_EFFORT

Configuration can also be provided with BRIDGE_PORT, BRIDGE_HOST,
BRIDGE_API_KEY, BRIDGE_ALLOWED_DIRS, BRIDGE_PUBLIC_WS_URL, and
BRIDGE_DISABLE_MDNS. Claude subscription authentication can be explicitly
enabled with BRIDGE_ALLOW_CLAUDE_OAUTH=1. Codex app-server configuration can be provided with
BRIDGE_CODEX_APP_SERVER_MODE and BRIDGE_CODEX_SHARED_APP_SERVER_URL.
Codex assist calls can be configured with BRIDGE_CODEX_ASSIST_MODEL and
BRIDGE_CODEX_ASSIST_REASONING_EFFORT.`);
}

if (parsed.helpRequested) {
  printHelp();
} else if (parsed.versionRequested) {
  console.log(`ccpocket-bridge ${getPackageVersion()}`);
} else if (parsed.command === "doctor") {
  // Configure global fetch proxy before any network calls
  setupProxy();
  // Doctor subcommand: check environment health
  const jsonOutput = hasFlag(parsed, "json");
  import("./doctor.js")
    .then(({ runDoctor, printReport }) =>
      runDoctor().then((report) => {
        if (jsonOutput) {
          console.log(JSON.stringify(report));
        } else {
          printReport(report);
        }
        process.exit(report.allRequiredPassed ? 0 : 1);
      }),
    )
    .catch((err) => {
      console.error("Doctor failed:", err);
      process.exit(1);
    });
} else if (parsed.command === "setup") {
  // Service setup subcommand (platform-specific)
  const opts = {
    port: parseFlag(parsed, "port"),
    host: parseFlag(parsed, "host"),
    apiKey: parseFlag(parsed, "api-key"),
    publicWsUrl: parseFlag(parsed, "public-ws-url"),
    disableMdns: hasFlag(parsed, "no-mdns"),
    codexAppServerMode: parseFlag(parsed, "codex-app-server-mode"),
    codexSharedAppServerUrl: parseFlag(parsed, "codex-shared-app-server-url"),
    codexAppServerPort: parseFlag(parsed, "codex-app-server-port"),
    codexAppServerUrl: parseFlag(parsed, "codex-app-server-url"),
  };

  if (platform() === "darwin") {
    import("./setup-launchd.js")
      .then(({ setupLaunchd, uninstallLaunchd }) => {
        hasFlag(parsed, "uninstall")
          ? uninstallLaunchd()
          : setupLaunchd(opts);
      })
      .catch((err) => {
        console.error("Setup failed:", err);
        process.exit(1);
      });
  } else if (platform() === "linux") {
    import("./setup-systemd.js")
      .then(({ setupSystemd, uninstallSystemd }) => {
        hasFlag(parsed, "uninstall")
          ? uninstallSystemd()
          : setupSystemd(opts);
      })
      .catch((err) => {
        console.error("Setup failed:", err);
        process.exit(1);
      });
  } else {
    console.error(
      `ERROR: 'setup' is not supported on ${platform()}. Supported: macOS (launchd), Linux (systemd).`,
    );
    process.exit(1);
  }
} else if (parsed.command === "devices") {
  // Per-device access tokens: list | add <name> | revoke <id> | rotate <id> | remove <id>
  import("./device-tokens.js")
    .then(async ({ DeviceTokenStore }) => {
      const store = new DeviceTokenStore();
      const [, action, arg] = parsed.positionals;
      const printIssued = async (issued: { device: { id: string; name: string }; token: string }) => {
        console.log(`Device "${issued.device.name}" (id ${issued.device.id})`);
        console.log(`Token (shown once): ${issued.token}`);
        const wsUrl = parseFlag(parsed, "public-ws-url") ?? process.env.BRIDGE_PUBLIC_WS_URL;
        if (wsUrl) {
          const { buildConnectionUrl } = await import("./startup-info.js");
          const deepLink = buildConnectionUrl(wsUrl, issued.token);
          console.log(`Deep link: ${deepLink}`);
          try {
            const QRCode = (await import("qrcode")).default;
            console.log(await QRCode.toString(deepLink, { type: "terminal", small: true }));
          } catch {
            // QR rendering is optional.
          }
        } else {
          console.log("(set BRIDGE_PUBLIC_WS_URL or pass --public-ws-url to also print a deep link / QR)");
        }
      };
      switch (action) {
        case undefined:
        case "list": {
          const devices = store.list();
          if (devices.length === 0) {
            console.log(`No devices in ${store.filePath}. Add one: ccpocket-bridge devices add "<name>"`);
            break;
          }
          for (const d of devices) {
            const state = d.revokedAt ? `revoked ${d.revokedAt}` : "active";
            console.log(`${d.id}  ${d.name.padEnd(20)}  ${state}  created ${d.createdAt}  last seen ${d.lastSeenAt ?? "never"}`);
          }
          break;
        }
        case "add":
          if (!arg) throw new Error('usage: ccpocket-bridge devices add "<name>"');
          await printIssued(store.add(arg));
          break;
        case "rotate": {
          if (!arg) throw new Error("usage: ccpocket-bridge devices rotate <id>");
          const issued = store.rotate(arg);
          if (!issued) throw new Error(`No active device with id ${arg}`);
          await printIssued(issued);
          break;
        }
        case "revoke":
          if (!arg) throw new Error("usage: ccpocket-bridge devices revoke <id>");
          if (!store.revoke(arg)) throw new Error(`No active device with id ${arg}`);
          console.log(`Device ${arg} revoked; its token no longer works.`);
          break;
        case "remove":
          if (!arg) throw new Error("usage: ccpocket-bridge devices remove <id>");
          if (!store.remove(arg)) throw new Error(`No device with id ${arg}`);
          console.log(`Device ${arg} removed.`);
          break;
        default:
          throw new Error(`Unknown devices action "${action}". Use list | add <name> | revoke <id> | rotate <id> | remove <id>.`);
      }
    })
    .catch((err) => {
      console.error("devices failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else {
  // Configure global fetch proxy before any network calls
  setupProxy();
  // Server mode: set env vars from CLI flags, then start
  const port = parseFlag(parsed, "port");
  const host = parseFlag(parsed, "host");
  const apiKey = parseFlag(parsed, "api-key");
  const publicWsUrl = parseFlag(parsed, "public-ws-url");
  const codexAppServerMode = parseFlag(parsed, "codex-app-server-mode");
  const codexSharedAppServerUrl = parseFlag(
    parsed,
    "codex-shared-app-server-url",
  );
  const codexAppServerPort = parseFlag(parsed, "codex-app-server-port");
  const codexAppServerUrl = parseFlag(parsed, "codex-app-server-url");

  if (port !== undefined) process.env.BRIDGE_PORT = port;
  if (host) process.env.BRIDGE_HOST = host;
  if (apiKey) process.env.BRIDGE_API_KEY = apiKey;
  if (publicWsUrl) process.env.BRIDGE_PUBLIC_WS_URL = publicWsUrl;
  if (codexAppServerMode) {
    process.env.BRIDGE_CODEX_APP_SERVER_MODE = codexAppServerMode;
  }
  if (codexAppServerPort) {
    process.env.BRIDGE_CODEX_APP_SERVER_PORT = codexAppServerPort;
  }
  if (codexSharedAppServerUrl) {
    process.env.BRIDGE_CODEX_SHARED_APP_SERVER_URL = codexSharedAppServerUrl;
  } else if (codexAppServerUrl) {
    process.env.BRIDGE_CODEX_APP_SERVER_URL = codexAppServerUrl;
  }
  if (hasFlag(parsed, "no-mdns")) process.env.BRIDGE_DISABLE_MDNS = "1";

  startServer().catch((err) => {
    console.error(`[bridge] Failed to start: ${startupErrorMessage(err)}`);
    process.exit(1);
  });
}
