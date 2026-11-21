// Pointers: an agent shows a person one spot on one of its screens, with a remark. A pointer is
// kept here with its screen pinned to disk, so its link (/p/<id>) always opens the same screen at
// the same spot, however the session's screens change afterwards. The person's reply is a note
// that carries the pointer's id, so the session hears what it is an answer to.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, POINTERS } from "./paths.mjs";
import { findSession, screensFor, pickScreen } from "./link.mjs";
import { materialize, stateOf as parsed } from "./transcripts.mjs";
import { notes } from "./notes.mjs";

function load() {
  try { return JSON.parse(fs.readFileSync(POINTERS, "utf8")); } catch { return []; }
}
function save(list) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${POINTERS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, POINTERS);
}

/** A session's screens, newest first, as an agent picks from them. */
export async function screensOf(session, limit = 12) {
  if (!session) return null;
  const s = findSession({ session, env: {} });
  if (!s?.file) return null;
  return (await screensFor(s)).slice(0, limit).map(brief);
}

const brief = (sc) => ({
  id: sc.hash, at: new Date(sc.at).toISOString(), w: sc.w, h: sc.h,
  page: sc.url || null, file: sc.file || null, tool: sc.tool, settled: !sc.open,
  said: (sc.caption || "").slice(0, 160),
});

/**
 * Where on the screen, as fractions: a point (x, y) or a box (x, y, w, h), given in pixels of
 * the screen (the default) or as fractions. Throws with what is wrong.
 */
export function boxOf({ x, y, w = 0, h = 0, unit = "px" }, screen) {
  const n = [x, y, w, h].map(Number);
  if (n.some((v) => !Number.isFinite(v) || v < 0)) throw new Error("x, y, w and h must be numbers, 0 or more");
  if (unit !== "px" && unit !== "fraction") throw new Error('unit is "px" or "fraction"');
  const [fx, fy, fw, fh] = unit === "px" ? [n[0] / screen.w, n[1] / screen.h, n[2] / screen.w, n[3] / screen.h] : n;
  if (fx > 1 || fy > 1 || fx + fw > 1.001 || fy + fh > 1.001) {
    throw new Error(`that falls outside the screen, which is ${screen.w}×${screen.h} px`);
  }
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return { x: r(fx), y: r(fy), w: r(fw), h: r(fh) };
}

/** Make a pointer. Throws with a reason a caller can act on. */
export async function addPointer({ session, screen = "latest", at, say }) {
  if (!session) throw new Error("a pointer needs the session it comes from");
  const s = findSession({ session, env: {} });
  if (!s?.file) throw new Error(`no transcript for session ${session}`);
  const screens = await screensFor(s);
  if (!screens.length) throw new Error("this session has no screens yet; take a screenshot first");
  const sc = pickScreen(screens, screen);
  if (!sc) throw new Error(`no screen "${screen}" in this session; list them with the screens tool`);
  const box = boxOf(at || {}, sc);
  if (!materialize(sc.hash, sc.ext)) throw new Error("couldn't keep a copy of that screen");
  const p = {
    id: `p_${crypto.randomBytes(5).toString("hex")}`,
    session: s.id, cwd: parsed(s.file)?.cwd || "",
    screen: { hash: sc.hash, ext: sc.ext, w: sc.w, h: sc.h, at: sc.at, url: sc.url || null, file: sc.file || null, tool: sc.tool, caption: sc.caption || "" },
    box, say: typeof say === "string" ? say.trim().slice(0, 2000) : "", at: Date.now(), seenAt: null,
  };
  save([...load(), p]);
  return p;
}

/** A pointer, with the person's replies to it. */
export async function pointer(id) {
  const p = load().find((x) => x.id === id);
  if (!p) return null;
  const replies = (await notes()).filter((n) => n.re === id).map((n) => ({ at: n.at, text: n.text, note: n.id }));
  return { ...p, replies };
}

/** A session's pointers, newest first, each with whether it was seen and what came back. */
export async function pointersOf(session) {
  const all = await notes();
  return load().filter((p) => p.session === session).sort((a, b) => b.at - a.at).map((p) => ({
    ...p, replies: all.filter((n) => n.re === p.id).map((n) => ({ at: n.at, text: n.text, note: n.id })),
  }));
}

export function markSeen(id) {
  const list = load();
  const p = list.find((x) => x.id === id);
  if (p && !p.seenAt) { p.seenAt = Date.now(); save(list); }
  return p || null;
}
