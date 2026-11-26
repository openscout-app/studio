// The canvas's contents: sessions and surfaces in the requested time window, grouped by repository.
// When Scout's runtime serves `scout.observed-surfaces/v1`, Studio consumes its first-principles
// surface inventory directly (`shown`, `captured`, `written`, `workspace`) with stacked revisions.
// When the runtime is offline or on an older build, Studio falls back seamlessly to its local
// multi-harness transcript and workspace scanner using the same provenance and revision model.
import { sharedInWindow } from "./shared-screens.mjs";
import { codexFiles } from "./codex.mjs";
import { antigravityBrainAssets, classifyTranscriptFile, extraHarnessFiles } from "./harnesses.mjs";
import { discoverWorkspaceArtifacts } from "./artifacts.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CLAUDE_PROJECTS, HOME } from "./paths.mjs";
import {
  deriveSurfaceSubject,
  extFromMedia,
  observedSurfaces,
  runtimeUrl,
  showsFor,
  surfaceScreenHash,
  viewOf,
  watchShows,
} from "./runtime.mjs";
import { readTranscript, sameShape, screensOf, stateOf as parsed, isWrapped } from "./transcripts.mjs";

/** a session that wrote in the last this-long is working, unless it said it was done */
const WORKING_MS = 90e3;

