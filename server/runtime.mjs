// Scout's runtime, underneath Studio. Studio reads from it and never writes a record itself:
// observed surfaces come from /v1/observed-surfaces (falling back to /v1/shows when the runtime is
// older), session titles from /v1/tail/discover, and live show events from a single host-wide
// /v1/shows/events stream (falling back to per-repository streams only on 400).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IMG } from "./paths.mjs";
import { imageSize } from "./image-size.mjs";

/** Where the runtime answers, found the way Scout's own tools find it: an address in the
 * environment first, then the host's Scout config, then the default port. */
export function runtimeUrl() {
  const env = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (env) return env.replace(/\/$/, "");
  try {
    const home = process.env.OPENSCOUT_HOME || path.join(os.homedir(), ".openscout");
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    const port = Number(c?.ports?.broker);
    if (Number.isInteger(port) && port > 0) {
      const host = !c.host || c.host === "0.0.0.0" || c.host === "::" ? "127.0.0.1" : c.host;
      return `http://${host}:${port}`;
    }
  } catch {}
  return "http://127.0.0.1:43110";
}

const MD = /\.(md|markdown|mdx)$/i;
const HTML = /\.html?$/i;

/** How Studio draws a show or surface: by explicit kind or file name first, then mediaType. */
export function viewOf(show) {
  const p = show.sourcePath || show.path || "";
  if (show.kind === "image" || show.kind === "screen" || show.kind === "svg" || show.mediaType === "image/svg+xml") return "image";
  if (show.kind === "video") return "video";
  if (show.kind === "markdown" || MD.test(p) || show.mediaType === "text/markdown") return "markdown";
  if (show.kind === "html" || HTML.test(p) || show.mediaType === "text/html") return "html";
  if (show.kind === "pdf" || show.mediaType === "application/pdf") return "pdf";
  if (/^text\/|json|xml|yaml|toml/.test(show.mediaType || "")) return "text";
  return "file";
}

export function extFromMedia(mediaType = "", sourcePath = "") {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/png") return "png";
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "jpg";
  if (ext === ".webp") return "webp";
  if (ext === ".gif") return "gif";
  return "png";
}

export function surfaceScreenHash(item) {
  const hex = typeof item.sha256 === "string" && /^[0-9a-f]{16,}/i.test(item.sha256)
    ? item.sha256.toLowerCase()
    : crypto.createHash("sha256").update(String(item.id || item.sourcePath || "")).digest("hex");
  return hex.slice(0, 16);
}

/** Canonical `ScoutSurfaceSubject` derivation matching `scout.observed-surfaces/v1`. */
export function deriveSurfaceSubject(input = {}) {
  if (input.url) {
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
        const label = `${parsed.host}${normalizedPath}`;
        return { key: `page:${label}`, kind: "page", label };
      }
    } catch {}
  }
  if (input.windowId !== undefined && input.windowId !== null && String(input.windowId).length > 0) {
    return { key: `window:${input.windowId}`, kind: "window", label: `Window ${input.windowId}` };
  }
  const rawPath = input.sourcePath || "untitled";
  const projectRoot = input.projectRoot || "";
  const rel = path.isAbsolute(rawPath) && projectRoot && rawPath.startsWith(projectRoot + path.sep)
    ? path.relative(projectRoot, rawPath).split(path.sep).join("/")
    : path.basename(rawPath);
  if (input.kind === "screen") {
    const dir = path.posix.dirname(rel);
    const ext = path.posix.extname(rel);
    const rawStem = path.posix.basename(rel, ext);
    const cleanStem = rawStem.replace(/([-_. ]?(?:before|after|old|new|v?\d+))+$/i, "") || rawStem;
    const normalized = dir === "." ? cleanStem : `${dir}/${cleanStem}`;
    return { key: `file:${normalized}`, kind: "file", label: normalized };
  }
  return { key: `file:${rel}`, kind: "file", label: rel };
}

let activeUrl = "";
const listed = new Map();         // "*" or projectRoot -> { at, shows }
const known = new Map();          // show id -> ScoutShow
const observedShows = new Map();  // surface id (or showId) -> normalized show view record
const surfaceScreens = new Map(); // 16-hex hash -> { id, showId, ext, mediaType }
const observedCache = new Map();  // windowMs -> { at, result }
const observedInflight = new Map();

