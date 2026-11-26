// Discovery and entry normalization across local coding-agent harnesses beyond Claude Code:
// Antigravity (CLI/IDE/Desktop brain transcripts + scratch/artifacts), Kimi (wire.jsonl), and
// secondary Codex session directories (~/.openai-codex/sessions).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_SESSIONS, codexFilesIn } from "./codex.mjs";
import { CLAUDE_PROJECTS, HOME } from "./paths.mjs";
import { allowedRootsFor, ingestImageFile, registerLocalShow } from "./artifacts.mjs";

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

export function antigravityBrainRoots() {
  if (process.env.SCOUT_STUDIO_ANTIGRAVITY_BRAIN) {
    return [process.env.SCOUT_STUDIO_ANTIGRAVITY_BRAIN];
  }
  const home = os.homedir();
  return [
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
  ];
}

export function kimiSessionRoots() {
  if (process.env.SCOUT_STUDIO_KIMI_SESSIONS) {
    return [process.env.SCOUT_STUDIO_KIMI_SESSIONS];
  }
  const home = os.homedir();
  const primary = path.join(process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code"), "sessions");
  return process.env.KIMI_CODE_HOME ? [primary] : [primary, path.join(home, ".kimi", "sessions")];
}

export function extraCodexRoots() {
  if (process.env.CODEX_HOME) return [];
  const alt = path.join(os.homedir(), ".openai-codex", "sessions");
  return alt !== CODEX_SESSIONS ? [alt] : [];
}

/** Existing harness directories on disk that live.mjs can fs.watch. */
export function watchableRoots() {
  const candidates = [
    CLAUDE_PROJECTS,
    CODEX_SESSIONS,
    ...extraCodexRoots(),
    ...antigravityBrainRoots(),
    ...kimiSessionRoots(),
    path.join(HOME, "shared-screens"),
  ];
  return [...new Set(candidates)].filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
}

/** Antigravity transcripts modified since `since` (or matching `targetSession`). */
export function antigravityFiles(since = 0, targetSession = null) {
  const out = [];
  for (const root of antigravityBrainRoots()) {
    for (const ent of entries(root)) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      if (targetSession && ent.name !== targetSession) continue;
      const brainDir = path.join(root, ent.name);
      const file = path.join(brainDir, ".system_generated", "logs", "transcript.jsonl");
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs >= since && st.size > 0) {
        out.push({
          file,
          session: ent.name,
          harness: "antigravity",
          brainDir,
          mtime: st.mtimeMs,
          size: st.size,
        });
      }
    }
  }
  return out;
}

function walkKimi(dir, since, targetSession, out = [], depth = 0) {
  if (depth > 5) return out;
  for (const ent of entries(dir)) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkKimi(full, since, targetSession, out, depth + 1);
    } else if (ent.isFile() && ent.name === "wire.jsonl") {
      const m = /sessions[\\/][^\\/]+[\\/]([^\\/]+)/.exec(full);
      const session = m?.[1] || path.basename(path.dirname(full));
      if (targetSession && session !== targetSession) continue;
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= since && st.size > 0) {
          out.push({ file: full, session, harness: "kimi", mtime: st.mtimeMs, size: st.size });
        }
      } catch {}
    }
  }
  return out;
}

export function kimiFiles(since = 0, targetSession = null) {
  const out = [];
  for (const root of kimiSessionRoots()) walkKimi(root, since, targetSession, out);
  return out;
}

export function extraHarnessFiles(since = 0, targetSession = null) {
  const out = [
    ...antigravityFiles(since, targetSession),
    ...kimiFiles(since, targetSession),
  ];
  for (const dir of extraCodexRoots()) {
    out.push(...codexFilesIn(dir, since, targetSession));
  }
  return out;
}

/** Direct screens (`scratch/`, `.user_uploaded/`) and markdown/HTML artifacts inside Antigravity brain dirs. */
export function antigravityBrainAssets(since, cwdBySession = new Map()) {
  const results = [];
  for (const root of antigravityBrainRoots()) {
    for (const ent of entries(root)) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const session = ent.name;
      const brainDir = path.join(root, session);
      const cwd = cwdBySession.get(session) || "";
      const allowed = allowedRootsFor(cwd, [brainDir]);
      if (!allowed.length) continue;

      const screens = [];
      for (const sub of ["scratch", ".user_uploaded"]) {
        const subDir = path.join(brainDir, sub);
        for (const f of entries(subDir)) {
          if (!f.isFile()) continue;
          const full = path.join(subDir, f.name);
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          if (st.mtimeMs < since) continue;
          const sc = ingestImageFile(full, brainDir, allowed, {
            at: Math.floor(st.mtimeMs),
            tool: sub === "scratch" ? "antigravity_scratch" : "user_upload",
            caption: f.name,
            open: false,
          });
          if (sc) screens.push(sc);
        }
      }

      const shows = [];
      for (const f of entries(brainDir)) {
        if (!f.isFile() || f.name.startsWith(".")) continue;
        const full = path.join(brainDir, f.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.mtimeMs < since) continue;
        const sh = registerLocalShow(full, cwd || brainDir, allowed, {
          sessionId: session,
          harness: "antigravity",
          projectRoot: cwd || brainDir,
          worktree: cwd || brainDir,
          at: Math.floor(st.mtimeMs),
          fromBrain: true,
        });
        if (sh) shows.push(sh);
      }

      if (screens.length || shows.length) {
        results.push({ session, brainDir, cwd, screens, shows });
      }
    }
  }
  return results;
}

