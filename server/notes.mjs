// Notes pinned on screens, and Scout carrying each one to the session that took the screen.
//
// A note's story is its trail, oldest step first:
//   waiting   the session isn't open, so nothing was sent (tried again on every sweep)
//   failed    Scout tried and the send was refused; `why` says how
//   sent      Scout delivered it into the session
//   handed    the operator gave it to a new session in the same repo instead
// Whether it arrived and what the session answered come from the session's own transcript,
// which carries the note's marker.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { HOME, IMG, NOTES, findScout } from "./paths.mjs";
import { portable } from "./shared-screens.mjs";
import { isOpen, stateOf } from "./sessions.mjs";
import { materializeRuntimeScreen } from "./runtime.mjs";
import { materialize } from "./transcripts.mjs";

let listeners = new Set();
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => { for (const fn of listeners) try { fn(); } catch {} };

function load() {
  try { return JSON.parse(fs.readFileSync(NOTES, "utf8")); } catch { return []; }
}
function save(list) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${NOTES}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, NOTES);
  changed();
}
function update(id, fn) {
  const list = load();
  const n = list.find((x) => x.id === id);
  if (!n) return null;
  fn(n);
  save(list);
  return n;
}
function step(n, ev) {
  const last = n.trail.at(-1);
  if (last && last.what === ev.what && last.why === ev.why) return;
  n.trail.push({ ...ev, at: Date.now() });
}

// ---- the scout command
let bin = null;
function scoutBin() {
  return bin || (bin = findScout()) || "scout";
}
function scout(args, timeout = 60e3) {
  return new Promise((resolve) => {
    execFile(scoutBin(), ["--json", ...args], { timeout, maxBuffer: 16e6 }, (err, out) => {
      let json = null;
      try { json = JSON.parse(String(out).slice(String(out).indexOf("{"))); } catch {}
      resolve({ json, err: err && !json ? String(err.message || err).slice(0, 200) : null });
    });
  });
}

/** What the session reads: the note, where on which screen, and how its answer comes back. */
export function message(n) {
  const where = `${Math.round(n.x * 100)}% across, ${Math.round(n.y * 100)}% down`;
  const of = n.screen.url ? ` of ${n.screen.url}` : n.screen.file ? ` (${n.screen.file})` : "";
  if (n.re) {
    return [
      `A reply from Scout Studio to what you pointed at on a screen you took${of}, at ${where} [scout-studio:${n.id}] (pointer ${n.re}).`,
      ...(n.reSay ? ["", `You said: ${n.reSay}`] : []),
      "",
      `They answered: ${n.text}`,
      "",
      `The screen is ${path.join(IMG, `${n.screen.hash}.${n.screen.ext}`)}. Answer here as usual; the canvas shows your reply beside theirs.`,
    ].join("\n");
  }
  return [
    `A note from Scout Studio on a screen you took${of}, at ${where} [scout-studio:${n.id}]:`,
    "",
    n.text,
    "",
    `The screen is ${path.join(IMG, `${n.screen.hash}.${n.screen.ext}`)}. Answer here as usual; the canvas shows your reply beside the note.`,
  ].join("\n");
}

const carrying = new Set();
/** Try to deliver one note now. Never throws. */
export async function deliver(id) {
  const n = load().find((x) => x.id === id);
  if (!n || carrying.has(id)) return;
  const last = n.trail.at(-1)?.what;
  if (["sent", "handed", "available"].includes(last) || n.kept || n.readAt) return;
  if (portable(n.session) || (n.harness && n.harness !== "claude" && n.harness !== "codex")) {
    update(id, x => step(x, { what: "available" }));
    return;
  }
  if (n.harness !== "codex" && !isOpen(n.session)) {
    update(id, (x) => step(x, { what: "waiting" }));
    return;
  }
  carrying.add(id);
  try {
    await materializeRuntimeScreen(n.screen.hash, n.screen.ext);
    const { json, err } = await scout(["session", "send", n.session, message(n), ...(n.harness === "codex" ? ["--harness", "codex"] : [])]);
    update(id, (x) => {
      if (json?.ok) { step(x, { what: "sent", how: json.delivery || json.route || json.host || null }); x.sentAt = Date.now(); }
      else if (json?.code === "not_live") step(x, { what: "waiting" });
      else { step(x, { what: "failed", why: json?.code || json?.error?.message || json?.error || err || "no answer from scout" }); x.tries = (x.tries || 0) + 1; }
    });
  } finally { carrying.delete(id); }
}

