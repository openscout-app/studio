// What an agent did last, in a few words, from one tool call or what it wrote. The wording follows
// Scout's canvas (scout-apps packages/web/server/canvas.ts, describe), so an agent reads the same in both.
import path from "node:path";

const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const bare = (url) => String(url || "").replace(/^https?:\/\//, "");

/** A tool call, in a few words. */
export function describe(name = "", input = {}) {
  const file = input.file_path || input.notebook_path || "";
  const base = file ? path.basename(file) : "";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name) && base) return `Edited ${base}`;
  if (name === "Read" && base) return `Read ${base}`;
  if (name === "Grep" || name === "Glob") return `Searched ${clip(input.pattern, 48)}`;
  if (name === "Bash") {
    // its own description reads best; else the command, less a leading cd
    return clip(input.description, 64) || clip(String(input.command || "").replace(/^cd\s+\S+\s*&&\s*/, ""), 64) || "Ran a command";
  }
  if (name === "Agent" || name === "Task") return `Started an agent: ${clip(input.description || input.subagent_type, 48)}`.replace(/: $/, "");
  if (name === "WebFetch" || name === "WebSearch") return `Looked up ${clip(bare(input.url || input.query), 40)}`;
  if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") return "Updated its tasks";
  if (/^mcp__\w+__browser_/.test(name)) {
    return clip(`${name.replace(/^mcp__\w+__browser_/, "Browser ").replace(/_/g, " ")} ${clip(bare(input.url), 40)}`, 64);
  }
  if (/^mcp__scout__(ask|reply|session_send|messages_)/.test(name)) return "Messaged an agent";
  return clip(name.replace(/^mcp__\w+__/, "").replace(/_/g, " "), 40) || "Working";
}

/** What it wrote between steps: its first line, as a person would glance at it. */
export function said(text) {
  const line = String(text || "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim()).find(Boolean) || "";
  return clip(line, 64);
}
