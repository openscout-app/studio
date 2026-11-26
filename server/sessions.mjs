// The canvas's contents: every Claude Code session that took a screen in the window asked for,
// grouped by the repository it worked in, with what Scout and Claude know about it right now.
import { sharedInWindow } from "./shared-screens.mjs";
import { codexFiles } from "./codex.mjs";
import { antigravityBrainAssets, classifyTranscriptFile, extraHarnessFiles } from "./harnesses.mjs";
import { discoverWorkspaceArtifacts } from "./artifacts.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CLAUDE_PROJECTS, HOME } from "./paths.mjs";
import { runtimeUrl, showsFor, watchShows } from "./runtime.mjs";
import { readTranscript, screensOf, stateOf as parsed, isWrapped } from "./transcripts.mjs";

/** a session that wrote in the last this-long is working, unless it said it was done */
const WORKING_MS = 90e3;

// ---- Scout's view of sessions: titles and attention, from the runtime's discovery
let discovery = { at: 0, up: false, byId: new Map() };
const FOLLOW = 24; // repositories followed for shows; the runtime allows 32 event streams in all
async function discover() {
  if (Date.now() - discovery.at < 15e3) return discovery;
  const next = { at: Date.now(), up: false, byId: new Map() };
  try {
    const res = await fetch(`${runtimeUrl()}/v1/tail/discover`, { signal: AbortSignal.timeout(5e3) });
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
    // so a worktree named app-board-ui sits with app
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

/** Every transcript written in the window: Claude, Codex, Antigravity, Kimi, and subagents. */
function transcriptsSince(since) {
  const out = [...codexFiles(since), ...extraHarnessFiles(since)];
  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const base = path.join(CLAUDE_PROJECTS, d);
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      const p = path.join(base, n);
      if (n.endsWith(".jsonl")) {
        try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push({ file: p, session: n.slice(0, -6), harness: "claude", mtime: st.mtimeMs, size: st.size }); } catch {}
      } else if (!n.includes(".")) {
        const sub = path.join(p, "subagents");
        let subs = [];
        try { subs = fs.readdirSync(sub).filter((x) => x.endsWith(".jsonl")); } catch { continue; }
        for (const x of subs) {
          const f = path.join(sub, x);
          try { const st = fs.statSync(f); if (st.mtimeMs >= since) out.push({ file: f, session: n, harness: "claude", subagent: true, mtime: st.mtimeMs, size: st.size }); } catch {}
        }
      }
    }
  }
  return out;
}

const MAX_LONG_WINDOW_FILES = 80;

const loads = new Map(); // hours -> load
function load(hours) {
  const was = loads.get(hours);
  if (was && (!was.done || Date.now() - was.endedAt < 10e3)) return was;
  let files = transcriptsSince(Date.now() - hours * 3600e3).sort((a, b) => b.mtime - a.mtime);
  if (hours > 72 && files.length > MAX_LONG_WINDOW_FILES) files = files.slice(0, MAX_LONG_WINDOW_FILES);
  const l = { files, done: false, endedAt: 0, first: !was, start: new Map(files.map((t) => [t.file, parsed(t.file)?.offset || 0])) };
  loads.set(hours, l);
  (async () => {
    for (const t of files) await readTranscript(t.file, t.session, t).catch(() => null);
    l.done = true;
    l.endedAt = Date.now();
  })();
  return l;
}

