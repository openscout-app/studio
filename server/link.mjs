// Links an agent can hand to a person: a session, one of its screens, a point on it, and what the
// agent wants to say about that point. The remark travels in the link's fragment, so it never
// reaches the server and stays in the person's browser.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS } from "./paths.mjs";
import { readTranscript, screensOf } from "./transcripts.mjs";

/** Claude Code keeps a project's transcripts in a folder named after its path. */
const folderOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The session to link: the one asked for, the one running this command, or the latest in this folder. */
export function findSession({ session, cwd = process.cwd(), env = process.env } = {}) {
  const id = session || env.CLAUDE_CODE_SESSION_ID;
  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch {}
  if (id) {
    for (const d of dirs) {
      const file = path.join(CLAUDE_PROJECTS, d, `${id}.jsonl`);
      if (fs.existsSync(file)) return { id, file };
    }
    return { id, file: null };
  }
  const dir = path.join(CLAUDE_PROJECTS, folderOf(cwd));
  let best = null;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith(".jsonl")) continue;
      const file = path.join(dir, n), m = fs.statSync(file).mtimeMs;
      if (!best || m > best.m) best = { id: n.slice(0, -6), file, m };
    }
  } catch {}
  return best && { id: best.id, file: best.file };
}

/** A session's screens as the canvas shows them, its subagents' included, newest first. */
export async function screensFor({ id, file }) {
  if (!file) return [];
  const files = [file];
  const sub = path.join(path.dirname(file), id, "subagents");
  try { for (const n of fs.readdirSync(sub)) if (n.endsWith(".jsonl")) files.push(path.join(sub, n)); } catch {}
  const all = [];
  for (const f of files) { const s = await readTranscript(f, id); if (s) all.push(...screensOf(s)); }
  return all.sort((a, b) => b.at - a.at);
}

/**
 * Pick a screen: "latest", a hash (or the start of one), a page address (or part of one), or an
 * image file the session read. Newest match wins.
 */
export function pickScreen(screens, which = "latest") {
  if (!screens.length) return null;
  if (!which || which === "latest") return screens[0];
  if (/^[0-9a-f]{4,16}$/.test(which)) { const s = screens.find((x) => x.hash.startsWith(which)); if (s) return s; }
  if (/^https?:\/\//.test(which) || /^[\w.-]+:\d+/.test(which)) {
    const s = screens.find((x) => x.url && (x.url === which || x.url.includes(which.replace(/^https?:\/\//, ""))));
    if (s) return s;
  }
  const abs = path.resolve(which);
  return screens.find((x) => x.file === abs) || screens.find((x) => x.file && path.basename(x.file) === path.basename(which)) || null;
}

/** A point as fractions of the screen: "0.4,0.3" as given, "640,380" as pixels of the screen. */
export function pointOf(at, screen) {
  if (!at) return null;
  const m = String(at).match(/^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/);
  if (!m) throw new Error(`--at takes x,y (fractions like 0.4,0.3 or pixels like 640,380), not "${at}"`);
  let x = Number(m[1]), y = Number(m[2]);
  if (x > 1 || y > 1) {
    if (!screen) throw new Error("--at in pixels needs a screen");
    x /= screen.w; y /= screen.h;
  }
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new Error(`--at ${at} falls outside the screen`);
  return { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4 };
}

/** The link itself. */
export function linkTo(base, { session, screen, point, say }) {
  let h = `#s/${session}`;
  if (screen) h += `/${screen.hash}`;
  const q = new URLSearchParams();
  if (screen && point) q.set("at", `${point.x},${point.y}`);
  if (say) q.set("say", say);
  const qs = q.toString().replace(/%2C/g, ",");
  return `${base}/${h}${qs ? `?${qs}` : ""}`;
}