let observedSupport = { state: "unknown", at: 0 }; // "unknown" | "supported" | "unsupported"
let globalShowsSupport = "unknown";                // "unknown" | "supported" | "unsupported"
let globalEventsSupport = "unknown";               // "unknown" | "supported" | "unsupported"

const wantedRoots = new Set();
let globalFollowing = false;
let globalConnected = false;
let globalAbort = null;
const following = new Map(); // projectRoot -> AbortController
const reconnectTimers = new Set();
const listeners = new Set();

function syncRuntimeUrl() {
  const cur = runtimeUrl();
  if (cur !== activeUrl) {
    stopWatchShows();
    activeUrl = cur;
    listed.clear();
    known.clear();
    observedShows.clear();
    surfaceScreens.clear();
    observedCache.clear();
    observedInflight.clear();
    wantedRoots.clear();
    observedSupport = { state: "unknown", at: 0 };
    globalShowsSupport = "unknown";
    globalEventsSupport = "unknown";
  }
  return cur;
}

async function fetchRuntime(pathname, ms = 5e3) {
  const base = syncRuntimeUrl();
  return fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(ms) });
}

async function getOk(pathname, ms = 5e3) {
  const res = await fetchRuntime(pathname, ms);
  if (!res.ok) {
    const err = new Error(`${pathname}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function indexObservedItems(items) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.kind === "screen" && item.provenance !== "shown") {
      const hash = surfaceScreenHash(item);
      const ext = extFromMedia(item.mediaType, item.sourcePath);
      surfaceScreens.set(hash, {
        id: item.id,
        showId: item.showId || null,
        ext,
        mediaType: item.mediaType || `image/${ext === "jpg" ? "jpeg" : ext}`,
      });
    }
    const sourcePath = item.sourcePath || item.subject?.label || item.title || item.id;
    const record = {
      id: item.id,
      showId: item.showId || null,
      sourcePath,
      path: sourcePath,
      name: path.basename(sourcePath),
      kind: item.kind,
      view: viewOf({ ...item, sourcePath }),
      mediaType: item.mediaType || "application/octet-stream",
      createdAt: item.createdAt || Date.now(),
      provenance: item.provenance || "shown",
      local: item.provenance !== "shown",
    };
    observedShows.set(item.id, record);
    if (item.showId) observedShows.set(item.showId, record);
  }
}

/**
 * Query `GET /v1/observed-surfaces?windowMs=...` when supported by the runtime.
 * Falls back cleanly (`supported: false`) when the runtime is offline or returns 404/400.
 */
export async function observedSurfaces(windowMs = 4 * 3600e3) {
  syncRuntimeUrl();
  const key = Math.max(60_000, Math.round(windowMs));
  if (observedSupport.state === "unsupported" && Date.now() - observedSupport.at < 10e3) {
    return { reachable: true, supported: false, inventory: null };
  }
  const hit = observedCache.get(key);
  if (hit && Date.now() - hit.at < 400) return hit.result;
  if (observedInflight.has(key)) return observedInflight.get(key);

  const task = (async () => {
    let res;
    try {
      res = await fetchRuntime(`/v1/observed-surfaces?windowMs=${key}`, 6e3);
    } catch {
      return { reachable: false, supported: false, inventory: null };
    }
    if (res.status === 404 || res.status === 400 || res.status === 501) {
      observedSupport = { state: "unsupported", at: Date.now() };
      return { reachable: true, supported: false, inventory: null };
    }
    if (!res.ok) {
      return { reachable: true, supported: false, inventory: null };
    }
    let body = null;
    try { body = await res.json(); } catch {}
    if (body?.schema !== "scout.observed-surfaces/v1" || !Array.isArray(body.items)) {
      observedSupport = { state: "unsupported", at: Date.now() };
      return { reachable: true, supported: false, inventory: null };
    }
    observedSupport = { state: "supported", at: Date.now() };
    indexObservedItems(body.items);
    const result = { reachable: true, supported: true, inventory: body };
    observedCache.set(key, { at: Date.now(), result });
    return result;
  })().finally(() => observedInflight.delete(key));

  observedInflight.set(key, task);
  return task;
}

export const observedShowById = (id) => observedShows.get(id) || null;

export async function observedShowBytes(id) {
  const rec = observedShows.get(id);
  const surfaceId = rec?.id || id;
  try {
    const res = await getOk(`/v1/observed-surfaces/${encodeURIComponent(surfaceId)}/bytes`, 20e3);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (rec?.showId) {
      const res = await getOk(`/v1/shows/${encodeURIComponent(rec.showId)}/bytes`, 20e3);
      return Buffer.from(await res.arrayBuffer());
    }
    throw err;
  }
}

/** Materialize a runtime-observed screen into Studio's local `IMG` cache on demand. */
export async function materializeRuntimeScreen(hash, ext) {
  syncRuntimeUrl();
  const out = path.join(IMG, `${hash}.${ext}`);
  if (fs.existsSync(out)) return out;
  const src = surfaceScreens.get(hash);
  if (!src) return null;
  let bytes = null;
  try {
    const res = await getOk(`/v1/observed-surfaces/${encodeURIComponent(src.id)}/bytes`, 20e3);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    if (src.showId) {
      try {
        const res = await getOk(`/v1/shows/${encodeURIComponent(src.showId)}/bytes`, 20e3);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch {}
    }
  }
  if (!bytes || !imageSize(bytes)) return null;
  fs.mkdirSync(IMG, { recursive: true });
  const tmp = `${out}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, out);
    return out;
  } catch {
    fs.rmSync(tmp, { force: true });
    return null;
  }
}

