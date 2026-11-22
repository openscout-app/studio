// The canvas's contents: every Claude Code session that took a screen in the window asked for,
// grouped by the repository it worked in, with what Scout and Claude know about it right now.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CLAUDE_PROJECTS, RUNTIME, findScout } from "./paths.mjs";
import { readTranscript, screensOf, stateOf as parsed } from "./transcripts.mjs";

/** a session that wrote in the last this-long is working, unless it said it was done */
const WORKING_MS = 90e3;

// ---- Scout's view of sessions: titles and attention, from the runtime's discovery
let discovery = { at: 0, up: false, installed: false, byId: new Map() };
async function discover() {
  if (Date.now() - discovery.at < 15e3) return discovery;
  const next = { at: Date.now(), up: false, installed: !!findScout(), byId: new Map() };
  try {
    const res = await fetch(`${RUNTIME}/v1/tail/discover`, { signal: AbortSignal.timeout(5e3) });
    if (res.ok) {
      const d = await res.json();
      next.up = true;
      for (const t of d.transcripts || []) next.byId.set(t.sessionId, t);
    }
  } catch {}
  discovery = next;
  return next;
}

// ---- Claude's own record of which sessions are open, and whether each is busy
function openSessions() {
  const dir = path.join(os.homedir(), ".claude", "sessions");
  const open = new Map();
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return open; }
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      process.kill(r.pid, 0); // throws if the process is gone
      if (r.sessionId) open.set(r.sessionId, { pid: r.pid, status: r.status || "", kind: r.kind || "", name: r.name || "" });
    } catch {}
  }
  return open;
}

// ---- the repository a folder belongs to, so a repo's worktrees sit together
const repoCache = new Map();
export function repoOf(cwd) {
  if (!cwd) return { root: "", name: "unknown" };
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let root = cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, "");
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4e3 }).trim();
    if (common) root = common.endsWith("/.git") ? path.dirname(common) : common;
  } catch {
    // the folder is gone (a removed worktree): file it under the sibling repo its name starts with,
    // so scout-apps-board-ui sits with scout-apps
    const parent = path.dirname(root), base = path.basename(root);
    let sibs = [];
    try { sibs = fs.readdirSync(parent).filter((n) => base.startsWith(`${n}-`) && fs.existsSync(path.join(parent, n, ".git"))); } catch {}
    const best = sibs.sort((a, b) => b.length - a.length)[0];
    if (best) root = path.join(parent, best);
  }
  const r = { root, name: path.basename(root) || root };
  repoCache.set(cwd, r);
  return r;
}

let branchCache = new Map();
function branchOf(cwd) {
  if (!cwd) return "";
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 60e3) return hit.v;
  let v = "";
  try { v = execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3e3 }).trim(); } catch {}
  branchCache.set(cwd, { at: Date.now(), v });
  return v;
}

/** Every transcript written in the window: a session's own, and its subagents' under it. */
function transcriptsSince(since) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const base = path.join(CLAUDE_PROJECTS, d);
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      const p = path.join(base, n);
      if (n.endsWith(".jsonl")) {
        try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push({ file: p, session: n.slice(0, -6), mtime: st.mtimeMs, size: st.size }); } catch {}
      } else if (!n.includes(".")) {
        const sub = path.join(p, "subagents");
        let subs = [];
        try { subs = fs.readdirSync(sub).filter((x) => x.endsWith(".jsonl")); } catch { continue; }
        for (const x of subs) {
          const f = path.join(sub, x);
          try { const st = fs.statSync(f); if (st.mtimeMs >= since) out.push({ file: f, session: n, subagent: true, mtime: st.mtimeMs, size: st.size }); } catch {}
        }
      }
    }
  }
  return out;
}