// ---- Scout's view of sessions: titles and attention, from the runtime's discovery
let discovery = { url: "", at: 0, up: false, byId: new Map() };
const FOLLOW = 24;
async function discover() {
  const url = runtimeUrl();
  if (discovery.url === url && Date.now() - discovery.at < 15e3) return discovery;
  const next = { url, at: Date.now(), up: false, byId: new Map() };
  try {
    const res = await fetch(`${url}/v1/tail/discover`, { signal: AbortSignal.timeout(5e3) });
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
      process.kill(r.pid, 0);
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

const branchCache = new Map();
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
  const curUrl = runtimeUrl();
  const was = loads.get(hours);
  if (was && was.url === curUrl && (!was.done || (was.files.length > 0 && Date.now() - was.endedAt < 10e3))) return was;
  let files = transcriptsSince(Date.now() - hours * 3600e3).sort((a, b) => b.mtime - a.mtime);
  if (hours > 72 && files.length > MAX_LONG_WINDOW_FILES) files = files.slice(0, MAX_LONG_WINDOW_FILES);
  const l = { url: curUrl, files, done: files.length === 0, endedAt: files.length === 0 ? Date.now() : 0, first: !was, start: new Map(files.map((t) => [t.file, parsed(t.file)?.offset || 0])) };
  loads.set(hours, l);
  if (files.length > 0) {
    (async () => {
      for (const t of files) await readTranscript(t.file, t.session, t).catch(() => null);
      l.done = true;
      l.endedAt = Date.now();
    })();
  }
  return l;
}

function pickSessionTitle(d, o, own, fallback) {
  return (
    [d?.customTitle, d?.aiTitle, d?.title, d?.harnessTitle, o?.name, d?.sessionName]
      .find((t) => t && !/^session-[a-z0-9]+-[a-z0-9]+/.test(t) && !isWrapped(t)) ||
    own?.prompt?.slice(0, 80) ||
    fallback
  );
}

/** Stack fallback Show/Screen revisions per `(projectRoot, subject.key)` to match `scout.observed-surfaces/v1`. */
function stackFallbackProjectRevisions(project) {
  const provenanceOrder = { workspace: 0, captured: 1, written: 2, shown: 3 };
  const entries = [];
  for (const session of project.sessions) {
    for (const sh of session.shows || []) {
      const subject = sh.subject || deriveSurfaceSubject({
        sourcePath: sh.path,
        projectRoot: project.root,
        kind: sh.view === "html" ? "html" : sh.view === "markdown" ? "markdown" : sh.view === "image" ? "screen" : "document",
      });
      sh.subject = subject;
      sh.provenance ||= "shown";
      entries.push({ kind: "show", ref: sh, key: subject.key, at: sh.at, prov: sh.provenance, sha: sh.sha256 || sh.id });
    }
    for (const sc of session.screens || []) {
      const subject = sc.subject && typeof sc.subject === "object"
        ? sc.subject
        : deriveSurfaceSubject({
            url: sc.url || undefined,
            sourcePath: sc.file || `${sc.hash}.${sc.ext}`,
            projectRoot: project.root,
            kind: "screen",
          });
      sc.subject = subject;
      sc.provenance ||= sc.tool === "workspace" ? "workspace" : "captured";
      entries.push({ kind: "screen", ref: sc, key: subject.key, at: sc.at, prov: sc.provenance, sha: sc.sha256 || sc.hash });
    }
  }
  const bySubject = new Map();
  for (const e of entries) {
    const list = bySubject.get(e.key);
    if (list) list.push(e);
    else bySubject.set(e.key, [e]);
  }
  for (const group of bySubject.values()) {
    group.sort((a, b) => a.at - b.at || (provenanceOrder[a.prov] ?? 0) - (provenanceOrder[b.prov] ?? 0));
    let rev = 0;
    let prevId = null;
    let prevSha = null;
    for (const e of group) {
      if (prevSha && e.sha === prevSha) {
        e.ref.revision = Math.max(e.ref.revision || 1, rev);
        continue;
      }
      rev = Math.max(rev + 1, e.ref.revision || 1, e.ref.versions || 1);
      e.ref.revision = rev;
      if (e.kind === "show") e.ref.versions = Math.max(e.ref.versions || 1, rev);
      if (prevId && !e.ref.supersedes) e.ref.supersedes = prevId;
      prevId = e.ref.id;
      prevSha = e.sha;
    }
  }
}

/** Build `projects` directly from `scout.observed-surfaces/v1` inventory items. */
function buildObservedProjects(inventory, since, bySession, disc, open) {
  const rawItems = (inventory.items || []).filter((item) => (item.createdAt || 0) >= since);

  // 1. Index all screen items in the inventory (including earlier revisions) so `supersedes` resolves `before`
  const screenById = new Map();
  for (const item of inventory.items || []) {
    if (item.kind !== "screen" || item.provenance === "shown") continue;
    screenById.set(item.id, {
      item,
      hash: surfaceScreenHash(item),
      ext: extFromMedia(item.mediaType, item.sourcePath),
      w: item.dimensions?.width || 1280,
      h: item.dimensions?.height || 800,
    });
  }

  // 2. Collapse non-screen (and `shown`) items per `(projectRoot, subject.key)` to latest revision
  const showGroups = new Map();
  const screenItems = [];
  for (const item of rawItems) {
    if (item.kind === "screen" && item.provenance !== "shown") {
      screenItems.push(item);
      continue;
    }
    const gKey = `${item.projectRoot || ""}\u0000${item.subject?.key || item.sourcePath || item.id}`;
    const list = showGroups.get(gKey);
    if (list) list.push(item);
    else showGroups.set(gKey, [item]);
  }

  const projects = new Map();
  const sessionBuckets = new Map(); // `${repoRoot}\u0000${sid}` -> bucket

  function ensureBucket(projectRoot, worktree, branch, sid, harness, provenance) {
    const repo = repoOf(projectRoot || worktree);
    const rootKey = repo.root || projectRoot || worktree;
    if (!projects.has(rootKey)) {
      projects.set(rootKey, { name: repo.name, root: rootKey, sessions: [] });
    }
    const bKey = `${rootKey}\u0000${sid}`;
    let bucket = sessionBuckets.get(bKey);
    if (!bucket) {
      bucket = {
        repo: projects.get(rootKey),
        sid,
        harness: harness || "scout",
        cwd: worktree || rootKey,
        branch: branch || "",
        provenance,
        screens: [],
        shows: [],
      };
      sessionBuckets.set(bKey, bucket);
    } else {
      if (!bucket.branch && branch) bucket.branch = branch;
      if (!bucket.cwd && worktree) bucket.cwd = worktree;
    }
    return bucket;
  }

  for (const item of screenItems) {
    const repo = repoOf(item.projectRoot || item.worktree);
    const sid = item.session?.nativeSessionId
      || (item.provenance === "workspace" ? `workspace:${repo.name}` : `captured:${repo.name}`);
    const harness = item.session?.harness || (item.provenance === "workspace" ? "scout" : "claude");
    const bucket = ensureBucket(item.projectRoot, item.worktree, item.branch, sid, harness, item.provenance);
    const cur = screenById.get(item.id) || {
      hash: surfaceScreenHash(item),
      ext: extFromMedia(item.mediaType, item.sourcePath),
      w: item.dimensions?.width || 1280,
      h: item.dimensions?.height || 800,
    };
    const prev = item.supersedes ? screenById.get(item.supersedes) : null;
    const before = prev && sameShape({ w: cur.w, h: cur.h }, { w: prev.w, h: prev.h })
      ? { hash: prev.hash, ext: prev.ext, at: prev.item.createdAt }
      : null;
    bucket.screens.push({
      id: `${sid}:${cur.hash}`,
      surfaceId: item.id,
      hash: cur.hash,
      ext: cur.ext,
      w: cur.w,
      h: cur.h,
      at: item.createdAt,
      tool: item.provenance === "workspace" ? "workspace" : (item.session?.harness || "captured"),
      url: item.url || null,
      file: item.sourcePath || null,
      caption: item.caption || item.title || "",
      before,
      open: false,
      provenance: item.provenance,
      revision: item.revision || 1,
      ...(item.supersedes ? { supersedes: item.supersedes } : {}),
      ...(item.subject ? { subject: item.subject } : {}),
    });
  }

  for (const group of showGroups.values()) {
    group.sort((a, b) => (a.revision || 1) - (b.revision || 1) || a.createdAt - b.createdAt);
    const latest = group[group.length - 1];
    const repo = repoOf(latest.projectRoot || latest.worktree);
    const sid = latest.session?.nativeSessionId
      || (latest.provenance === "workspace"
        ? `workspace:${repo.name}`
        : `shown:${latest.worktree || latest.projectRoot || repo.name}`);
    const harness = latest.session?.harness || "scout";
    const bucket = ensureBucket(latest.projectRoot, latest.worktree, latest.branch, sid, harness, latest.provenance);
    const sourcePath = latest.sourcePath || latest.subject?.label || latest.title || latest.id;
    const revision = Math.max(latest.revision || 1, group.length);
    const caption = latest.caption || (latest.title && latest.title !== path.basename(sourcePath) ? latest.title : "");
    bucket.shows.push({
      id: latest.id,
      itemId: latest.subject?.key || latest.id,
      sessionId: latest.session?.nativeSessionId || null,
      agentId: latest.agentId || latest.session?.harness || latest.provenance,
      harness: latest.session?.harness || null,
      projectRoot: latest.projectRoot || bucket.repo.root,
      worktree: latest.worktree || latest.projectRoot || bucket.repo.root,
      branch: latest.branch || bucket.branch || "",
      path: sourcePath,
      name: path.basename(sourcePath),
      view: viewOf({ ...latest, sourcePath }),
      mediaType: latest.mediaType,
      size: latest.byteSize,
      caption,
      at: latest.createdAt,
      versions: revision,
      provenance: latest.provenance,
      revision,
      ...(latest.supersedes ? { supersedes: latest.supersedes } : {}),
      ...(latest.subject ? { subject: latest.subject } : {}),
    });
  }

  for (const bucket of sessionBuckets.values()) {
    const rec = bySession.get(bucket.sid);
    const all = rec ? [rec.own, ...rec.parts].filter(Boolean) : [];
    const own = rec?.own || all[0] || null;
    const d = disc.byId.get(bucket.sid) || {};
    const o = open.get(bucket.sid);
    const cwd = own?.cwd || d.cwd || bucket.cwd || bucket.repo.root;
    const branch = bucket.branch || branchOf(cwd);

    // Deduplicate identical hashes inside a session while preserving revision order
    const seenScreenHashes = new Set();
    const screens = [];
    for (const sc of bucket.screens.sort((a, b) => a.at - b.at)) {
      if (seenScreenHashes.has(sc.hash)) continue;
      seenScreenHashes.add(sc.hash);
      screens.push(sc);
    }
    const shows = bucket.shows.sort((a, b) => b.at - a.at);
    if (!screens.length && !shows.length) continue;

    const allAt = [
      ...all.map((s) => s.lastAt || 0),
      ...screens.map((sc) => sc.at || 0),
      ...shows.map((sh) => sh.at || 0),
    ].filter((x) => x > 0);
    const lastAt = allAt.length ? Math.max(...allAt) : Date.now();
    const firstAt = own?.firstAt || (allAt.length ? Math.min(...allAt) : lastAt);
    const working = !!o && (o.status === "busy" || (Date.now() - lastAt < WORKING_MS && (!own || own.lastStop !== "end_turn" || own.openTools > 0)));

    const defaultTitle = bucket.sid.startsWith("workspace:")
      ? `Workspace · ${bucket.repo.name}`
      : bucket.sid.startsWith("shown:")
        ? `Shown from ${path.basename(cwd)}`
        : shows[0]?.caption || screens[0]?.caption || bucket.sid.slice(0, 8);

    bucket.repo.sessions.push({
      id: bucket.sid,
      harness: own?.harness || bucket.harness || d.source || "scout",
      cwd,
      branch,
      title: pickSessionTitle(d, o, own, defaultTitle),
      prompt: own?.prompt || "",
      firstAt,
      lastAt,
      open: !!o,
      working,
      attention: d.attention || d.waitingFor || null,
      now: all.map((s) => s.now).filter(Boolean).sort((a, b) => b.at - a.at)[0]?.text || null,
      screens,
      shows,
    });
  }

  // Merge portable `scout-studio share` screens so direct CLI/MCP shares remain visible alongside runtime surfaces
  for (const { id, screens } of sharedInWindow(since)) {
    const first = screens[0], repo = repoOf(first.cwd);
    if (!projects.has(repo.root)) projects.set(repo.root, { ...repo, sessions: [] });
    const group = projects.get(repo.root);
    let session = group.sessions.find((s) => s.id === id);
    if (!session) {
      session = {
        id,
        harness: first.harness,
        cwd: first.cwd,
        branch: branchOf(first.cwd),
        title: first.caption || `Screens from ${first.harness}`,
        prompt: "",
        firstAt: screens.at(-1).at,
        lastAt: first.at,
        open: false,
        working: false,
        now: null,
        attention: null,
        screens: [],
        shows: [],
      };
      group.sessions.push(session);
    }
    const seenHashes = new Set(session.screens.map((s) => s.hash));
    for (const sc of screens) {
      if (!seenHashes.has(sc.hash)) {
        session.screens.push({ ...sc, id: `${id}:${sc.hash}`, provenance: "captured", revision: 1 });
      }
    }
    session.screens.sort((a, b) => a.at - b.at);
    session.lastAt = Math.max(session.lastAt, first.at);
  }

  return [...projects.values()].filter((p) => p.sessions.length > 0);
}

/** What the canvas draws, for the last `hours`: what has been read so far, and how far along. */
export async function canvas(hours = 4) {
  const since = Date.now() - hours * 3600e3;
  const l = load(hours);
  const [disc, obs] = await Promise.all([discover(), observedSurfaces(hours * 3600e3)]);
  const open = openSessions();

  const bySession = new Map();
  let read = 0, total = 0;
  const partial = new Set();
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
  for (const item of obs.inventory?.items || []) {
    if (item.projectRoot) seen.set(item.projectRoot, Math.max(seen.get(item.projectRoot) || 0, item.createdAt || 0));
  }

  const latestFor = new Map();
  for (const [cwd, at] of seen) {
    const r = repoOf(cwd).root;
    if (r) latestFor.set(r, Math.max(latestFor.get(r) || 0, at));
  }
  const roots = [...latestFor].sort((a, b) => b[1] - a[1]).map(([r]) => r).slice(0, FOLLOW);
  const runtimeUp = disc.up || obs.reachable;

  if (obs.supported && obs.inventory) {
    watchShows(roots);
    const list = buildObservedProjects(obs.inventory, since, bySession, disc, open);
    for (const p of list) p.sessions.sort((a, b) => b.lastAt - a.lastAt);
    list.sort((a, b) => b.sessions[0].lastAt - a.sessions[0].lastAt);
    const sessionsCount = new Set([
      ...l.files.map((t) => t.session),
      ...list.flatMap((p) => p.sessions.map((s) => s.id)),
    ]).size;
    const out = {
      at: Date.now(),
      hours,
      scout: {
        up: true,
        observedSurfaces: true,
        url: runtimeUrl(),
        shows: obs.inventory.counts?.shown ?? list.flatMap((p) => p.sessions.flatMap((s) => s.shows)).filter((sh) => sh.provenance === "shown").length,
        counts: obs.inventory.counts,
      },
      projects: list,
      loading: { done: true, first: l.first, read: total, total, sessions: sessionsCount },
    };
    completed.add(hours);
    keepSnapshot(hours, out);
    return out;
  }

  // ---- Fallback path: runtime offline or older build without `/v1/observed-surfaces`
  const shows = runtimeUp ? (await showsFor(roots)).filter((sh) => sh.at >= since) : [];
  if (runtimeUp) watchShows(roots);
  const showsBy = new Map();
  for (const sh of shows) showsBy.set(sh.sessionId, [...(showsBy.get(sh.sessionId) || []), sh]);

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
          written.push({ ...sh, provenance: sh.provenance || "written" });
        }
      }
    }
    if (brain?.shows) {
      for (const sh of brain.shows) {
        if (!seenShowPaths.has(sh.path)) {
          seenShowPaths.add(sh.path);
          written.push({ ...sh, provenance: sh.provenance || "written" });
        }
      }
    }
    const runtimeShown = (showsBy.get(rec.id) || []).map((sh) => ({ ...sh, provenance: "shown" }));
    showsBy.delete(rec.id);
    for (const sh of runtimeShown) {
      seenShowPaths.add(sh.path);
      const priorWritten = written.find((w) => w.path === sh.path);
      if (priorWritten && priorWritten.sha256 && sh.sha256 && priorWritten.sha256 !== sh.sha256) {
        sh.revision = Math.max(sh.revision || 1, 2);
        sh.versions = Math.max(sh.versions || 1, 2);
        sh.supersedes ||= priorWritten.id;
      }
    }
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
      id: rec.id,
      harness: own.harness || d.source || "claude",
      cwd,
      branch,
      title: pickSessionTitle(d, o, own, rec.id.slice(0, 8)),
      prompt: own.prompt,
      firstAt: own.firstAt || lastAt,
      lastAt,
      open: !!o,
      working,
      attention: d.attention || d.waitingFor || null,
      now: all.map((s) => s.now).filter(Boolean).sort((a, b) => b.at - a.at)[0]?.text || null,
      screens: dedupScreens.map((sc) => ({
        id: `${rec.id}:${sc.hash}`,
        hash: sc.hash,
        ext: sc.ext,
        w: sc.w,
        h: sc.h,
        at: sc.at,
        tool: sc.tool,
        url: sc.url,
        file: sc.file,
        caption: sc.caption || "",
        before: sc.before || null,
        open: !!sc.open,
        provenance: sc.provenance || "captured",
        revision: sc.revision || (sc.before ? 2 : 1),
        ...(sc.supersedes ? { supersedes: sc.supersedes } : {}),
      })),
      shows: shown,
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(session);
  }

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
        hash: sc.hash,
        ext: sc.ext,
        w: sc.w,
        h: sc.h,
        at: sc.at,
        tool: sc.tool,
        url: sc.url,
        file: sc.file,
        caption: sc.caption || "",
        before: null,
        open: false,
        provenance: "captured",
        revision: sc.revision || 1,
      })),
      shows: brain.shows.map((sh) => ({ ...sh, provenance: sh.provenance || "written" })),
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(session);
  }

  for (const { id, screens } of sharedInWindow(since)) {
    const first = screens[0], repo = repoOf(first.cwd);
    if (!projects.has(repo.root)) projects.set(repo.root, { ...repo, sessions: [] });
    const group = projects.get(repo.root);
    let session = group.sessions.find((s) => s.id === id);
    if (!session) {
      session = {
        id,
        harness: first.harness,
        cwd: first.cwd,
        branch: branchOf(first.cwd),
        title: first.caption || `Screens from ${first.harness}`,
        prompt: "",
        firstAt: screens.at(-1).at,
        lastAt: first.at,
        open: false,
        working: false,
        now: null,
        attention: null,
        screens: [],
        shows: (showsBy.get(id) || []).map((sh) => ({ ...sh, provenance: "shown" })),
      };
      showsBy.delete(id);
      group.sessions.push(session);
    }
    const seenHashes = new Set(session.screens.map((s) => s.hash));
    for (const sc of screens) {
      if (!seenHashes.has(sc.hash)) {
        session.screens.push({ ...sc, id: `${id}:${sc.hash}`, provenance: "captured", revision: 1 });
      }
    }
    session.screens.sort((a, b) => a.at - b.at);
    session.lastAt = Math.max(session.lastAt, first.at);
  }

  for (const [sid, list] of showsBy) {
    const first = list[0], repo = repoOf(first.projectRoot);
    const session = {
      id: sid || `shown:${first.worktree}`,
      harness: first.harness || "scout",
      cwd: first.worktree,
      branch: first.branch,
      title: `Shown from ${path.basename(first.worktree)}`,
      prompt: "",
      firstAt: Math.min(...list.map((x) => x.at)),
      lastAt: Math.max(...list.map((x) => x.at)),
      open: false,
      working: false,
      attention: null,
      now: null,
      screens: [],
      shows: list.map((sh) => ({ ...sh, provenance: "shown" })),
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(session);
  }

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
    for (const sh of unclaimedShows) {
      sh.branch = branch || sh.branch;
      sh.provenance = "workspace";
    }
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
        hash: sc.hash,
        ext: sc.ext,
        w: sc.w,
        h: sc.h,
        at: sc.at,
        tool: sc.tool,
        url: null,
        file: sc.file,
        caption: sc.caption || "",
        before: null,
        open: false,
        provenance: "workspace",
        revision: sc.revision || 1,
      })),
      shows: unclaimedShows,
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(wsSession);
  }

  const list = [...projects.values()];
  for (const p of list) {
    stackFallbackProjectRevisions(p);
    p.sessions.sort((a, b) => b.lastAt - a.lastAt);
  }
  list.sort((a, b) => b.sessions[0].lastAt - a.sessions[0].lastAt);
  const sessions = new Set(l.files.map((t) => t.session)).size;
  const out = {
    at: Date.now(),
    hours,
    scout: { up: runtimeUp, observedSurfaces: false, url: runtimeUrl(), shows: shows.length },
    projects: list,
    loading: { done: l.done, first: l.first, read, total, sessions },
  };
  if (l.done) { completed.add(hours); keepSnapshot(hours, out); }
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
  return snapshots.get(hours)
    .map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.lastAt >= since).map((s) => ({ ...s, working: false, shows: s.shows || [] })) }))
    .filter((p) => p.sessions.length);
}
const savedAt = new Map();
function keepSnapshot(hours, out) {
  if (Date.now() - (savedAt.get(hours) || 0) < 30e3) return;
  savedAt.set(hours, Date.now());
  fs.mkdir(HOME, { recursive: true }, () => fs.writeFile(snapFile(hours), JSON.stringify({ at: out.at, projects: out.projects }), () => {}));
}
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