/** Every show for these project roots, newest version of each file only. Uses global `/v1/shows`
 * first and falls back to per-root `/v1/shows?projectRoot=...` only on older runtimes. */
export async function showsFor(roots) {
  syncRuntimeUrl();
  const out = [];
  let usedGlobal = false;

  if (globalShowsSupport !== "unsupported") {
    const globalHit = listed.get("*");
    if (globalHit && Date.now() - globalHit.at < (globalConnected ? 300e3 : 4e3)) {
      out.push(...globalHit.shows);
      usedGlobal = true;
    } else {
      try {
        const res = await fetchRuntime("/v1/shows");
        if (res.ok) {
          const shows = (await res.json()).shows || [];
          globalShowsSupport = "supported";
          listed.set("*", { at: Date.now(), shows });
          out.push(...shows);
          usedGlobal = true;
        } else if (res.status === 400 || res.status === 404) {
          globalShowsSupport = "unsupported";
        }
      } catch {}
    }
  }

  if (!usedGlobal) {
    await Promise.all([...new Set(roots.filter(Boolean))].map(async (root) => {
      const hit = listed.get(root);
      if (hit && Date.now() - hit.at < (following.has(root) ? 300e3 : 4e3)) {
        out.push(...hit.shows);
        return;
      }
      let shows = [];
      try { shows = (await (await getOk(`/v1/shows?projectRoot=${encodeURIComponent(root)}`)).json()).shows || []; } catch {}
      listed.set(root, { at: Date.now(), shows });
      out.push(...shows);
    }));
  }

  const all = [...new Map(out.map((s) => [s.id, s])).values()];
  const byItem = new Map();
  for (const s of all) {
    known.set(s.id, s);
    const list = byItem.get(s.itemId);
    if (list) list.push(s);
    else byItem.set(s.itemId, [s]);
  }

  const latestList = [];
  for (const group of byItem.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
    const s = group[group.length - 1];
    const prev = group.length > 1 ? group[group.length - 2] : null;
    const view = viewOf(s);
    const surfaceKind = view === "image" ? "screen" : view === "html" ? "html" : view === "markdown" ? "markdown" : view === "pdf" ? "pdf" : view === "video" ? "video" : "document";
    latestList.push({
      id: s.id,
      itemId: s.itemId,
      sessionId: s.sessionId || null,
      agentId: s.agentId,
      harness: s.harness || null,
      projectRoot: s.projectRoot,
      worktree: s.worktree,
      branch: s.branch || "",
      path: s.sourcePath,
      name: path.basename(s.sourcePath),
      view,
      mediaType: s.mediaType,
      size: s.byteSize,
      caption: s.caption || "",
      at: s.createdAt,
      versions: group.length,
      provenance: "shown",
      revision: group.length,
      ...(prev ? { supersedes: prev.id } : {}),
      subject: deriveSurfaceSubject({ sourcePath: s.sourcePath, projectRoot: s.projectRoot, kind: surfaceKind }),
    });
  }
  return latestList.sort((a, b) => b.at - a.at);
}

export const showById = (id) => known.get(id) || null;

