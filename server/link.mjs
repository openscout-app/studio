// Resolve a session and its screens by their exact identifiers.
import { sharedScreens } from "./shared-screens.mjs";
import { codexFiles } from "./codex.mjs";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS } from "./paths.mjs";
import { readTranscript, screensOf } from "./transcripts.mjs";

/** An exact session ID can belong to a Claude transcript, a Codex rollout or a shared screen. */
export function findSession({ session: id }) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(id)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch {}
  for (const d of dirs) {
    const file = path.join(CLAUDE_PROJECTS, d, `${id}.jsonl`);
    if (fs.existsSync(file)) return { id, file };
  }
  const codex = codexFiles(0, id)[0];
  return { id, file: codex?.file || null };
}

/** A session's screens as the canvas shows them, its subagents' included, newest first. */
export async function screensFor({ id, file }) {
  const shared = sharedScreens(id);
  if (!file) return shared;
  const files = [file];
  const sub = path.join(path.dirname(file), id, "subagents");
  try { for (const n of fs.readdirSync(sub)) if (n.endsWith(".jsonl")) files.push(path.join(sub, n)); } catch {}
  const all = [...shared];
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
