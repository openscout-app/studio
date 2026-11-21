// Which session and which of its screens an agent means: the session from CLAUDE_CODE_SESSION_ID
// (or the latest in a folder), its screens as the canvas shows them, and one picked from those.
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
