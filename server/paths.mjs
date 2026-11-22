// Where Scout Canvas keeps its own things: the screens it lifted out of transcripts, and notes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const HOME = process.env.SCOUT_CANVAS_HOME || path.join(os.homedir(), ".scout-canvas");
export const IMG = path.join(HOME, "img");
export const NOTES = path.join(HOME, "notes.json");
export const CLAUDE_PROJECTS = process.env.SCOUT_CANVAS_CLAUDE_PROJECTS || path.join(os.homedir(), ".claude", "projects");
export const RUNTIME = process.env.SCOUT_RUNTIME_URL || "http://127.0.0.1:43110";
export const POINTERS = path.join(HOME, "pointers.json");

/** The scout command (Scout's CLI, @openscout/scout). A Scout you installed yourself comes first, on
 * PATH or where Bun puts global packages; else the one Scout Canvas depends on. */
export function findScout() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  return onPath("scout") || bundledScout();
}
function bundledScout() {
  try { return path.join(path.dirname(createRequire(import.meta.url).resolve("@openscout/scout/package.json")), "bin", "scout"); } catch { return null; }
}
/** Where Bun is, for Scout's runtime, which runs on it */
export function findBun() {
  return (process.env.BUN_INSTALL && exe(path.join(process.env.BUN_INSTALL, "bin", "bun"))) || onPath("bun");
}
const exe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { return null; } };
function onPath(name) {
  const dirs = [...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin")];
  for (const d of dirs) {
    if (!d) continue;
    const p = exe(path.join(d, name));
    if (p) return p;
  }
  return null;
}