function sniffWorkspaceText(text) {
  if (!text || typeof text !== "string") return "";
  const ws = /Active Workspaces:\s*\n\s*-\s*([^\r\n<]+)/i.exec(text);
  if (ws?.[1]?.trim()) return ws[1].trim();
  const cwd = /Command Working Directory:\s*([^\r\n<]+)/i.exec(text);
  if (cwd?.[1]?.trim()) return cwd[1].trim();
  return "";
}

function unwrapUserRequest(raw) {
  if (!raw || typeof raw !== "string") return "";
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  return (m ? m[1] : raw).trim();
}

export function antigravityEntry(raw) {
  const step = raw?.step || raw;
  if (!step || typeof step !== "object") return null;
  const type = String(step.type || "");
  const timestamp = step.metadata?.createdAt || raw.timestamp || "";
  let cwd = "";
  const uri = step.userInput?.activeUserState?.activeDocument?.workspaceUri;
  if (typeof uri === "string" && uri.startsWith("file://")) {
    try { cwd = decodeURIComponent(new URL(uri).pathname); } catch {}
  }

  if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
    const rawPrompt = String(step.userInput?.userResponse ?? step.content ?? "");
    if (!cwd) cwd = sniffWorkspaceText(rawPrompt);
    const text = unwrapUserRequest(rawPrompt);
    if (!text) return cwd ? { timestamp, cwd } : null;
    return { timestamp, cwd, type: "user", message: { content: [{ type: "text", text }] } };
  }

  if (type === "PLANNER_RESPONSE" || type.endsWith("_PLANNER_RESPONSE")) {
    const pr = step.plannerResponse || {};
    const calls = pr.toolCalls || step.tool_calls || [];
    const content = [];
    const reply = String(pr.modifiedResponse ?? pr.response ?? (typeof step.content === "string" ? step.content : "")).trim();
    if (reply) content.push({ type: "text", text: reply });
    for (const tc of calls) {
      let args = tc.arguments || tc.args || {};
      if (typeof tc.argumentsJson === "string") {
        try { args = JSON.parse(tc.argumentsJson); } catch {}
      }
      const id = tc.id || tc.callId || `agy_${content.length}`;
      const name = tc.name || tc.tool_name || "tool";
      content.push({ type: "tool_use", id, name, input: args || {} });
      const hint = args?.Path || args?.TargetFile;
      if (!cwd && typeof hint === "string" && hint.startsWith("/")) {
        const dev = /^(\/(?:Users|home)\/[^/]+\/dev\/[^/]+)/.exec(hint);
        if (dev?.[1]) cwd = dev[1];
      }
    }
    return {
      timestamp,
      cwd,
      turnEnded: calls.length === 0,
      type: "assistant",
      message: { stop_reason: calls.length ? "tool_use" : "end_turn", content },
    };
  }

  if (step.runCommand?.combinedOutput?.full || step.runCommand?.commandLine) {
    const out = String(step.runCommand?.combinedOutput?.full || "");
    const cmd = String(step.runCommand?.commandLine || "");
    if (!cwd && step.runCommand?.cwd) cwd = step.runCommand.cwd;
    const callId = step.metadata?.toolCallId || "agy_cmd";
    return {
      timestamp,
      cwd,
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: callId, content: [{ type: "text", text: `${cmd}\n${out}` }] }],
      },
    };
  }

  return cwd ? { timestamp, cwd } : null;
}

export function kimiEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const timestamp = raw.timestamp || raw.created_at || "";
  if (raw.type === "turn.prompt") {
    const text = typeof raw.input === "string" ? raw.input : typeof raw.content === "string" ? raw.content : "";
    return text ? { timestamp, cwd: raw.cwd || "", type: "user", message: { content: [{ type: "text", text }] } } : null;
  }
  if (raw.type === "context.append_loop_event" && raw.event) {
    const ev = raw.event;
    if (ev.type === "tool.call") {
      let input = ev.args ?? ev.input ?? {};
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = { command: input }; } }
      return {
        timestamp,
        type: "assistant",
        message: { content: [{ type: "tool_use", id: ev.id || "kimi_tc", name: ev.name || "tool", input }] },
      };
    }
    if (ev.part?.text) {
      return {
        timestamp,
        type: "assistant",
        message: { content: [{ type: "text", text: String(ev.part.text) }] },
      };
    }
  }
  if (raw.type === "turn.end") return { timestamp, turnEnded: true };
  return null;
}

/** Identify which harness owns an arbitrary transcript path on disk. */
export function classifyTranscriptFile(file) {
  if (file.startsWith(CLAUDE_PROJECTS + path.sep)) {
    const rel = path.relative(CLAUDE_PROJECTS, file).split(path.sep);
    if (rel.length === 2 && rel[1].endsWith(".jsonl")) {
      return { session: rel[1].slice(0, -6), harness: "claude", subagent: false };
    }
    if (rel.length === 4 && rel[2] === "subagents" && rel[3].endsWith(".jsonl")) {
      return { session: rel[1], harness: "claude", subagent: true };
    }
  }
  const codexUuid = file.match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  if (codexUuid) return { session: codexUuid, harness: "codex", subagent: false };
  const brainMatch = /brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/.exec(file);
  if (brainMatch?.[1]) {
    return {
      session: brainMatch[1],
      harness: "antigravity",
      subagent: false,
      brainDir: file.slice(0, file.indexOf(`${path.sep}.system_generated`)),
    };
  }
  if (file.endsWith(`${path.sep}wire.jsonl`)) {
    const m = /sessions[\\/][^\\/]+[\\/]([^\\/]+)/.exec(file);
    return { session: m?.[1] || path.basename(path.dirname(file)), harness: "kimi", subagent: false };
  }
  return null;
}