// ---- pushed, not polled: 1 global /v1/shows/events stream, with per-root fallback on 400
export function onShows(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function streamStats() {
  syncRuntimeUrl();
  return {
    mode: globalEventsSupport,
    globalFollowing,
    globalConnected,
    perRootStreams: following.size,
  };
}

export function stopWatchShows() {
  globalFollowing = false;
  globalConnected = false;
  if (globalAbort) {
    try { globalAbort.abort(); } catch {}
    globalAbort = null;
  }
  for (const ac of following.values()) {
    try { ac.abort(); } catch {}
  }
  following.clear();
  for (const t of reconnectTimers) clearTimeout(t);
  reconnectTimers.clear();
}

function scheduleReconnect(fn, delayMs) {
  const t = setTimeout(() => {
    reconnectTimers.delete(t);
    fn();
  }, delayMs);
  t.unref?.();
  reconnectTimers.add(t);
}

/** Follow the runtime's show events: 1 host-wide stream when supported, per-root only on 400. */
export function watchShows(roots = []) {
  syncRuntimeUrl();
  for (const root of roots) if (root) wantedRoots.add(root);

  if (globalEventsSupport === "unsupported") {
    for (const root of wantedRoots) {
      if (!following.has(root)) followRoot(root, 0);
    }
    return;
  }
  if (!globalFollowing) {
    globalFollowing = true;
    followGlobal(0);
  }
}

async function followGlobal(failures) {
  const urlAtStart = syncRuntimeUrl();
  const ac = new AbortController();
  globalAbort = ac;
  let opened = false;
  try {
    const res = await fetch(`${urlAtStart}/v1/shows/events?since=${Date.now()}`, { signal: ac.signal });
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
    if (res.status === 400) {
      globalEventsSupport = "unsupported";
      globalFollowing = false;
      globalConnected = false;
      globalAbort = null;
      for (const root of wantedRoots) {
        if (!following.has(root)) followRoot(root, 0);
      }
      return;
    }
    if (!res.ok || !res.body) throw new Error(String(res.status));
    globalEventsSupport = "supported";
    globalConnected = true;
    opened = true;
    if (failures) {
      listed.clear();
      observedCache.clear();
      for (const fn of listeners) fn("*");
    }
    const text = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      if (urlAtStart !== activeUrl || ac.signal.aborted) return;
      buf += text.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^event:\s*show\.created$/m.test(block)) {
          let projectRoot = "*";
          const dataLine = /^data:\s*(.+)$/m.exec(block)?.[1];
          if (dataLine) {
            try { projectRoot = JSON.parse(dataLine)?.projectRoot || "*"; } catch {}
          }
          listed.delete("*");
          if (projectRoot !== "*") listed.delete(projectRoot); else listed.clear();
          observedCache.clear();
          for (const fn of listeners) fn(projectRoot);
        }
      }
    }
  } catch {
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
  } finally {
    if (globalAbort === ac) globalConnected = false;
  }
  if (!globalFollowing || urlAtStart !== activeUrl || ac.signal.aborted) return;
  const n = opened ? 1 : failures + 1;
  scheduleReconnect(() => followGlobal(n), Math.min(60e3, 2e3 * 2 ** Math.min(n, 5)));
}

async function followRoot(root, failures) {
  const urlAtStart = syncRuntimeUrl();
  const ac = new AbortController();
  following.set(root, ac);
  let opened = false;
  try {
    const res = await fetch(`${urlAtStart}/v1/shows/events?projectRoot=${encodeURIComponent(root)}&since=${Date.now()}`, { signal: ac.signal });
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
    if (!res.ok || !res.body) throw new Error(String(res.status));
    opened = true;
    if (failures) {
      listed.delete(root);
      observedCache.clear();
      for (const fn of listeners) fn(root);
    }
    const text = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      if (urlAtStart !== activeUrl || ac.signal.aborted) return;
      buf += text.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^event:\s*show\.created$/m.test(block)) {
          listed.delete(root);
          observedCache.clear();
          for (const fn of listeners) fn(root);
        }
      }
    }
  } catch {
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
  }
  if (!following.has(root) || urlAtStart !== activeUrl || ac.signal.aborted) return;
  const n = opened ? 1 : failures + 1;
  scheduleReconnect(() => followRoot(root, n), Math.min(60e3, 2e3 * 2 ** Math.min(n, 5)));
}

/** A show's bytes, as the runtime keeps them. */
export async function showBytes(id) {
  const res = await getOk(`/v1/shows/${encodeURIComponent(id)}/bytes`, 20e3);
  return Buffer.from(await res.arrayBuffer());
}