/** What the canvas draws, for the last `hours`: what has been read so far, and how far along. */
export async function canvas(hours = 4) {
  const since = Date.now() - hours * 3600e3;
  const l = load(hours);
  const [disc, open] = [await discover(), openSessions()];
  const bySession = new Map();
  let read = 0, total = 0;
  const partial = new Set(); // sessions with a transcript not yet read to its end
  for (const t of l.files) {
    const s = parsed(t.file);
    const from = l.start.get(t.file) || 0;
    total += Math.max(0, t.size - from);
    read += s ? Math.max(0, Math.min(s.offset, t.size) - from) : 0;
    if (!s || s.offset < t.size) partial.add(t.session);
    if (!s) continue;
    s.harness = t.harness || "claude";
    let rec = bySession.get(t.session);
    if (!rec) bySession.set(t.session, (rec = { id: t.session, own: null, parts: [] }));
    if (t.subagent) rec.parts.push(s); else rec.own = s;
  }
  // what agents showed on purpose, from the runtime, for every repository a session in the window
  // worked in; each show goes to the session that made it
  // the repositories to ask the runtime about: those of Claude's transcripts here, and those of every
  // session the runtime sees at work in the window (Codex, relayed asks), most recent first
  const seen = new Map();
  const cwdBySession = new Map();
  for (const rec of bySession.values()) {
    const s = rec.own || rec.parts[0];
    if (s?.cwd) {
      seen.set(s.cwd, Math.max(seen.get(s.cwd) || 0, s.lastAt || 0));
      cwdBySession.set(rec.id, s.cwd);
    }
  }
  for (const t of disc.byId.values()) {
    if (t.cwd) {
      if (t.sessionId && !cwdBySession.has(t.sessionId)) cwdBySession.set(t.sessionId, t.cwd);
      const evtAt = t.lastEventAt || t.mtimeMs || 0;
      if (evtAt >= since) seen.set(t.cwd, Math.max(seen.get(t.cwd) || 0, evtAt));
    }
  }
  const latestFor = new Map();
  for (const [cwd, at] of seen) { const r = repoOf(cwd).root; if (r) latestFor.set(r, Math.max(latestFor.get(r) || 0, at)); }
  const roots = [...latestFor].sort((a, b) => b[1] - a[1]).map(([r]) => r).slice(0, FOLLOW);
  const shows = disc.up ? (await showsFor(roots)).filter((sh) => sh.at >= since) : [];
  if (disc.up) watchShows(roots);
  const showsBy = new Map();
  for (const sh of shows) showsBy.set(sh.sessionId, [...(showsBy.get(sh.sessionId) || []), sh]);

  // Antigravity brain scratch images and markdown/HTML artifacts
  const brainBySession = new Map();
  for (const b of antigravityBrainAssets(since, cwdBySession)) brainBySession.set(b.session, b);

  const projects = new Map();
  for (const rec of bySession.values()) {
    const all = [rec.own, ...rec.parts].filter(Boolean);
    const brain = brainBySession.get(rec.id);
    brainBySession.delete(rec.id);
    const written = [];
    const seenShowPaths = new Set();
    for (const s of all) {
      for (const sh of s.writtenShows?.values() || []) {
        if (sh.at >= since && !seenShowPaths.has(sh.path)) {
          seenShowPaths.add(sh.path);
          written.push(sh);
        }
      }
    }
    if (brain?.shows) {
      for (const sh of brain.shows) {
        if (!seenShowPaths.has(sh.path)) {
          seenShowPaths.add(sh.path);
          written.push(sh);
        }
      }
    }
    const runtimeShown = showsBy.get(rec.id) || [];
    showsBy.delete(rec.id);
    for (const sh of runtimeShown) seenShowPaths.add(sh.path);
    const shown = [...runtimeShown, ...written.filter((w) => !runtimeShown.some((r) => r.path === w.path))]
      .sort((a, b) => b.at - a.at);

    const rawScreens = [
      ...all.flatMap(screensOf).filter((sc) => sc.at >= since),
      ...(brain?.screens || []),
    ];
    const dedupScreens = [];
    const seenHashes = new Set();
    for (const sc of rawScreens.sort((a, b) => a.at - b.at)) {
      if (seenHashes.has(sc.hash)) continue;
      seenHashes.add(sc.hash);
      dedupScreens.push(sc);
    }
    if (!dedupScreens.length && !shown.length) continue;
    const own = rec.own || all[0];
    const d = disc.byId.get(rec.id) || {};
    const cwd = own.cwd || all.find((s) => s.cwd)?.cwd || d.cwd || brain?.cwd || "";
    const o = open.get(rec.id);
    const lastAt = Math.max(
      ...all.map((s) => s.lastAt || 0),
      ...dedupScreens.map((sc) => sc.at || 0),
      ...shown.map((sh) => sh.at || 0),
    );
    const working = !!o && (o.status === "busy" || (Date.now() - lastAt < WORKING_MS && (own.lastStop !== "end_turn" || own.openTools > 0)));
    const repo = repoOf(cwd || brain?.brainDir || "");
    const branch = branchOf(cwd);
    for (const sh of shown) {
      if (sh.local) {
        sh.projectRoot = repo.root || sh.projectRoot;
        sh.worktree = cwd || sh.worktree;
        sh.branch = branch || sh.branch;
      }
    }
    const session = {
      id: rec.id, harness: own.harness || d.source || "claude", cwd, branch,
      // Claude's own title first; Scout's relay names (session-…-relay-agent) say nothing to a person
      // and a title that is only Scout's delivery wrapping says nothing either: the task says more
      title: [d.customTitle, d.aiTitle, d.title, d.harnessTitle, o?.name, d.sessionName].find((t) => t && !/^session-[a-z0-9]+-[a-z0-9]+/.test(t) && !isWrapped(t)) || own.prompt.slice(0, 80) || rec.id.slice(0, 8),
      prompt: own.prompt, firstAt: own.firstAt || lastAt, lastAt,
      open: !!o, working, attention: d.attention || d.waitingFor || null,
      // what it did last, from it or one of its subagents, whichever was later
      now: all.map((s) => s.now).filter(Boolean).sort((a, b) => b.at - a.at)[0]?.text || null,
      screens: dedupScreens.map((sc) => ({
        id: `${rec.id}:${sc.hash}`, hash: sc.hash, ext: sc.ext, w: sc.w, h: sc.h, at: sc.at,
        tool: sc.tool, url: sc.url, file: sc.file, caption: sc.caption || "", before: sc.before || null, open: !!sc.open,
      })),
      shows: shown,
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(session);
  }

  // Remaining Antigravity brain folders whose transcript wasn't in `bySession` yet
  for (const [, brain] of brainBySession) {
    const repo = repoOf(brain.cwd || brain.brainDir);
    const branch = branchOf(brain.cwd);
    const allAt = [...brain.screens.map((s) => s.at), ...brain.shows.map((s) => s.at)];
    const session = {
      id: brain.session,
      harness: "antigravity",
      cwd: brain.cwd || brain.brainDir,
      branch,
      title: brain.shows[0]?.caption || `Antigravity · ${repo.name}`,
      prompt: "",
      firstAt: Math.min(...allAt),
      lastAt: Math.max(...allAt),
      open: false,
      working: false,
      attention: null,
      now: null,
      screens: brain.screens.map((sc) => ({
        id: `${brain.session}:${sc.hash}`,
        hash: sc.hash, ext: sc.ext, w: sc.w, h: sc.h, at: sc.at,
        tool: sc.tool, url: sc.url, file: sc.file, caption: sc.caption || "", before: null, open: false,
      })),
      shows: brain.shows,
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(session);
  }
  for (const { id, screens } of sharedInWindow(since)) {
    const first = screens[0], repo = repoOf(first.cwd);
    if (!projects.has(repo.root)) projects.set(repo.root, { ...repo, sessions: [] });
    const group = projects.get(repo.root);
    let session = group.sessions.find(s => s.id === id);
    if (!session) {
      session = { id, harness: first.harness, cwd: first.cwd, branch: branchOf(first.cwd),
        title: first.caption || `Screens from ${first.harness}`, prompt: "", firstAt: screens.at(-1).at,
        lastAt: first.at, open: false, working: false, now: null, attention: null, screens: [], shows: showsBy.get(id) || [] };
      showsBy.delete(id);
      group.sessions.push(session);
    }
    const seenHashes = new Set(session.screens.map(s => s.hash));
    for (const sc of screens) if (!seenHashes.has(sc.hash)) session.screens.push({ ...sc, id: id + ":" + sc.hash });
    session.screens.sort((a,b) => a.at - b.at);
    session.lastAt = Math.max(session.lastAt, first.at);
  }
  // shows from a session the canvas doesn't have (a Scout session, or one whose transcript is
  // outside the window) get an area of their own, named for the worktree they came from
  for (const [sid, list] of showsBy) {
    const first = list[0], repo = repoOf(first.projectRoot);
    const session = {
      id: sid || `shown:${first.worktree}`, harness: first.harness || "scout", cwd: first.worktree, branch: first.branch,
      title: `Shown from ${path.basename(first.worktree)}`, prompt: "",
      firstAt: Math.min(...list.map((x) => x.at)), lastAt: Math.max(...list.map((x) => x.at)),
      open: false, working: false, attention: null, now: null, screens: [], shows: list,
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(session);
  }
  // Workspace visual studies, plans and scratch screenshots in active repositories
  for (const ws of discoverWorkspaceArtifacts(roots, since)) {
    const repo = repoOf(ws.root);
    const existingGroup = projects.get(repo.root);
    const claimedPaths = new Set(
      (existingGroup?.sessions || []).flatMap((s) => [
        ...(s.shows || []).map((sh) => sh.path),
        ...(s.screens || []).map((sc) => sc.file).filter(Boolean),
      ]),
    );
    const unclaimedShows = ws.shows.filter((sh) => !claimedPaths.has(sh.path));
    const unclaimedScreens = ws.screens.filter((sc) => !claimedPaths.has(sc.file));
    if (!unclaimedShows.length && !unclaimedScreens.length) continue;
    const branch = branchOf(ws.root);
    for (const sh of unclaimedShows) sh.branch = branch || sh.branch;
    const wsId = `workspace:${repo.name}`;
    const allAt = [...unclaimedShows.map((s) => s.at), ...unclaimedScreens.map((s) => s.at)];
    const wsSession = {
      id: wsId,
      harness: "scout",
      cwd: ws.root,
      branch,
      title: `Workspace · ${repo.name}`,
      prompt: "",
      firstAt: Math.min(...allAt),
      lastAt: Math.max(...allAt),
      open: false,
      working: false,
      attention: null,
      now: null,
      screens: unclaimedScreens.map((sc) => ({
        id: `${wsId}:${sc.hash}`,
        hash: sc.hash, ext: sc.ext, w: sc.w, h: sc.h, at: sc.at,
        tool: sc.tool, url: null, file: sc.file, caption: sc.caption || "", before: null, open: false,
      })),
      shows: unclaimedShows,
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(wsSession);
  }

  const list = [...projects.values()];
  for (const p of list) p.sessions.sort((a, b) => b.lastAt - a.lastAt);
  list.sort((a, b) => b.sessions[0].lastAt - a.sessions[0].lastAt);
  const sessions = new Set(l.files.map((t) => t.session)).size;
  const out = {
    at: Date.now(), hours, scout: { up: disc.up, url: runtimeUrl(), shows: shows.length }, projects: list,
    // how far the read has come, by bytes, so a bar moves evenly
    loading: { done: l.done, first: l.first, read, total, sessions },
  };
  if (l.done) { completed.add(hours); keepSnapshot(hours, out); }
  // until this server has read the window once, fill in from what it drew last time, so the page has
  // the whole canvas at once and the fresh read only corrects it
  else if (!completed.has(hours)) out.projects = merge(snapshot(hours, since), list, partial);
  return out;
}

// ---- the last whole canvas for each window, kept on disk for a cold start
const completed = new Set();
const snapFile = (hours) => path.join(HOME, `canvas-${hours}h.json`);
const snapshots = new Map();
function snapshot(hours, since) {
  if (!snapshots.has(hours)) {
    let projects = [];
    try { projects = JSON.parse(fs.readFileSync(snapFile(hours), "utf8")).projects || []; } catch {}
    snapshots.set(hours, projects);
  }
  // as it was then, less what has since left the window; nothing in it is at work now
  return snapshots.get(hours)
    .map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.lastAt >= since).map((s) => ({ ...s, working: false, shows: s.shows || [] })) }))
    .filter((p) => p.sessions.length);
}
let savedAt = new Map();
function keepSnapshot(hours, out) {
  if (Date.now() - (savedAt.get(hours) || 0) < 30e3) return;
  savedAt.set(hours, Date.now());
  fs.mkdir(HOME, { recursive: true }, () => fs.writeFile(snapFile(hours), JSON.stringify({ at: out.at, projects: out.projects }), () => {}));
}
/** The fresh read wins for each session once it has read that session to the end; until then the
 * snapshot's copy stays, so a card never goes away and comes back while the read catches up. */
