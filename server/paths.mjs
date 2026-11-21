// Where Scout Canvas keeps its own things: the screens it lifted out of transcripts, and notes.
import os from "node:os";
import path from "node:path";

export const HOME = process.env.SCOUT_CANVAS_HOME || path.join(os.homedir(), ".scout-canvas");
export const IMG = path.join(HOME, "img");
export const NOTES = path.join(HOME, "notes.json");
export const CLAUDE_PROJECTS = process.env.SCOUT_CANVAS_CLAUDE_PROJECTS || path.join(os.homedir(), ".claude", "projects");
export const RUNTIME = process.env.SCOUT_RUNTIME_URL || "http://127.0.0.1:43110";
