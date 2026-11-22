// Where Scout Canvas keeps its own things: the screens it lifted out of transcripts, and notes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.SCOUT_CANVAS_HOME || path.join(os.homedir(), ".scout-canvas");
export const IMG = path.join(HOME, "img");
export const NOTES = path.join(HOME, "notes.json");
export const CLAUDE_PROJECTS = process.env.SCOUT_CANVAS_CLAUDE_PROJECTS || path.join(os.homedir(), ".claude", "projects");
export const RUNTIME = process.env.SCOUT_RUNTIME_URL || "http://127.0.0.1:43110";
export const POINTERS = path.join(HOME, "pointers.json");

/** The scout command (Scout's CLI, from @openscout/scout), or null when Scout isn't installed. It
 * looks on PATH, then where Bun puts global packages, since a server started from elsewhere may not
 * have ~/.bun/bin on its PATH. */
export function findScout() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  const dirs = [...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin")];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, "scout");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}
