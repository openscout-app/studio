// Scout's runtime, underneath Studio. Studio reads from it and never writes a record itself: shown
// files come from /v1/shows, session titles from /v1/tail/discover. With no runtime, Studio still
// draws what it reads from transcripts; the runtime only adds to it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

async function get(p, ms = 5e3) {
  const res = await fetch(`${runtimeUrl()}${p}`, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${p}: ${res.status}`);
  return res;
}

// ---- shown files: what agents chose to put in front of the person with `scout show`
const MD = /\.(md|markdown|mdx)$/i;
const HTML = /\.html?$/i;

/** How Studio draws a show: by the file's name first, since the runtime calls most text "document". */
export function viewOf(show) {
  const p = show.sourcePath || "";
  if (show.kind === "image") return "image";
  if (show.kind === "video") return "video";
  if (MD.test(p) || show.mediaType === "text/markdown") return "markdown";
  if (HTML.test(p) || show.mediaType === "text/html") return "html";
  if (show.mediaType === "application/pdf") return "pdf";
  if (/^text\/|json|xml|yaml|toml/.test(show.mediaType)) return "text";
  return "file";
}

const listed = new Map(); // project root -> { at, shows }
const known = new Map();  // show id -> show, for the routes that serve one

/** Every show for these project roots, newest version of each file only. Cached briefly, since the
 * canvas asks every few seconds. Empty when the runtime doesn't answer. */
export async function showsFor(roots) {
  const out = [];
  const globalHit = listed.get("*");
  if (globalHit && Date.now() - globalHit.at < 8e3) {
    out.push(...globalHit.shows);
  } else {
    let globalShows = [];
    try { globalShows = (await (await get("/v1/shows")).json()).shows || []; } catch {}
    listed.set("*", { at: Date.now(), shows: globalShows });
    out.push(...globalShows);
  }
  await Promise.all([...new Set(roots.filter(Boolean))].map(async (root) => {
    const hit = listed.get(root);
    if (hit && Date.now() - hit.at < (following.has(root) ? 300e3 : 8e3)) return out.push(...hit.shows);
    let shows = [];
    try { shows = (await (await get(`/v1/shows?projectRoot=${encodeURIComponent(root)}`)).json()).shows || []; } catch {}
    listed.set(root, { at: Date.now(), shows });
    out.push(...shows);
  }));
  const all = [...new Map(out.map((s) => [s.id, s])).values()];
  const latest = new Map();
  for (const s of all) {
    known.set(s.id, s);
    const was = latest.get(s.itemId);
    if (!was || s.createdAt > was.createdAt) latest.set(s.itemId, s);
  }
  return [...latest.values()].sort((a, b) => b.createdAt - a.createdAt).map((s) => ({
    id: s.id, itemId: s.itemId, sessionId: s.sessionId || null, agentId: s.agentId, harness: s.harness || null,
    projectRoot: s.projectRoot, worktree: s.worktree, branch: s.branch || "", path: s.sourcePath,
    name: path.basename(s.sourcePath), view: viewOf(s), mediaType: s.mediaType, size: s.byteSize,
    caption: s.caption || "", at: s.createdAt,
    versions: all.filter((o) => o.itemId === s.itemId).length,
  }));
}

export const showById = (id) => known.get(id) || null;

// ---- pushed, not polled: the runtime streams each new show, per repository
const following = new Map(); // project root -> true while a stream is open or waiting to reopen
const listeners = new Set();
/** Call fn whenever the runtime shows a new file in a repository Studio follows. */
export function onShows(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Follow the runtime's show events for these repositories, once each. */
export function watchShows(roots) {
  for (const root of new Set(roots.filter(Boolean))) if (!following.has(root)) { following.set(root, true); follow(root, 0); }
}
async function follow(root, failures) {
  let opened = false;
  try {
    const res = await fetch(`${runtimeUrl()}/v1/shows/events?projectRoot=${encodeURIComponent(root)}&since=${Date.now()}`);
    if (!res.ok || !res.body) throw new Error(String(res.status));
    opened = true;
    // anything shown while the stream was closed: list again
    if (failures) { listed.delete(root); for (const fn of listeners) fn(root); }
    const text = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += text.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^event: show\.created$/m.test(block)) { listed.delete(root); for (const fn of listeners) fn(root); }
      }
    }
  } catch {}
  // the runtime ended the stream or isn't answering: try again, less often the longer it stays away
  const n = opened ? 1 : failures + 1;
  setTimeout(() => follow(root, n), Math.min(60e3, 2e3 * 2 ** Math.min(n, 5)));
}

/** A show's bytes, as the runtime keeps them. */
export async function showBytes(id) {
  const res = await get(`/v1/shows/${encodeURIComponent(id)}/bytes`, 20e3);
  return Buffer.from(await res.arrayBuffer());
}