// ---- reading in the background, newest first
//
// A load lists the window's transcripts, newest first, and reads them one after another. The
// canvas is drawn from whatever has been read so far, so the latest session shows within a moment
// and the rest arrive behind it. Once a load is done, the next ask for the canvas starts a fresh
// one, which costs little: each transcript is read only from where it stopped.
const loads = new Map(); // hours -> load
function load(hours) {
  const was = loads.get(hours);
  if (was && (!was.done || Date.now() - was.endedAt < 10e3)) return was;
  const files = transcriptsSince(Date.now() - hours * 3600e3).sort((a, b) => b.mtime - a.mtime);
  const l = { files, done: false, endedAt: 0, first: !was, start: new Map(files.map((t) => [t.file, parsed(t.file)?.offset || 0])) };
  loads.set(hours, l);
  (async () => {
    for (const t of files) await readTranscript(t.file, t.session).catch(() => null);
    l.done = true;
    l.endedAt = Date.now();
  })();
  return l;
}

/** What the canvas draws, for the last `hours`: what has been read so far, and how far along. */
export async function canvas(hours = 72) {
  const since = Date.now() - hours * 3600e3;
  const l = load(hours);
  const [disc, open] = [await discover(), openSessions()];
  const bySession = new Map();
  let read = 0, total = 0;
  for (const t of l.files) {
    const s = parsed(t.file);
    const from = l.start.get(t.file) || 0;
    total += Math.max(0, t.size - from);
    read += s ? Math.max(0, Math.min(s.offset, t.size) - from) : 0;
    if (!s) continue;
    let rec = bySession.get(t.session);
    if (!rec) bySession.set(t.session, (rec = { id: t.session, own: null, parts: [] }));
    if (t.subagent) rec.parts.push(s); else rec.own = s;
  }
  const projects = new Map();
  for (const rec of bySession.values()) {
    const all = [rec.own, ...rec.parts].filter(Boolean);
    const screens = all.flatMap(screensOf).filter((sc) => sc.at >= since).sort((a, b) => a.at - b.at);
    if (!screens.length) continue;
    const own = rec.own || all[0];
    const cwd = own.cwd || all.find((s) => s.cwd)?.cwd || "";
    const d = disc.byId.get(rec.id) || {};
    const o = open.get(rec.id);
    const lastAt = Math.max(...all.map((s) => s.lastAt || 0));
    const working = !!o && (o.status === "busy" || (Date.now() - lastAt < WORKING_MS && (own.lastStop !== "end_turn" || own.openTools > 0)));
    const repo = repoOf(cwd);
    const session = {
      id: rec.id, cwd, branch: branchOf(cwd),
      // Claude's own title first; Scout's relay names (session-…-relay-agent) say nothing to a person
      title: [d.customTitle, d.aiTitle, d.title, o?.name, d.sessionName].find((t) => t && !/^session-[a-z0-9]+-[a-z0-9]+/.test(t)) || own.prompt.slice(0, 80) || rec.id.slice(0, 8),
      prompt: own.prompt, firstAt: own.firstAt, lastAt,
      open: !!o, working, attention: d.attention || d.waitingFor || null,
      // what it did last, from it or one of its subagents, whichever was later
      now: all.map((s) => s.now).filter(Boolean).sort((a, b) => b.at - a.at)[0]?.text || null,
      screens: screens.map((sc) => ({
        id: `${rec.id}:${sc.hash}`, hash: sc.hash, ext: sc.ext, w: sc.w, h: sc.h, at: sc.at,
        tool: sc.tool, url: sc.url, file: sc.file, caption: sc.caption, before: sc.before || null, open: !!sc.open,
      })),
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(session);
  }
  const list = [...projects.values()];
  for (const p of list) p.sessions.sort((a, b) => b.lastAt - a.lastAt);
  list.sort((a, b) => b.sessions[0].lastAt - a.sessions[0].lastAt);
  const sessions = new Set(l.files.map((t) => t.session)).size;
  return {
    at: Date.now(), hours, scout: { up: disc.up, installed: disc.installed || disc.up }, projects: list,
    // how far the read has come, by bytes, so a bar moves evenly
    loading: { done: l.done, first: l.first, read, total, sessions },
  };
}

/** The parse state of a session's own transcript, read up to now, for the answers to notes sent into it. */
export async function stateOf(sessionId) {
  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(CLAUDE_PROJECTS, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return readTranscript(f, sessionId);
  }
  return null;
}

export const isOpen = (sessionId) => openSessions().get(sessionId) || null;
