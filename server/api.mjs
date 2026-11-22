// The HTTP side: the canvas, the screens' images, and notes. Local only: a request from another
// site, or to a host name that isn't this machine, is refused, so no page can send notes into a
// session.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { IMG } from "./paths.mjs";
import { materialize } from "./transcripts.mjs";
import { canvas } from "./sessions.mjs";
import { addNote, handOff, keep, notes, remove, retry, startSweep } from "./notes.mjs";
import { addPointer, markSeen, pointer, pointersOf, screensOf } from "./pointers.mjs";
import { showById, showBytes, showsFor, viewOf } from "./runtime.mjs";
import { viewResponse } from "./show-view.mjs";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function local(req) {
  if (!LOCAL.test(req.headers.host || "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

function body(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

/** A card-sized JPEG of a screen, made once with sips. Null if it can't be made. */
const making = new Map();
const queue = [];
let running = 0;
/** four sips at a time, however many cards come into view at once */
function next() {
  while (running < 4 && queue.length) {
    const job = queue.shift();
    running++;
    execFile("sips", ["-Z", "520", "-s", "format", "jpeg", "-s", "formatOptions", "80", job.src, "--out", job.out], { timeout: 20e3 }, (e) => {
      running--;
      making.delete(job.hash);
      job.ok(e ? null : job.out);
      next();
    });
  }
}
function thumb(src, hash) {
  const out = path.join(IMG, "t", `${hash}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!making.has(hash)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    making.set(hash, new Promise((ok) => { queue.push({ src, out, hash, ok }); next(); }));
  }
  return making.get(hash);
}

const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Handles /api/* and /img/*; returns false for anything else. */
export async function handle(req, res) {
  const url = new URL(req.url, "http://local");
  const p = url.pathname;
  if (!p.startsWith("/api/") && !p.startsWith("/img/")) return false;
  if (!local(req)) { send(res, 403, { error: "local only" }); return true; }
  startSweep();

  const img = p.match(/^\/img\/(t\/)?([0-9a-f]{16})\.(png|jpg|webp|gif)$/);
  if (img) {
    let file = materialize(img[2], img[3]) || path.join(IMG, `${img[2]}.${img[3]}`);
    if (img[1] && fs.existsSync(file)) file = (await thumb(file, img[2])) || file;
    if (!fs.existsSync(file)) { send(res, 404, { error: "no such screen" }); return true; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).slice(1)], "cache-control": "max-age=31536000, immutable" });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  try {
    if (p === "/api/canvas" && req.method === "GET") {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 4));
      return send(res, 200, await canvas(hours)), true;
    }
    // a shown file, from the runtime, made into a page the reader frames
    const sv = p.match(/^\/api\/shows\/([0-9a-f-]{36})\/view$/);
    if (sv && req.method === "GET") {
      let show = showById(sv[1]);
      if (!show && url.searchParams.get("root")) { await showsFor([url.searchParams.get("root")]); show = showById(sv[1]); }
      if (!show) return send(res, 404, { error: "Scout's runtime has no such shown file" }), true;
      const out = viewResponse({ ...show, view: viewOf(show), name: path.basename(show.sourcePath) }, await showBytes(show.id));
      res.writeHead(out.status, out.headers);
      res.end(out.body);
      return true;
    }
    if (p === "/api/notes" && req.method === "GET") return send(res, 200, { notes: await notes() }), true;
    if (p === "/api/notes" && req.method === "POST") {
      const n = addNote(await body(req));
      return send(res, n ? 200 : 400, n ? { note: n } : { error: "a note needs a session, a screen and some words" }), true;
    }
    const m = p.match(/^\/api\/notes\/(n_[a-z0-9]+)(?:\/(handoff|retry|keep))?$/);
    if (m && req.method === "POST" && m[2] === "handoff") return send(res, 200, { note: await handOff(m[1]) }), true;
    if (m && req.method === "POST" && m[2] === "retry") return await retry(m[1]), send(res, 200, { ok: true }), true;
    if (m && req.method === "POST" && m[2] === "keep") return send(res, 200, { note: keep(m[1], (await body(req)).kept !== false) }), true;
    if (m && req.method === "DELETE" && !m[2]) return remove(m[1]), send(res, 200, { ok: true }), true;
    // pointers: an agent shows a person a spot on its screen
    const sid = url.searchParams.get("session") || "";
    if (p === "/api/screens" && req.method === "GET") {
      const list = await screensOf(sid, Math.min(50, Number(url.searchParams.get("limit")) || 12));
      return send(res, list ? 200 : 404, list ? { screens: list } : { error: `no transcript for session ${sid}` }), true;
    }
    if (p === "/api/pointers" && req.method === "GET") return send(res, 200, { pointers: await pointersOf(sid) }), true;
    if (p === "/api/pointers" && req.method === "POST") {
      try {
        const ptr = await addPointer(await body(req));
        return send(res, 200, { pointer: ptr, url: `http://${req.headers.host}/p/${ptr.id}` }), true;
      } catch (e) { return send(res, 400, { error: String(e.message || e) }), true; }
    }
    const pm = p.match(/^\/api\/pointers\/(p_[a-z0-9]+)(\/seen)?$/);
    if (pm && req.method === "GET" && !pm[2]) { const ptr = await pointer(pm[1]); return send(res, ptr ? 200 : 404, ptr ? { pointer: ptr } : { error: "no such pointer" }), true; }
    if (pm && req.method === "POST" && pm[2]) return send(res, 200, { pointer: markSeen(pm[1]) }), true;
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e?.message || e) });
  }
  return true;
}