/** Give a note to a new Claude session in the note's repo, through Scout. */
export async function handOff(id) {
  const n = load().find((x) => x.id === id);
  if (!n || portable(n.session) || (n.harness && n.harness !== "claude")) return null;
  const { json, err } = await scout(["ask", "--project", n.cwd, "--harness", "claude", "--label", "scout-studio", message(n)], 120e3);
  const ok = json && json.ok !== false && json.receipt?.ok !== false;
  return update(id, (x) => {
    if (ok) step(x, { what: "handed", task: json.receipt?.taskId || json.taskId || json.handle || null });
    else step(x, { what: "failed", why: json?.receipt?.reason || json?.error?.message || json?.error || err || "Scout refused it" });
  });
}

/** Notes, each with what its session made of it so far. */
export async function notes() {
  return Promise.all(load().map(async (n) => {
    const s = n.trail.some((t) => t.what === "sent") ? await stateOf(n.session) : null;
    return { ...n, arrivedAt: n.readAt || s?.arrived[n.id] || null, answers: [...(s?.answers[n.id] || []), ...(n.directAnswers || [])].sort((a, b) => a.at - b.at) };
  }));
}

// Read and acknowledge only notes addressed to this conversation.
export function feedback(session, note, reply) {
  if (!session || typeof session !== "string") throw Error("Choose a session.");
  const list = load();
  const mine = list.filter(n => n.session === session);
  if (note !== undefined || reply !== undefined) {
    const n = mine.find(n => n.id === note);
    if (!n || typeof reply !== "string" || !reply.trim()) throw Error("Give a note from this session and a reply.");
    const text = reply.trim().slice(0, 4000);
    n.directAnswers ||= [];
    if (n.directAnswers.at(-1)?.text !== text) n.directAnswers.push({ text, at: Date.now() });
  }
  const unread = mine.filter(n => !n.readAt);
  for (const n of unread) n.readAt = Date.now();
  if (unread.length || note) save(list);
  return mine.map(n => ({ id: n.id, text: n.text, screen: n.screen, x: n.x, y: n.y, at: n.at,
    pointer: n.re, answering: n.reSay, replies: n.directAnswers || [] }));
}

export function addNote({ session, harness, project, cwd, screen, x, y, text, re, reSay }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(session || "") || !screen?.hash || typeof text !== "string" || !text.trim()) return null;
  const n = {
    id: `n_${crypto.randomBytes(5).toString("hex")}`,
    session, harness, project: project || "", cwd: cwd || "",
    screen: { hash: screen.hash, ext: screen.ext || "png", w: screen.w, h: screen.h, url: screen.url || null, file: screen.file || null },
    x: Math.min(1, Math.max(0, Number(x) || 0)), y: Math.min(1, Math.max(0, Number(y) || 0)),
    text: text.trim().slice(0, 4000), at: Date.now(), trail: [],
    // a reply to a pointer the session made: the session hears what it is an answer to
    ...(typeof re === "string" && /^p_[a-z0-9]+$/.test(re) ? { re, reSay: String(reSay || "").slice(0, 2000) } : {}),
  };
  // the session is told where the screen is, so it has to be on disk
  materialize(n.screen.hash, n.screen.ext);
  save([...load(), n]);
  deliver(n.id);
  return n;
}

export function retry(id) { update(id, (x) => { x.tries = 0; }); return deliver(id); }
export function keep(id, kept = true) { return update(id, (x) => { x.kept = kept; }); }
export function remove(id) { save(load().filter((x) => x.id !== id)); }

/** Every 20 seconds, try again the notes still waiting on their session. */
let timer = null;
export function startSweep() {
  if (timer) return;
  timer = setInterval(() => {
    for (const n of load()) {
      const last = n.trail.at(-1)?.what;
      // a send Scout keeps refusing stops after six tries; Retry starts it again
      if (!n.kept && !n.readAt && last !== "available" && last !== "sent" && last !== "handed" && !(last === "failed" && n.tries >= 6)) deliver(n.id);
    }
  }, 20e3);
  timer.unref?.();
}
