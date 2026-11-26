// Finding, inspecting and stopping the Scout Studio that runs on this Mac, or starting one when none does.
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_PORT = Number(process.env.SCOUT_STUDIO_PORT) || 4801;
export const firstPort = () => Number(process.env.SCOUT_STUDIO_PORT) || 4801;

function findRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export const ROOT = findRoot();
const BIN = path.join(ROOT, "bin", "scout-studio.mjs");

let cachedBuild = null;

/** Version and content fingerprint of this Studio checkout or package. */
export function buildInfo() {
  if (cachedBuild) return cachedBuild;
  let version = "0.0.0";
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || version;
  } catch {}
  const hash = crypto.createHash("sha256").update(version);
  for (const rel of ["bin/scout-studio.mjs", "server/serve.mjs", "server/api.mjs", "dist/index.html", "dist/thin-server.mjs"]) {
    try { hash.update(fs.readFileSync(path.join(ROOT, rel))); } catch {}
  }
  cachedBuild = { version, buildId: hash.digest("hex").slice(0, 12) };
  return cachedBuild;
}

/** Is Scout Studio answering on this port? */
export async function ours(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/notes`, { signal: AbortSignal.timeout(1500) });
    return res.ok && Array.isArray((await res.json()).notes);
  } catch { return false; }
}

/** Status of Scout Studio on this port, or null if nothing (or another app) answers. */
export async function statusAt(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const json = await res.json();
      if (json?.product === "scout-studio") {
        return { ...json, port, url: `http://localhost:${port}`, legacy: false };
      }
    }
  } catch {}
  if (await ours(port)) {
    return {
      ok: true,
      product: "scout-studio",
      port,
      url: `http://localhost:${port}`,
      legacy: true,
      version: null,
      buildId: null,
      pid: null,
      startedAt: null,
    };
  }
  return null;
}

/** All running Scout Studio instances across the local port range. */
export async function instances(first = firstPort(), count = 10) {
  const ports = Array.from({ length: count }, (_, i) => first + i);
  const found = await Promise.all(ports.map((p) => statusAt(p)));
  return found.filter(Boolean);
}

function looksLikeStudioCmd(pid) {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 1500 }).trim();
    return /scout-studio|\/studio(\/|\b)|thin-server\.mjs/.test(cmd);
  } catch { return false; }
}

function listeningStudioPids(port) {
  try {
    const out = execFileSync("lsof", ["-b", "-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 2000 });
    return out.split(/\s+/).map(Number).filter((pid) => pid > 1 && pid !== process.pid && looksLikeStudioCmd(pid));
  } catch { return []; }
}

async function waitForPortFree(port, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await statusAt(port))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !(await statusAt(port));
}

/** Stop a running Scout Studio server (including older servers without /api/stop). */
export async function stopInstance(target) {
  const info = typeof target === "number" ? await statusAt(target) : target;
  if (!info) return { stopped: false };
  let pid = info.pid || null;
  if (!info.legacy) {
    try {
      const res = await fetch(`http://localhost:${info.port}/api/stop`, {
        method: "POST",
        headers: { "x-scout-studio": "cli" },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        if (json.pid) pid = json.pid;
        if (await waitForPortFree(info.port, 2500)) {
          return { stopped: true, port: info.port, url: info.url, pid };
        }
      }
    } catch {}
  }
  const pids = pid && pid !== process.pid && looksLikeStudioCmd(pid) ? [pid] : listeningStudioPids(info.port);
  for (const p of pids) {
    try { process.kill(p, "SIGTERM"); pid = p; } catch {}
  }
  const freed = await waitForPortFree(info.port, 2500);
  return { stopped: freed, port: info.port, url: info.url, pid };
}

/** The port Scout Studio answers on, or 0. */
export async function running(first = firstPort()) {
  for (let p = first; p < first + 10; p++) if (await ours(p)) return p;
  return 0;
}

/** The base URL of a running Scout Studio, starting one in the background if it must. */
export async function ensure() {
  let port = await running();
  if (port) return `http://localhost:${port}`;
  const child = spawn(process.execPath, [BIN, "--no-open", "--no-setup"], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40 && !port; i++) { await new Promise((r) => setTimeout(r, 250)); port = await running(); }
  if (!port) throw new Error("Scout Studio didn't start. Run `npx github:openscout-app/studio` to see why.");
  return `http://localhost:${port}`;
}

/** Call the running Scout Studio's API. Throws with the server's reason. */
export async function call(base, method, p, body) {
  const res = await fetch(base + p, {
    method, headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60e3),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}