function merge(old, fresh, partial) {
  const projects = new Map(old.map((p) => [p.root, { ...p, sessions: [...p.sessions] }]));
  for (const p of fresh) {
    const o = projects.get(p.root);
    if (!o) { projects.set(p.root, p); continue; }
    const had = new Map(o.sessions.map((s) => [s.id, s]));
    const take = p.sessions.filter((s) => !(partial.has(s.id) && had.has(s.id)));
    const ids = new Set(take.map((s) => s.id));
    o.sessions = [...take, ...o.sessions.filter((s) => !ids.has(s.id))].sort((a, b) => b.lastAt - a.lastAt);
  }
  return [...projects.values()].sort((a, b) => b.sessions[0].lastAt - a.sessions[0].lastAt);
}

/** A transcript changed on disk: read what it added, and put it in every window being read. */
export async function touch(file) {
  const meta = classifyTranscriptFile(file);
  if (!meta) return;
  let st;
  try { st = fs.statSync(file); } catch { return; }
  for (const l of loads.values()) {
    if (l.files.some((t) => t.file === file)) continue;
    l.files.unshift({ file, ...meta, mtime: st.mtimeMs, size: st.size });
    l.start.set(file, 0);
  }
  await readTranscript(file, meta.session, meta).catch(() => null);
}

/** The parse state of a session's own transcript, read up to now, for the answers to notes sent into it. */
export async function stateOf(sessionId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(sessionId)) return null;
  const codex = codexFiles(0, sessionId)[0];
  if (codex) return readTranscript(codex.file, sessionId, codex);
  const extra = extraHarnessFiles(0, sessionId)[0];
  if (extra) return readTranscript(extra.file, sessionId, extra);
  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(CLAUDE_PROJECTS, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return readTranscript(f, sessionId, { harness: "claude" });
  }
  return null;
}

export const isOpen = (sessionId) => openSessions().get(sessionId) || null;
