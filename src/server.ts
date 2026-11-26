import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRuntime,
  createScoutThinHttpHandler,
  runtimeUrl,
  scanLocalFeedSessions,
  sendJson,
} from "scout-app/thin-server";
// @ts-expect-error plain ESM server module
import { handle as handleStudioApi } from "../server/api.mjs";

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_IP = /^(?:127\.\d+\.\d+\.\d+|::1|\[::1\]|::ffff:127\.\d+\.\d+\.\d+)$/i;

function headerStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(",") : typeof v === "string" ? v : "";
}

function truthyHdr(v: string | string[] | undefined): boolean {
  const s = headerStr(v).trim().toLowerCase();
  return Boolean(s && s !== "0" && s !== "false" && s !== "no");
}

function isLocalRequest(req: http.IncomingMessage): boolean {
  const h = req.headers;
  const host = headerStr(h.host);
  if (!LOCAL.test(host)) return false;
  const remoteAddr = req.socket?.remoteAddress;
  if (remoteAddr && !LOOPBACK_IP.test(remoteAddr)) return false;
  if (headerStr(h.forwarded).trim() || headerStr(h["x-openscout-forwarded-node-id"]).trim()) return false;
  const xff = headerStr(h["x-forwarded-for"]).trim();
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim());
    if (!hops.length || hops.some((ip) => !ip || !LOOPBACK_IP.test(ip))) return false;
  }
  const realIp = headerStr(h["x-real-ip"]).trim();
  if (realIp && !LOOPBACK_IP.test(realIp)) return false;
  const transport = headerStr(h["x-openscout-transport"]).trim().toLowerCase();
  if (transport && transport !== "local" && transport !== "loopback") return false;
  if (truthyHdr(h["x-openscout-peer"]) || truthyHdr(h["x-openscout-guest"]) || truthyHdr(h["x-openscout-scoped"])) return false;
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && headerStr(h["sec-fetch-site"]).trim().toLowerCase() === "cross-site") {
    return false;
  }
  const origin = headerStr(h.origin).trim();
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
};

const THIN_SHARED_PATHS = new Set([
  "/api/host-status",
  "/api/setup",
  "/api/recent-sessions",
  "/api/session-context",
  "/api/messages",
  "/v1/events/stream",
  "/v1/tail/events",
]);

function isThinSharedRoute(pathname: string): boolean {
  return THIN_SHARED_PATHS.has(pathname) || pathname.startsWith("/api/session-ref/");
}

const handleThinRoutes = createScoutThinHttpHandler({
  packageName: "@openscout/studio",
  product: "Studio",
  apiHandler: async (req, res, { pathname }) => {
    if (req.method === "GET" && pathname === "/api/host-status") {
      const base = runtimeUrl();
      const runtimeUp = await checkRuntime(base);
      const localSessions = scanLocalFeedSessions({ maxPerHarness: 15, limit: 30 }).length;
      sendJson(res, 200, { runtimeUp, runtimeUrl: base, localSessions });
      return true;
    }
    return false;
  },
});

export function createStudioServer() {
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");

    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (isThinSharedRoute(url.pathname)) {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: "local only" });
        return;
      }
      if (await handleThinRoutes(req, res)) return;
    }

    if (await handleStudioApi(req, res)) return;

    const u = url.pathname;
    const rel = path.normalize(u).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    let file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, "index.html");
    }
    if (!fs.existsSync(file)) {
      sendJson(res, 503, { error: "dist/index.html is missing. Run npm run build first." });
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    });
    fs.createReadStream(file).pipe(res);
  });
}

export function serve(port: number, host = "127.0.0.1"): Promise<http.Server> {
  const server = createStudioServer();
  return new Promise((ok, no) => server.once("error", no).listen(port, host, () => ok(server)));
}
