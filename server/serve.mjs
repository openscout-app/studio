import { DIST, createStudioServer as createBaseServer } from "../dist/thin-server.mjs";
import { CLAUDE_PROJECTS, HOME } from "./paths.mjs";
import { CODEX_SESSIONS } from "./codex.mjs";
import { buildInfo } from "./local.mjs";

export { DIST };

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const STARTED_AT = Date.now();

function isLocal(req) {
  const host = req.headers.host || "";
  if (!LOCAL.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

export function createStudioServer() {
  const base = createBaseServer();
  const handlers = base.listeners("request");
  base.removeAllListeners("request");
  base.on("request", (req, res) => {
    req.studioServer = base;
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/api/status" && req.method === "GET") {
      if (!isLocal(req)) return sendJson(res, 403, { error: "local only" });
      const { version, buildId } = buildInfo();
      return sendJson(res, 200, {
        ok: true,
        product: "scout-studio",
        version,
        buildId,
        pid: process.pid,
        startedAt: STARTED_AT,
        uptimeMs: Date.now() - STARTED_AT,
        home: HOME,
        claudeProjects: CLAUDE_PROJECTS,
        codexSessions: CODEX_SESSIONS,
      });
    }
    if (url.pathname === "/api/stop" && req.method === "POST") {
      if (!isLocal(req)) return sendJson(res, 403, { error: "local only" });
      if (req.headers.origin || req.headers["x-scout-studio"] !== "cli") {
        return sendJson(res, 403, { error: "cli only" });
      }
      res.once("finish", () => {
        base.close();
        setImmediate(() => base.closeAllConnections?.());
      });
      return sendJson(res, 200, { ok: true, pid: process.pid }, { connection: "close" });
    }
    for (const fn of handlers) fn.call(base, req, res);
  });
  return base;
}

export function serve(port, host = "127.0.0.1") {
  const server = createStudioServer();
  return new Promise((ok, no) => server.once("error", no).listen(port, host, () => ok(server)));
}
