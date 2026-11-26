import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import crypto from "node:crypto";
const require$1 = createRequire(import.meta.url);
const DEFAULT_WINDOW_MS = 14 * 24 * 36e5;
const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
function homeDir() {
  return process.env.SCOUT_SESSIONS_HOME || process.env.HOME || os.homedir();
}
function runtimeUrl$1() {
  const explicit = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(homeDir(), ".openscout", "config.json"), "utf8"));
    if (cfg?.port) return `http://127.0.0.1:${cfg.port}`;
  } catch {
  }
  return "http://127.0.0.1:43110";
}
function scoutBin$1() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  try {
    const pkg = require$1.resolve("@openscout/scout/package.json");
    const candidate = path.join(path.dirname(pkg), "bin", "scout");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
  }
  const which = spawnSync("which", ["scout"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
function findBun() {
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
async function checkRuntime(base = runtimeUrl$1()) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    return res.ok;
  } catch {
    return false;
  }
}
function runScoutSetup(packageName = "@openscout/scout") {
  const bin2 = scoutBin$1();
  const bun = findBun();
  if (!bin2) throw new Error(`Scout CLI not found. Reinstall ${packageName}.`);
  if (!bun) throw new Error("Bun 1.4.4+ is required to run Scout's background runtime (https://bun.sh).");
  const env = { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` };
  execFileSync(bin2, ["setup"], { stdio: "pipe", env, timeout: 3e4 });
}
function isSyntheticPromptRecord(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^# AGENTS\.md instructions\b/i.test(trimmed)) return true;
  if (/^<environment_context>/i.test(trimmed) && !trimmed.includes("</environment_context>\n")) return true;
  if (/^The following is a <SYSTEM_MESSAGE>/i.test(trimmed)) return true;
  if (/<command-name>\s*\/(?:clear|compact|login|logout|status|help)\s*<\/command-name>/i.test(trimmed)) return true;
  return false;
}
function stripPromptEnvelope(raw) {
  if (!raw) return "";
  if (isSyntheticPromptRecord(raw)) return "";
  const userReq = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const picked = userReq ? userReq[1] : raw;
  return picked.replace(/<(ADDITIONAL_METADATA|CONTEXT_SUMMARY|SYSTEM_MESSAGE|INSTRUCTIONS|environment_context|system-reminder|system_reminder|local-command-caveat|recommended_plugins|command-name|command-message|command-args)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ").replace(/<\/?pasted_content\b[^>]*>/gi, " ").replace(/^New (?:broker|runtime) ask from [^\n]+?\.\s*(?:Task:\s*)?/i, "").replace(/<\/?[A-Z_]{4,}>/g, " ").replace(/<truncated \d+ (?:bytes|lines)>/gi, "").replace(/\s+/g, " ").trim();
}
function summarizeHumanTitle(raw, maxLen = 110) {
  if (!raw) return null;
  const cleaned = stripPromptEnvelope(raw).replace(/^#+\s*/, "").replace(/^[>*-\s]+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
  if (!cleaned) return null;
  const firstSentence = cleaned.split(/\n/)[0]?.trim() || cleaned;
  return firstSentence.length <= maxLen ? firstSentence : `${firstSentence.slice(0, maxLen - 1).trimEnd()}…`;
}
function sniffWorkspaceFromPathHint(candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath.startsWith("/")) return null;
  const devMatch = /^(\/(?:Users|home)\/[^/]+\/dev\/[^/]+)/.exec(candidatePath);
  if (devMatch?.[1]) return devMatch[1];
  const parts = candidatePath.split("/").filter(Boolean);
  if (parts.length >= 4 && (parts[0] === "Users" || parts[0] === "home") && !parts[2]?.startsWith(".")) {
    return `/${parts.slice(0, 4).join("/")}`;
  }
  return null;
}
function sniffWorkspaceFromText(text) {
  const activeMatch = /Active Workspaces:\s*\n\s*-\s*([^\r\n<]+)/i.exec(text);
  if (activeMatch?.[1]?.trim()) return activeMatch[1].trim();
  const cwdMatch = /Command Working Directory:\s*([^\r\n<]+)/i.exec(text);
  if (cwdMatch?.[1]?.trim()) return cwdMatch[1].trim();
  return null;
}
function walkJsonl(dir, maxDepth, windowMs, filter, out = [], depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries2 = [];
  try {
    entries2 = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const entry of entries2) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, maxDepth, windowMs, filter, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (filter && !filter(full, entry.name)) continue;
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs <= windowMs && st.size > 0) {
          out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
      }
    }
  }
  return out;
}
function readSlice(filePath, start2, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const clampedStart = Math.max(0, Math.min(start2, size));
    const clampedLen = Math.max(0, Math.min(length, size - clampedStart));
    if (clampedLen === 0) return "";
    const buf = Buffer.alloc(clampedLen);
    fs.readSync(fd, buf, 0, clampedLen, clampedStart);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const rec = item;
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.input_text === "string") return rec.input_text;
        if (typeof rec.output_text === "string") return rec.output_text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
function looksLikeUuid(value) {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
}
function sniffTranscriptMeta(filePath, source, size) {
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = null;
  let branch = null;
  let model = null;
  let firstPrompt = null;
  let latestPrompt = null;
  if (source === "antigravity") {
    const brainMatch = /brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i.exec(filePath) || /brain[\\/]([\da-f-]{36})[\\/]/i.exec(filePath);
    if (brainMatch?.[1]) sessionId = brainMatch[1];
  } else if (source === "kimi") {
    const kimiMatch = /sessions[\\/][^\\/]+[\\/]([^\\/]+)[\\/]agents/i.exec(filePath);
    if (kimiMatch?.[1]) sessionId = kimiMatch[1];
  }
  const fileSize = size ?? (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  const head = readSlice(filePath, 0, 48e3);
  const tail = fileSize > 48e3 ? readSlice(filePath, Math.max(0, fileSize - 48e3), 48e3) : "";
  const lines = [...head.split("\n").slice(0, 30), ...tail ? tail.split("\n").slice(1) : []];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && !branch) branch = obj.gitBranch;
    if (source === "claude") {
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      if (typeof obj.message?.model === "string") model = obj.message.model;
      if (obj.type === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "codex") {
      if (obj.type === "session_meta" && obj.payload) {
        if (typeof obj.payload.id === "string") sessionId = obj.payload.id;
        if (typeof obj.payload.cwd === "string" && !cwd) cwd = obj.payload.cwd;
        if (typeof obj.payload.git?.branch === "string" && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && typeof obj.payload?.model === "string") model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      } else if (obj.type === "event_msg" && obj.payload?.type === "user_message") {
        const txt = stripPromptEnvelope(String(obj.payload.message ?? obj.payload.text ?? ""));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "antigravity") {
      const step2 = obj.step || obj;
      const type = String(step2.type || "");
      if (typeof step2.metadata?.generatorModel === "string") model = step2.metadata.generatorModel;
      if (typeof step2.model === "string" && !model) model = step2.model;
      const ws = step2.userInput?.activeUserState?.activeDocument?.workspaceUri;
      if (typeof ws === "string" && ws.startsWith("file://") && !cwd) {
        cwd = decodeURIComponent(ws.slice("file://".length));
      }
      if (!cwd && typeof step2.content === "string") {
        cwd = sniffWorkspaceFromText(step2.content);
      }
      const rawCalls = step2.plannerResponse?.toolCalls || step2.tool_calls || [];
      if (!cwd && Array.isArray(rawCalls)) {
        for (const call of rawCalls) {
          let args = call?.args || call?.arguments || {};
          if (typeof call?.argumentsJson === "string") {
            try {
              args = JSON.parse(call.argumentsJson);
            } catch {
            }
          }
          cwd = sniffWorkspaceFromPathHint(args?.Path || args?.TargetFile);
          if (cwd) break;
        }
      }
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const rawPrompt = String(step2.userInput?.userResponse ?? step2.content ?? "");
        if (!cwd) cwd = sniffWorkspaceFromText(rawPrompt);
        const txt = stripPromptEnvelope(rawPrompt);
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "kimi") {
      if (obj.type === "turn.prompt") {
        const txt = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    }
  }
  let project = "session";
  if (cwd) {
    project = path.basename(cwd);
  } else if (source === "claude") {
    const dirName = path.basename(path.dirname(filePath));
    project = dirName.replace(/^-/, "").split("-").pop() || "claude";
  } else if (source === "kimi") {
    const wdMatch = /sessions[\\/]wd_([^\\/]+)[\\/]/i.exec(filePath);
    project = wdMatch?.[1] || "kimi";
  } else if (!looksLikeUuid(sessionId)) {
    project = sessionId;
  } else {
    project = source === "antigravity" ? "Antigravity" : source;
  }
  const title = summarizeHumanTitle(latestPrompt || firstPrompt);
  return { sessionId, cwd, project, branch, model, title };
}
const transcriptDiscoveryCache = /* @__PURE__ */ new Map();
function discoverLocalTranscripts(options = {}) {
  const home = homeDir();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPerHarness = options.maxPerHarness ?? 40;
  const filterHarness = options.harness || "";
  const cacheKey = `${home}|${windowMs}|${maxPerHarness}|${filterHarness}|${process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT || ""}|${process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || ""}`;
  const cached = !options.bypassCache ? transcriptDiscoveryCache.get(cacheKey) : void 0;
  if (cached && Date.now() - cached.at < 2500) {
    return cached.items;
  }
  const claudeRoot = process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || path.join(home, ".claude", "projects");
  const codexRoot = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || path.join(home, ".codex", "sessions");
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code");
  const kimiRoot = process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || path.join(kimiHome, "sessions");
  const agyBrainOverride = process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT;
  const brainFilter = (full, name) => name === "transcript.jsonl" && full.includes(`${path.sep}.system_generated${path.sep}logs${path.sep}`);
  const sources = [
    { source: "claude", files: walkJsonl(claudeRoot, 3, windowMs) },
    {
      source: "codex",
      files: [
        ...walkJsonl(codexRoot, 4, windowMs),
        ...process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".openai-codex", "sessions"), 4, windowMs)
      ]
    },
    {
      source: "antigravity",
      files: [
        ...agyBrainOverride ? walkJsonl(agyBrainOverride, 4, windowMs, brainFilter) : [
          ...walkJsonl(path.join(home, ".gemini", "antigravity-cli", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity-ide", "brain"), 4, windowMs, brainFilter)
        ],
        ...walkJsonl(path.join(home, ".gemini", "antigravity", "conversations"), 2, windowMs)
      ]
    },
    {
      source: "kimi",
      files: [
        ...walkJsonl(kimiRoot, 5, windowMs, (_full, name) => name === "wire.jsonl"),
        ...process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".kimi", "sessions"), 5, windowMs)
      ]
    }
  ];
  const seenPaths = /* @__PURE__ */ new Set();
  const transcripts = [];
  for (const group of sources) {
    if (filterHarness && group.source !== filterHarness) continue;
    const recent = group.files.sort((a, b2) => b2.mtimeMs - a.mtimeMs).slice(0, maxPerHarness);
    for (const item of recent) {
      if (seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      try {
        const meta = sniffTranscriptMeta(item.path, group.source, item.size);
        transcripts.push({
          source: group.source,
          sessionId: meta.sessionId,
          project: meta.project,
          cwd: meta.cwd,
          branch: meta.branch,
          model: meta.model,
          title: meta.title,
          transcriptPath: item.path,
          mtimeMs: Math.floor(item.mtimeMs),
          size: item.size
        });
      } catch {
      }
    }
  }
  const sorted = transcripts.sort((a, b2) => b2.mtimeMs - a.mtimeMs);
  transcriptDiscoveryCache.set(cacheKey, { at: Date.now(), items: sorted });
  return sorted;
}
function collectPrs(text, prsMap, fallbackTitle) {
  if (!text || typeof text !== "string") return;
  const mergedHint = /\bmerged\b/i.test(text);
  for (const match of text.matchAll(PR_URL_RE)) {
    const [, owner, repo, num] = match;
    const key2 = `${repo}#${num}`;
    const prev = prsMap.get(key2);
    prsMap.set(key2, {
      key: key2,
      label: key2,
      number: Number(num),
      url: `https://github.com/${owner}/${repo}/pull/${num}`,
      title: prev?.title || fallbackTitle || key2,
      state: prev?.state === "merged" || mergedHint ? "merged" : "open"
    });
  }
}
function recordTouchedPath(rawPath, cwd, set) {
  if (!rawPath || typeof rawPath !== "string") return;
  const cleaned = rawPath.trim();
  if (!cleaned) return;
  if (cwd && cleaned.startsWith(cwd)) {
    const rel = cleaned.slice(cwd.length).replace(/^[\\/]+/, "");
    if (rel) {
      set.add(rel);
      return;
    }
  }
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  set.add(parts.slice(-3).join("/") || cleaned);
}
function scanLocalFeedSessions(options = {}) {
  const discovered = discoverLocalTranscripts({ maxPerHarness: options.maxPerHarness ?? 15 });
  const items = [];
  for (const entry of discovered) {
    try {
      const raw = readSlice(entry.transcriptPath, Math.max(0, entry.size - 65536), 65536);
      const lines = raw.split("\n").filter(Boolean);
      let prompt = entry.title;
      let reply = null;
      let branch = entry.branch;
      const touched = /* @__PURE__ */ new Set();
      const prsMap = /* @__PURE__ */ new Map();
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.source === "claude") {
          if (obj.gitBranch && !branch) branch = obj.gitBranch;
          if (obj.type === "user") {
            const txt = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
            if (txt) prompt = txt;
            if (Array.isArray(obj.message?.content)) {
              for (const b2 of obj.message.content) {
                if (b2?.type === "tool_result" && typeof b2.content === "string") collectPrs(b2.content, prsMap, null);
              }
            }
          } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
            const text = obj.message.content.filter((b2) => b2?.type === "text" && b2.text).map((b2) => b2.text).join("\n").trim();
            if (text) {
              reply = text;
              collectPrs(text, prsMap, null);
            }
            for (const b2 of obj.message.content) {
              if (b2?.type === "tool_use" && b2.input && (b2.name === "Edit" || b2.name === "Write" || b2.name === "MultiEdit")) {
                recordTouchedPath(b2.input.file_path || b2.input.path, entry.cwd, touched);
              }
            }
          }
        } else if (entry.source === "codex") {
          if (obj.type === "session_meta" && obj.payload?.git?.branch) branch = obj.payload.git.branch;
          if (obj.type === "response_item" && obj.payload?.role === "user") {
            const txt = stripPromptEnvelope(flattenContent(obj.payload.content));
            if (txt) prompt = txt;
          } else if (obj.type === "response_item" && obj.payload?.role === "assistant") {
            const txt = flattenContent(obj.payload.content).trim();
            if (txt) {
              reply = txt;
              collectPrs(txt, prsMap, null);
            }
          } else if (obj.type === "response_item" && (obj.payload?.type === "custom_tool_call" || obj.payload?.type === "function_call")) {
            const patchText = typeof obj.payload?.input === "string" ? obj.payload.input : obj.payload?.arguments || "";
            for (const pm of String(patchText).matchAll(/\*\*\* (?:Update|Add) File:\s*([^\r\n]+)/g)) {
              recordTouchedPath(pm[1], entry.cwd, touched);
            }
          } else if (obj.type === "response_item" && obj.payload?.type === "function_call_output") {
            collectPrs(obj.payload.output, prsMap, null);
          }
        } else if (entry.source === "antigravity") {
          const step2 = obj.step || obj;
          const type = String(step2.type || "");
          if (type.endsWith("USER_INPUT")) {
            const txt = stripPromptEnvelope(String(step2.userInput?.userResponse ?? step2.content ?? ""));
            if (txt) prompt = txt;
          } else if (type.endsWith("PLANNER_RESPONSE")) {
            const text = String(step2.plannerResponse?.modifiedResponse ?? step2.plannerResponse?.response ?? step2.content ?? "").trim();
            if (text) {
              reply = text;
              collectPrs(text, prsMap, null);
            }
            for (const tc of step2.plannerResponse?.toolCalls || []) {
              if (tc.name === "edit_file" || tc.name === "write_file") {
                let args = tc.argumentsJson;
                if (typeof args === "string") {
                  try {
                    args = JSON.parse(args);
                  } catch {
                    args = null;
                  }
                }
                if (args?.Path) recordTouchedPath(args.Path, entry.cwd, touched);
              }
            }
          }
          if (step2.runCommand?.combinedOutput?.full) {
            collectPrs(step2.runCommand.combinedOutput.full, prsMap, null);
          }
        } else if (entry.source === "kimi") {
          if (obj.type === "turn.prompt") {
            const txt = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
            if (txt) prompt = txt;
          } else if (obj.type === "context.append_loop_event" && obj.event?.part?.text) {
            reply = obj.event.part.text;
            collectPrs(reply, prsMap, null);
          }
        }
      }
      if (!reply && !prompt) continue;
      const cleanReply = (reply || prompt || "").trim();
      const firstLine = cleanReply.split("\n").find((l) => l.trim().length > 0)?.replace(/^#+\s*/, "").trim() || "Completed session turn";
      const headline = firstLine.slice(0, 140);
      const prs = [...prsMap.values()].map((pr) => ({
        ...pr,
        title: pr.title === pr.key ? headline : pr.title
      }));
      items.push({
        id: `local:session:${entry.source}:${entry.sessionId}`,
        sessionId: entry.sessionId,
        source: entry.source,
        project: entry.project.startsWith(".") || entry.project === "logs" || entry.project === "main" ? null : entry.project,
        cwd: entry.cwd,
        branch,
        title: headline,
        asked: prompt ? prompt.trim().slice(0, 280) : null,
        body: cleanReply.slice(0, 2400),
        filesTouched: [...touched],
        prs,
        at: entry.mtimeMs,
        transcriptPath: entry.transcriptPath
      });
    } catch {
    }
  }
  return items.sort((a, b2) => b2.at - a.at).slice(0, options.limit ?? 30);
}
function parseSessionObserve(transcript) {
  const content = fs.readFileSync(transcript.transcriptPath, "utf8");
  const allLines = content.split("\n");
  const startIdx = Math.max(0, allLines.length - 1600);
  const events2 = [];
  let model = transcript.model ?? null;
  let branch = transcript.branch ?? null;
  let cwd = transcript.cwd ?? null;
  let seq = 0;
  for (let i = startIdx; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line?.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || obj.created_at || obj.step?.metadata?.createdAt || "") || transcript.mtimeMs;
    if (transcript.source === "claude") {
      if (obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.gitBranch && !branch) branch = obj.gitBranch;
      if (obj.message?.model) model = obj.message.model;
      if (obj.type === "user") {
        const text = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (text) events2.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "text" && block.text) {
            events2.push({ id: `ev-${++seq}`, kind: "message", text: block.text, ts, recordIndex: i });
          } else if (block?.type === "tool_use") {
            const pathVal = block.input?.file_path || block.input?.path || void 0;
            const arg = block.input?.command || pathVal || block.input?.pattern || "";
            events2.push({
              id: `ev-${++seq}`,
              kind: "tool",
              tool: block.name || "tool",
              arg: String(arg),
              ...pathVal ? { path: String(pathVal) } : {},
              text: `${block.name || "tool"} ${arg}`.trim(),
              ts,
              recordIndex: i
            });
          }
        }
      }
    } else if (transcript.source === "codex") {
      if (obj.type === "session_meta") {
        if (obj.payload?.cwd && !cwd) cwd = obj.payload.cwd;
        if (obj.payload?.git?.branch && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && obj.payload?.model) model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const text = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (text) events2.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "response_item" && obj.payload?.role === "assistant") {
        const text = flattenContent(obj.payload.content).trim();
        if (text) events2.push({ id: `ev-${++seq}`, kind: "message", text, ts, recordIndex: i });
      } else if (obj.type === "response_item" && (obj.payload?.type === "function_call" || obj.payload?.type === "local_shell_call")) {
        let arg = String(obj.payload.arguments || obj.payload.command || "");
        try {
          const parsed = JSON.parse(arg);
          arg = parsed.cmd || parsed.command || (Array.isArray(parsed.command) ? parsed.command.join(" ") : arg);
        } catch {
        }
        events2.push({
          id: `ev-${++seq}`,
          kind: "tool",
          tool: obj.payload.name || "shell",
          arg: String(arg).slice(0, 220),
          text: `${obj.payload.name || "shell"} ${String(arg).slice(0, 220)}`.trim(),
          ts,
          recordIndex: i
        });
      }
    } else if (transcript.source === "antigravity") {
      const step2 = obj.step || obj;
      const type = String(step2.type || "");
      if (step2.metadata?.generatorModel) model = step2.metadata.generatorModel;
      if (typeof step2.model === "string") model = step2.model;
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const text = stripPromptEnvelope(String(step2.userInput?.userResponse ?? step2.content ?? ""));
        if (text) events2.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (type === "PLANNER_RESPONSE" || type.endsWith("_PLANNER_RESPONSE")) {
        const pr = step2.plannerResponse;
        const calls = pr?.toolCalls || step2.tool_calls || [];
        for (const call of calls) {
          let args = {};
          try {
            args = typeof call.argumentsJson === "string" ? JSON.parse(call.argumentsJson) : call.arguments || call.args || {};
          } catch {
          }
          const toolName = call.name || call.tool_name || "tool";
          const pathVal = args.Path || args.TargetFile || null;
          if (!cwd && pathVal) cwd = sniffWorkspaceFromPathHint(pathVal);
          const arg = args.CommandLine || pathVal || args.query || args.toolSummary || toolName;
          events2.push({
            id: `ev-${++seq}`,
            kind: "tool",
            tool: toolName,
            arg: String(arg),
            ...pathVal ? { path: String(pathVal) } : {},
            text: `${toolName} ${arg}`.trim(),
            ts,
            recordIndex: i
          });
        }
        const reply = pr?.modifiedResponse || pr?.response || (typeof step2.content === "string" ? step2.content : "");
        if (reply) events2.push({ id: `ev-${++seq}`, kind: "message", text: reply, ts, recordIndex: i });
      }
    } else if (transcript.source === "kimi") {
      if (obj.type === "turn.prompt") {
        const text = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (text) events2.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "context.append_loop_event") {
        const ev = obj.event;
        if (ev?.type === "tool.call") {
          const arg = typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args ?? ev.input ?? {}).slice(0, 180);
          events2.push({ id: `ev-${++seq}`, kind: "tool", tool: ev.name || "tool", arg, text: `${ev.name || "tool"} ${arg}`.trim(), ts, recordIndex: i });
        } else if (ev?.part?.text) {
          events2.push({ id: `ev-${++seq}`, kind: "message", text: String(ev.part.text), ts, recordIndex: i });
        }
      }
    }
  }
  return {
    live: Date.now() - transcript.mtimeMs < 6e4,
    events: events2,
    files: [],
    metadata: {
      session: {
        adapterType: transcript.source,
        cwd,
        externalSessionId: transcript.sessionId || path.basename(transcript.transcriptPath, ".jsonl"),
        ...model ? { model } : {},
        ...branch ? { branch } : {},
        ...transcript.title ? { title: transcript.title } : {}
      }
    }
  };
}
async function resolveSessionObserve(requestedId) {
  const cleaned = requestedId.replace(/^session:[^:]+:/, "");
  let hit = discoverLocalTranscripts({ maxPerHarness: 80 }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  ) ?? discoverLocalTranscripts({ maxPerHarness: 80, bypassCache: true }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  );
  if (!hit) {
    const base = runtimeUrl$1();
    if (await checkRuntime(base)) {
      try {
        const res = await fetch(`${base}/v1/tail/discover`, {
          signal: AbortSignal.timeout(2500),
          redirect: "error"
        });
        if (res.ok) {
          const snap = await res.json();
          const rtHit = (snap?.transcripts || []).find(
            (t) => t.sessionId === cleaned || typeof t.transcriptPath === "string" && t.transcriptPath.includes(cleaned)
          );
          if (rtHit && typeof rtHit.transcriptPath === "string" && fs.existsSync(rtHit.transcriptPath)) {
            const st = fs.statSync(rtHit.transcriptPath);
            const meta = sniffTranscriptMeta(rtHit.transcriptPath, rtHit.source || "claude", st.size);
            hit = {
              source: rtHit.source || "claude",
              sessionId: rtHit.sessionId || meta.sessionId,
              project: rtHit.project || meta.project,
              cwd: rtHit.cwd || meta.cwd,
              branch: meta.branch,
              model: meta.model,
              title: meta.title,
              transcriptPath: rtHit.transcriptPath,
              mtimeMs: Math.floor(st.mtimeMs),
              size: st.size
            };
          }
        }
      } catch {
      }
    }
  }
  if (!hit || !fs.existsSync(hit.transcriptPath)) return null;
  const data = parseSessionObserve(hit);
  return {
    kind: "observe",
    refId: hit.sessionId,
    observe: {
      kind: "history",
      refId: hit.sessionId,
      sessionId: hit.sessionId,
      source: hit.source,
      project: hit.project,
      fidelity: "timestamped",
      updatedAt: hit.mtimeMs,
      data
    }
  };
}
function readTranscriptContextWindow(params) {
  const home = homeDir();
  let filePath = null;
  if (params.source) {
    const candidate = params.source.startsWith("~/") ? path.join(home, params.source.slice(2)) : params.source;
    if (fs.existsSync(candidate) && candidate.endsWith(".jsonl")) filePath = candidate;
  }
  const local2 = discoverLocalTranscripts({ maxPerHarness: 80 });
  const hit = local2.find(
    (t) => filePath && t.transcriptPath === filePath || params.sessionId && (t.sessionId === params.sessionId || t.transcriptPath.includes(params.sessionId))
  );
  if (!hit && !filePath) return null;
  const targetPath = hit?.transcriptPath ?? filePath;
  const harness = hit?.source ?? (targetPath.includes(".claude") ? "claude" : targetPath.includes("antigravity") ? "antigravity" : targetPath.includes("kimi") ? "kimi" : "codex");
  const st = fs.statSync(targetPath);
  const meta = hit ?? { ...sniffTranscriptMeta(targetPath, harness, st.size), source: harness, transcriptPath: targetPath, mtimeMs: st.mtimeMs, size: st.size };
  const parsed = parseSessionObserve(meta);
  const center = params.centerRecord ?? -1;
  const radius = params.radius ?? 3;
  let matchPos = parsed.events.findIndex((e) => e.recordIndex === center);
  if (matchPos < 0 && center >= 0) {
    matchPos = parsed.events.reduce((best, ev, idx) => {
      if (ev.recordIndex == null) return best;
      if (best < 0) return idx;
      const prevDiff = Math.abs((parsed.events[best]?.recordIndex ?? 0) - center);
      return Math.abs(ev.recordIndex - center) < prevDiff ? idx : best;
    }, -1);
  }
  const sliceStart = matchPos >= 0 ? Math.max(0, matchPos - radius) : Math.max(0, parsed.events.length - (radius * 2 + 1));
  const sliceEnd = matchPos >= 0 ? Math.min(parsed.events.length, matchPos + radius + 1) : parsed.events.length;
  const turns = parsed.events.slice(sliceStart, sliceEnd).map((ev, idx) => ({
    index: ev.recordIndex ?? sliceStart + idx,
    role: ev.kind === "prompt" ? "prompt" : ev.kind === "tool" ? "tool" : "reply",
    label: ev.kind === "prompt" ? "You" : ev.kind === "tool" ? ev.tool || "Tool" : "Agent",
    text: ev.kind === "tool" ? ev.arg || ev.text : ev.text,
    matched: matchPos >= 0 ? sliceStart + idx === matchPos : false
  }));
  return {
    sessionId: meta.sessionId,
    project: meta.project,
    harness: meta.source,
    title: meta.title,
    turns
  };
}
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
function isLoopbackHost(req) {
  return LOCAL_HOST.test(req.headers.host || "");
}
function isLocalRequest$1(req) {
  const host = req.headers.host || "";
  if (!isLoopbackHost(req)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}
async function readJsonBody(req, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}
function createScoutThinHttpHandler(options) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  return async function handleThinApi(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) return false;
    if (!isLocalRequest$1(req)) {
      sendJson(res, 403, { error: `Open ${title} on this host.` });
      return true;
    }
    const runtimeBase = runtimeUrl$1();
    if (req.method === "GET" && pathname === "/api/identity") {
      sendJson(res, 200, { app: options.packageName, product: options.product });
      return true;
    }
    if (options.apiHandler) {
      const handled = await options.apiHandler(req, res, { url, pathname, runtimeBase });
      if (handled) return true;
    }
    if (req.method === "GET" && pathname === "/api/status") {
      const runtimeUp = await checkRuntime(runtimeBase);
      const extra = options.getStatus ? await options.getStatus({ runtimeUp, runtimeUrl: runtimeBase }) : {};
      sendJson(res, 200, { runtimeUp, runtimeUrl: runtimeBase, ...extra });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/setup") {
      try {
        runScoutSetup(options.packageName);
        sendJson(res, 200, { ok: true, runtimeUp: await checkRuntime(runtimeBase) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (req.method === "GET" && (pathname === "/v1/events/stream" || pathname === "/v1/tail/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive"
      });
      res.write(": connected\n\n");
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 2e4);
      req.on("close", () => clearInterval(keepAlive));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/recent-sessions") {
      const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit") ?? 8)));
      const sessions = discoverLocalTranscripts({ maxPerHarness: 15 }).slice(0, limit).map((item) => ({
        sessionId: item.sessionId,
        harness: item.source,
        project: item.project,
        branch: item.branch,
        model: item.model,
        title: item.title,
        updatedAt: item.mtimeMs
      }));
      sendJson(res, 200, { sessions });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/session-context") {
      try {
        const body2 = await readJsonBody(req);
        const context = readTranscriptContextWindow(body2);
        if (!context) {
          sendJson(res, 404, { error: "Session transcript not found." });
          return true;
        }
        sendJson(res, 200, context);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    const refMatch = /^\/api\/session-ref\/(.+)$/.exec(pathname);
    if (req.method === "GET" && refMatch?.[1]) {
      const resolved = await resolveSessionObserve(decodeURIComponent(refMatch[1]));
      if (!resolved) {
        sendJson(res, 404, { error: "Session transcript not found." });
        return true;
      }
      sendJson(res, 200, resolved);
      return true;
    }
    if (req.method === "GET" && pathname === "/api/messages") {
      const conversationId = url.searchParams.get("conversationId") || "";
      if (conversationId && await checkRuntime(runtimeBase)) {
        try {
          const upstream = await fetch(`${runtimeBase}/v1/messages?conversationId=${encodeURIComponent(conversationId)}&limit=50`, {
            signal: AbortSignal.timeout(3e3),
            redirect: "error"
          });
          if (upstream.ok) {
            const data = await upstream.json();
            sendJson(res, 200, Array.isArray(data) ? data : data.messages || []);
            return true;
          }
        } catch {
        }
      }
      sendJson(res, 200, []);
      return true;
    }
    sendJson(res, 404, { error: `Unknown ${title} API route.` });
    return true;
  };
}
const NEW_HOME = path.join(process.env.OPENSCOUT_HOME || path.join(os.homedir(), ".openscout"), ".studio");
const OLD_HOMES = [".scout-studio", ".scout-canvas"].map((d) => path.join(os.homedir(), d));
const HOME = process.env.SCOUT_STUDIO_HOME || process.env.SCOUT_CANVAS_HOME || (fs.existsSync(NEW_HOME) ? NEW_HOME : OLD_HOMES.find((d) => fs.existsSync(d)) || NEW_HOME);
const IMG = path.join(HOME, "img");
const NOTES = path.join(HOME, "notes.json");
const CLAUDE_PROJECTS = process.env.SCOUT_STUDIO_CLAUDE_PROJECTS || process.env.SCOUT_CANVAS_CLAUDE_PROJECTS || path.join(os.homedir(), ".claude", "projects");
const POINTERS = path.join(HOME, "pointers.json");
function findScout() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  return onPath("scout") || bundledScout();
}
function bundledScout() {
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve("@openscout/scout/package.json")), "bin", "scout");
  } catch {
    return null;
  }
}
const exe = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {
    return null;
  }
};
function onPath(name) {
  const dirs = [...(process.env.PATH || "").split(":"), path.join(os.homedir(), ".bun", "bin"), path.join(os.homedir(), ".local", "bin")];
  for (const d of dirs) {
    if (!d) continue;
    const p = exe(path.join(d, name));
    if (p) return p;
  }
  return null;
}
const CODEX_SESSIONS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const uuid = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
function entries$1(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
const known$1 = /* @__PURE__ */ new Map();
function codexFilesIn(rootDir, since = 0, thread = null) {
  if (thread && !uuid.test("-" + thread + ".jsonl")) return [];
  const cached = thread && known$1.get(thread);
  if (cached && fs.existsSync(cached.file)) return [cached];
  const out = [];
  for (const y2 of entries$1(rootDir)) {
    if (!y2.isDirectory() || !/^\d{4}$/.test(y2.name)) continue;
    for (const m2 of entries$1(path.join(rootDir, y2.name))) {
      if (!m2.isDirectory() || !/^\d{2}$/.test(m2.name)) continue;
      for (const d of entries$1(path.join(rootDir, y2.name, m2.name))) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        const dir = path.join(rootDir, y2.name, m2.name, d.name);
        for (const ent of entries$1(dir)) {
          const id = ent.name.match(uuid)?.[1];
          if (!id || !ent.isFile() || thread && id !== thread) continue;
          const file = path.join(dir, ent.name);
          let st;
          try {
            st = fs.statSync(file);
          } catch {
            continue;
          }
          const record = { file, session: id, harness: "codex", mtime: st.mtimeMs, size: st.size };
          known$1.set(id, record);
          if (st.mtimeMs >= since) out.push(record);
          if (thread) return out;
        }
      }
    }
  }
  return out;
}
function codexFiles(since = 0, thread = null) {
  return codexFilesIn(CODEX_SESSIONS, since, thread);
}
function codexEntry(entry) {
  const p = entry.payload || {}, timestamp = entry.timestamp;
  if (entry.type === "session_meta" || entry.type === "turn_context") return { timestamp, cwd: p.cwd };
  if (entry.type === "event_msg" && p.type === "task_complete") return { timestamp, turnEnded: true };
  if (entry.type !== "response_item") return null;
  if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
    const content2 = (Array.isArray(p.content) ? p.content : []).filter((b2) => ["input_text", "output_text"].includes(b2.type)).map((b2) => ({ type: "text", text: b2.text }));
    return { timestamp, type: p.role, message: { content: content2 } };
  }
  if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
    let input = {};
    if (typeof p.arguments === "string") {
      try {
        input = JSON.parse(p.arguments || "{}") || {};
      } catch {
        input = { raw: p.arguments };
      }
    } else if (typeof p.input === "string") {
      input = { patch: p.input };
    } else if (Array.isArray(p.command)) {
      input = { command: p.command.join(" ") };
    } else if (typeof p.command === "string") {
      input = { command: p.command };
    }
    return {
      timestamp,
      type: "assistant",
      message: { content: [{ type: "tool_use", id: p.call_id || "codex_tc", name: p.name || "shell", input, rawPatch: typeof p.input === "string" ? p.input : "" }] }
    };
  }
  if (p.type !== "function_call_output" && p.type !== "custom_tool_call_output") return null;
  const content = [];
  if (typeof p.output === "string") {
    content.push({ type: "text", text: p.output });
  } else {
    for (const b2 of Array.isArray(p.output) ? p.output : []) {
      if (b2.type === "input_text" || b2.type === "text") content.push({ type: "text", text: b2.text });
      const uri = b2.image_url?.url || b2.image_url;
      const match = typeof uri === "string" && uri.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,/);
      if (match) content.push({ type: "image", source: { type: "base64", media_type: match[1], data: uri.slice(match[0].length) } });
    }
  }
  return { timestamp, type: "user", message: { content: [{ type: "tool_result", tool_use_id: p.call_id || "codex_tc", content }] } };
}
function imageSize(b2) {
  if (!b2 || b2.length < 24) return null;
  if (b2.readUInt32BE(0) === 2303741511) return { w: b2.readUInt32BE(16), h: b2.readUInt32BE(20) };
  if (b2.toString("ascii", 0, 3) === "GIF") return { w: b2.readUInt16LE(6), h: b2.readUInt16LE(8) };
  if (b2.toString("ascii", 0, 4) === "RIFF" && b2.toString("ascii", 8, 12) === "WEBP") {
    const kind = b2.toString("ascii", 12, 16);
    if (kind === "VP8X" && b2.length >= 30) return { w: 1 + b2.readUIntLE(24, 3), h: 1 + b2.readUIntLE(27, 3) };
    if (kind === "VP8L" && b2.length >= 25) {
      const v2 = b2.readUInt32LE(21);
      return { w: 1 + (v2 & 16383), h: 1 + (v2 >> 14 & 16383) };
    }
    if (kind === "VP8 " && b2.length >= 30) return { w: b2.readUInt16LE(26) & 16383, h: b2.readUInt16LE(28) & 16383 };
    return null;
  }
  if (b2[0] === 255 && b2[1] === 216) {
    let i = 2;
    while (i + 9 < b2.length) {
      if (b2[i] !== 255) {
        i++;
        continue;
      }
      const marker = b2[i + 1];
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
        i += 2;
        continue;
      }
      const len = b2.readUInt16BE(i + 2);
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) return { w: b2.readUInt16BE(i + 7), h: b2.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}
function runtimeUrl() {
  const env = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (env) return env.replace(/\/$/, "");
  try {
    const home = process.env.OPENSCOUT_HOME || path.join(os.homedir(), ".openscout");
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    const port = Number(c?.ports?.broker);
    if (Number.isInteger(port) && port > 0) {
      const host = !c.host || c.host === "0.0.0.0" || c.host === "::" ? "127.0.0.1" : c.host;
      return `http://${host}:${port}`;
    }
  } catch {
  }
  return "http://127.0.0.1:43110";
}
const MD = /\.(md|markdown|mdx)$/i;
const HTML = /\.html?$/i;
function viewOf(show) {
  const p = show.sourcePath || show.path || "";
  if (show.kind === "image" || show.kind === "screen" || show.kind === "svg" || show.mediaType === "image/svg+xml") return "image";
  if (show.kind === "video") return "video";
  if (show.kind === "markdown" || MD.test(p) || show.mediaType === "text/markdown") return "markdown";
  if (show.kind === "html" || HTML.test(p) || show.mediaType === "text/html") return "html";
  if (show.kind === "pdf" || show.mediaType === "application/pdf") return "pdf";
  if (/^text\/|json|xml|yaml|toml/.test(show.mediaType || "")) return "text";
  return "file";
}
function extFromMedia(mediaType = "", sourcePath = "") {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/png") return "png";
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "jpg";
  if (ext === ".webp") return "webp";
  if (ext === ".gif") return "gif";
  return "png";
}
function surfaceScreenHash(item) {
  const hex = typeof item.sha256 === "string" && /^[0-9a-f]{16,}/i.test(item.sha256) ? item.sha256.toLowerCase() : crypto.createHash("sha256").update(String(item.id || item.sourcePath || "")).digest("hex");
  return hex.slice(0, 16);
}
function deriveSurfaceSubject(input = {}) {
  if (input.url) {
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
        const label = `${parsed.host}${normalizedPath}`;
        return { key: `page:${label}`, kind: "page", label };
      }
    } catch {
    }
  }
  if (input.windowId !== void 0 && input.windowId !== null && String(input.windowId).length > 0) {
    return { key: `window:${input.windowId}`, kind: "window", label: `Window ${input.windowId}` };
  }
  const rawPath = input.sourcePath || "untitled";
  const projectRoot = input.projectRoot || "";
  const rel = path.isAbsolute(rawPath) && projectRoot && rawPath.startsWith(projectRoot + path.sep) ? path.relative(projectRoot, rawPath).split(path.sep).join("/") : path.basename(rawPath);
  if (input.kind === "screen") {
    const dir = path.posix.dirname(rel);
    const ext = path.posix.extname(rel);
    const rawStem = path.posix.basename(rel, ext);
    const cleanStem = rawStem.replace(/([-_. ]?(?:before|after|old|new|v?\d+))+$/i, "") || rawStem;
    const normalized = dir === "." ? cleanStem : `${dir}/${cleanStem}`;
    return { key: `file:${normalized}`, kind: "file", label: normalized };
  }
  return { key: `file:${rel}`, kind: "file", label: rel };
}
let activeUrl = "";
const listed = /* @__PURE__ */ new Map();
const known = /* @__PURE__ */ new Map();
const observedShows = /* @__PURE__ */ new Map();
const surfaceScreens = /* @__PURE__ */ new Map();
const observedCache = /* @__PURE__ */ new Map();
const observedInflight = /* @__PURE__ */ new Map();
let observedSupport = { state: "unknown", at: 0 };
let globalShowsSupport = "unknown";
let globalEventsSupport = "unknown";
const wantedRoots = /* @__PURE__ */ new Set();
let globalFollowing = false;
let globalConnected = false;
let globalAbort = null;
const following = /* @__PURE__ */ new Map();
const reconnectTimers = /* @__PURE__ */ new Set();
const listeners$1 = /* @__PURE__ */ new Set();
function syncRuntimeUrl() {
  const cur = runtimeUrl();
  if (cur !== activeUrl) {
    stopWatchShows();
    activeUrl = cur;
    listed.clear();
    known.clear();
    observedShows.clear();
    surfaceScreens.clear();
    observedCache.clear();
    observedInflight.clear();
    wantedRoots.clear();
    observedSupport = { state: "unknown", at: 0 };
    globalShowsSupport = "unknown";
    globalEventsSupport = "unknown";
  }
  return cur;
}
async function fetchRuntime(pathname, ms = 5e3) {
  const base = syncRuntimeUrl();
  return fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(ms) });
}
async function getOk(pathname, ms = 5e3) {
  const res = await fetchRuntime(pathname, ms);
  if (!res.ok) {
    const err = new Error(`${pathname}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}
function indexObservedItems(items) {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.kind === "screen" && item.provenance !== "shown") {
      const hash = surfaceScreenHash(item);
      const ext = extFromMedia(item.mediaType, item.sourcePath);
      surfaceScreens.set(hash, {
        id: item.id,
        showId: item.showId || null,
        ext,
        mediaType: item.mediaType || `image/${ext === "jpg" ? "jpeg" : ext}`
      });
    }
    const sourcePath = item.sourcePath || item.subject?.label || item.title || item.id;
    const record = {
      id: item.id,
      showId: item.showId || null,
      sourcePath,
      path: sourcePath,
      name: path.basename(sourcePath),
      kind: item.kind,
      view: viewOf({ ...item, sourcePath }),
      mediaType: item.mediaType || "application/octet-stream",
      createdAt: item.createdAt || Date.now(),
      provenance: item.provenance || "shown",
      local: item.provenance !== "shown"
    };
    observedShows.set(item.id, record);
    if (item.showId) observedShows.set(item.showId, record);
  }
}
async function observedSurfaces(windowMs = 4 * 36e5) {
  syncRuntimeUrl();
  const key2 = Math.max(6e4, Math.round(windowMs));
  if (observedSupport.state === "unsupported" && Date.now() - observedSupport.at < 1e4) {
    return { reachable: true, supported: false, inventory: null };
  }
  const hit = observedCache.get(key2);
  if (hit && Date.now() - hit.at < 400) return hit.result;
  if (observedInflight.has(key2)) return observedInflight.get(key2);
  const task = (async () => {
    let res;
    try {
      res = await fetchRuntime(`/v1/observed-surfaces?windowMs=${key2}`, 6e3);
    } catch {
      return { reachable: false, supported: false, inventory: null };
    }
    if (res.status === 404 || res.status === 400 || res.status === 501) {
      observedSupport = { state: "unsupported", at: Date.now() };
      return { reachable: true, supported: false, inventory: null };
    }
    if (!res.ok) {
      return { reachable: true, supported: false, inventory: null };
    }
    let body2 = null;
    try {
      body2 = await res.json();
    } catch {
    }
    if (body2?.schema !== "scout.observed-surfaces/v1" || !Array.isArray(body2.items)) {
      observedSupport = { state: "unsupported", at: Date.now() };
      return { reachable: true, supported: false, inventory: null };
    }
    observedSupport = { state: "supported", at: Date.now() };
    indexObservedItems(body2.items);
    const result = { reachable: true, supported: true, inventory: body2 };
    observedCache.set(key2, { at: Date.now(), result });
    return result;
  })().finally(() => observedInflight.delete(key2));
  observedInflight.set(key2, task);
  return task;
}
const observedShowById = (id) => observedShows.get(id) || null;
async function observedShowBytes(id) {
  const rec = observedShows.get(id);
  const surfaceId = rec?.id || id;
  try {
    const res = await getOk(`/v1/observed-surfaces/${encodeURIComponent(surfaceId)}/bytes`, 2e4);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (rec?.showId) {
      const res = await getOk(`/v1/shows/${encodeURIComponent(rec.showId)}/bytes`, 2e4);
      return Buffer.from(await res.arrayBuffer());
    }
    throw err;
  }
}
async function materializeRuntimeScreen(hash, ext) {
  syncRuntimeUrl();
  const out = path.join(IMG, `${hash}.${ext}`);
  if (fs.existsSync(out)) return out;
  const src = surfaceScreens.get(hash);
  if (!src) return null;
  let bytes = null;
  try {
    const res = await getOk(`/v1/observed-surfaces/${encodeURIComponent(src.id)}/bytes`, 2e4);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    if (src.showId) {
      try {
        const res = await getOk(`/v1/shows/${encodeURIComponent(src.showId)}/bytes`, 2e4);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch {
      }
    }
  }
  if (!bytes || !imageSize(bytes)) return null;
  fs.mkdirSync(IMG, { recursive: true });
  const tmp = `${out}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, out);
    return out;
  } catch {
    fs.rmSync(tmp, { force: true });
    return null;
  }
}
async function showsFor(roots) {
  syncRuntimeUrl();
  const out = [];
  let usedGlobal = false;
  if (globalShowsSupport !== "unsupported") {
    const globalHit = listed.get("*");
    if (globalHit && Date.now() - globalHit.at < (globalConnected ? 3e5 : 4e3)) {
      out.push(...globalHit.shows);
      usedGlobal = true;
    } else {
      try {
        const res = await fetchRuntime("/v1/shows");
        if (res.ok) {
          const shows = (await res.json()).shows || [];
          globalShowsSupport = "supported";
          listed.set("*", { at: Date.now(), shows });
          out.push(...shows);
          usedGlobal = true;
        } else if (res.status === 400 || res.status === 404) {
          globalShowsSupport = "unsupported";
        }
      } catch {
      }
    }
  }
  if (!usedGlobal) {
    await Promise.all([...new Set(roots.filter(Boolean))].map(async (root2) => {
      const hit = listed.get(root2);
      if (hit && Date.now() - hit.at < (following.has(root2) ? 3e5 : 4e3)) {
        out.push(...hit.shows);
        return;
      }
      let shows = [];
      try {
        shows = (await (await getOk(`/v1/shows?projectRoot=${encodeURIComponent(root2)}`)).json()).shows || [];
      } catch {
      }
      listed.set(root2, { at: Date.now(), shows });
      out.push(...shows);
    }));
  }
  const all = [...new Map(out.map((s) => [s.id, s])).values()];
  const byItem = /* @__PURE__ */ new Map();
  for (const s of all) {
    known.set(s.id, s);
    const list = byItem.get(s.itemId);
    if (list) list.push(s);
    else byItem.set(s.itemId, [s]);
  }
  const latestList = [];
  for (const group of byItem.values()) {
    group.sort((a, b2) => a.createdAt - b2.createdAt || String(a.id).localeCompare(String(b2.id)));
    const s = group[group.length - 1];
    const prev = group.length > 1 ? group[group.length - 2] : null;
    const view = viewOf(s);
    const surfaceKind = view === "image" ? "screen" : view === "html" ? "html" : view === "markdown" ? "markdown" : view === "pdf" ? "pdf" : view === "video" ? "video" : "document";
    latestList.push({
      id: s.id,
      itemId: s.itemId,
      sessionId: s.sessionId || null,
      agentId: s.agentId,
      harness: s.harness || null,
      projectRoot: s.projectRoot,
      worktree: s.worktree,
      branch: s.branch || "",
      path: s.sourcePath,
      name: path.basename(s.sourcePath),
      view,
      mediaType: s.mediaType,
      size: s.byteSize,
      caption: s.caption || "",
      at: s.createdAt,
      versions: group.length,
      provenance: "shown",
      revision: group.length,
      ...prev ? { supersedes: prev.id } : {},
      subject: deriveSurfaceSubject({ sourcePath: s.sourcePath, projectRoot: s.projectRoot, kind: surfaceKind })
    });
  }
  return latestList.sort((a, b2) => b2.at - a.at);
}
const showById = (id) => known.get(id) || null;
function onShows(fn) {
  listeners$1.add(fn);
  return () => listeners$1.delete(fn);
}
function stopWatchShows() {
  globalFollowing = false;
  globalConnected = false;
  if (globalAbort) {
    try {
      globalAbort.abort();
    } catch {
    }
    globalAbort = null;
  }
  for (const ac of following.values()) {
    try {
      ac.abort();
    } catch {
    }
  }
  following.clear();
  for (const t of reconnectTimers) clearTimeout(t);
  reconnectTimers.clear();
}
function scheduleReconnect(fn, delayMs) {
  const t = setTimeout(() => {
    reconnectTimers.delete(t);
    fn();
  }, delayMs);
  t.unref?.();
  reconnectTimers.add(t);
}
function watchShows(roots = []) {
  syncRuntimeUrl();
  for (const root2 of roots) if (root2) wantedRoots.add(root2);
  if (globalEventsSupport === "unsupported") {
    for (const root2 of wantedRoots) {
      if (!following.has(root2)) followRoot(root2, 0);
    }
    return;
  }
  if (!globalFollowing) {
    globalFollowing = true;
    followGlobal(0);
  }
}
async function followGlobal(failures) {
  const urlAtStart = syncRuntimeUrl();
  const ac = new AbortController();
  globalAbort = ac;
  let opened = false;
  try {
    const res = await fetch(`${urlAtStart}/v1/shows/events?since=${Date.now()}`, { signal: ac.signal });
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
    if (res.status === 400) {
      globalEventsSupport = "unsupported";
      globalFollowing = false;
      globalConnected = false;
      globalAbort = null;
      for (const root2 of wantedRoots) {
        if (!following.has(root2)) followRoot(root2, 0);
      }
      return;
    }
    if (!res.ok || !res.body) throw new Error(String(res.status));
    globalEventsSupport = "supported";
    globalConnected = true;
    opened = true;
    if (failures) {
      listed.clear();
      observedCache.clear();
      for (const fn of listeners$1) fn("*");
    }
    const text = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      if (urlAtStart !== activeUrl || ac.signal.aborted) return;
      buf += text.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^event:\s*show\.created$/m.test(block)) {
          let projectRoot = "*";
          const dataLine = /^data:\s*(.+)$/m.exec(block)?.[1];
          if (dataLine) {
            try {
              projectRoot = JSON.parse(dataLine)?.projectRoot || "*";
            } catch {
            }
          }
          listed.delete("*");
          if (projectRoot !== "*") listed.delete(projectRoot);
          else listed.clear();
          observedCache.clear();
          for (const fn of listeners$1) fn(projectRoot);
        }
      }
    }
  } catch {
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
  } finally {
    if (globalAbort === ac) globalConnected = false;
  }
  if (!globalFollowing || urlAtStart !== activeUrl || ac.signal.aborted) return;
  const n = opened ? 1 : failures + 1;
  scheduleReconnect(() => followGlobal(n), Math.min(6e4, 2e3 * 2 ** Math.min(n, 5)));
}
async function followRoot(root2, failures) {
  const urlAtStart = syncRuntimeUrl();
  const ac = new AbortController();
  following.set(root2, ac);
  let opened = false;
  try {
    const res = await fetch(`${urlAtStart}/v1/shows/events?projectRoot=${encodeURIComponent(root2)}&since=${Date.now()}`, { signal: ac.signal });
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
    if (!res.ok || !res.body) throw new Error(String(res.status));
    opened = true;
    if (failures) {
      listed.delete(root2);
      observedCache.clear();
      for (const fn of listeners$1) fn(root2);
    }
    const text = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      if (urlAtStart !== activeUrl || ac.signal.aborted) return;
      buf += text.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^event:\s*show\.created$/m.test(block)) {
          listed.delete(root2);
          observedCache.clear();
          for (const fn of listeners$1) fn(root2);
        }
      }
    }
  } catch {
    if (urlAtStart !== activeUrl || ac.signal.aborted) return;
  }
  if (!following.has(root2) || urlAtStart !== activeUrl || ac.signal.aborted) return;
  const n = opened ? 1 : failures + 1;
  scheduleReconnect(() => followRoot(root2, n), Math.min(6e4, 2e3 * 2 ** Math.min(n, 5)));
}
async function showBytes(id) {
  const res = await getOk(`/v1/shows/${encodeURIComponent(id)}/bytes`, 2e4);
  return Buffer.from(await res.arrayBuffer());
}
function M() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var O = M();
function G(u3) {
  O = u3;
}
var _ = { exec: () => null };
function k(u3, e = "") {
  let t = typeof u3 == "string" ? u3 : u3.source, n = { replace: (r, i) => {
    let s = typeof i == "string" ? i : i.source;
    return s = s.replace(m.caret, "$1"), t = t.replace(r, s), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
var be = (() => {
  try {
    return !!new RegExp("(?<=1)(?<!1)");
  } catch {
    return false;
  }
})(), m = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (u3) => new RegExp(`^( {0,3}${u3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`), hrRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`), fencesBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}(?:\`\`\`|~~~)`), headingBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}#`), htmlBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}<(?:[a-z].*>|!--)`, "i"), blockquoteBeginRegex: (u3) => new RegExp(`^ {0,${Math.min(3, u3 - 1)}}>`) }, Re = /^(?:[ \t]*(?:\n|$))+/, Oe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/, Te = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/, C = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/, we = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/, Q = / {0,3}(?:[*+-]|\d{1,9}[.)])/, se = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/, ie = k(se).replace(/bull/g, Q).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex(), ye = k(se).replace(/bull/g, Q).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(), j = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/, Pe = /^[^\n]+/, F = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/, Se = k(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", F).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(), $e = k(/^(bull)([ \t][^\n]+?)?(?:\n|$)/).replace(/bull/g, Q).getRegex(), v = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul", U = /<!--(?:-?>|[\s\S]*?(?:-->|$))/, _e = k("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", U).replace("tag", v).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(), oe = k(j).replace("hr", C).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", v).getRegex(), Le = k(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", oe).getRegex(), K = { blockquote: Le, code: Oe, def: Se, fences: Te, heading: we, hr: C, html: _e, lheading: ie, list: $e, newline: Re, paragraph: oe, table: _, text: Pe }, ne = k("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", C).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", v).getRegex(), Me = { ...K, lheading: ye, table: ne, paragraph: k(j).replace("hr", C).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", ne).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", v).getRegex() }, ze = { ...K, html: k(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", U).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: _, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: k(j).replace("hr", C).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", ie).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() }, Ee = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/, Ie = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/, ae = /^( {2,}|\\)\n(?!\s*$)/, Ae = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/, z = /[\p{P}\p{S}]/u, H = /[\s\p{P}\p{S}]/u, W = /[^\s\p{P}\p{S}]/u, Ce = k(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, H).getRegex(), le = /(?!~)[\p{P}\p{S}]/u, Be = /(?!~)[\s\p{P}\p{S}]/u, De = /(?:[^\s\p{P}\p{S}]|~)/u, qe = k(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", be ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex(), ue = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, ve = k(ue, "u").replace(/punct/g, z).getRegex(), He = k(ue, "u").replace(/punct/g, le).getRegex(), pe = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)", Ze = k(pe, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, z).getRegex(), Ge = k(pe, "gu").replace(/notPunctSpace/g, De).replace(/punctSpace/g, Be).replace(/punct/g, le).getRegex(), Ne = k("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, z).getRegex(), Qe = k(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, z).getRegex(), je = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)", Fe = k(je, "gu").replace(/notPunctSpace/g, W).replace(/punctSpace/g, H).replace(/punct/g, z).getRegex(), Ue = k(/\\(punct)/, "gu").replace(/punct/g, z).getRegex(), Ke = k(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(), We = k(U).replace("(?:-->|$)", "-->").getRegex(), Xe = k("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", We).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(), q = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/, Je = k(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", q).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(), ce = k(/^!?\[(label)\]\[(ref)\]/).replace("label", q).replace("ref", F).getRegex(), he = k(/^!?\[(ref)\](?:\[\])?/).replace("ref", F).getRegex(), Ve = k("reflink|nolink(?!\\()", "g").replace("reflink", ce).replace("nolink", he).getRegex(), re = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/, X = { _backpedal: _, anyPunctuation: Ue, autolink: Ke, blockSkip: qe, br: ae, code: Ie, del: _, delLDelim: _, delRDelim: _, emStrongLDelim: ve, emStrongRDelimAst: Ze, emStrongRDelimUnd: Ne, escape: Ee, link: Je, nolink: he, punctuation: Ce, reflink: ce, reflinkSearch: Ve, tag: Xe, text: Ae, url: _ }, Ye = { ...X, link: k(/^!?\[(label)\]\((.*?)\)/).replace("label", q).getRegex(), reflink: k(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", q).getRegex() }, N = { ...X, emStrongRDelimAst: Ge, emStrongLDelim: He, delLDelim: Qe, delRDelim: Fe, url: k(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", re).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: k(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", re).getRegex() }, et = { ...N, br: k(ae).replace("{2,}", "*").getRegex(), text: k(N.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() }, B = { normal: K, gfm: Me, pedantic: ze }, E = { normal: X, gfm: N, breaks: et, pedantic: Ye };
var tt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }, ke = (u3) => tt[u3];
function T(u3, e) {
  if (e) {
    if (m.escapeTest.test(u3)) return u3.replace(m.escapeReplace, ke);
  } else if (m.escapeTestNoEncode.test(u3)) return u3.replace(m.escapeReplaceNoEncode, ke);
  return u3;
}
function J(u3) {
  try {
    u3 = encodeURI(u3).replace(m.percentDecode, "%");
  } catch {
    return null;
  }
  return u3;
}
function V(u3, e) {
  let t = u3.replace(m.findPipe, (i, s, a) => {
    let o = false, l = s;
    for (; --l >= 0 && a[l] === "\\"; ) o = !o;
    return o ? "|" : " |";
  }), n = t.split(m.splitPipe), r = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
  else for (; n.length < e; ) n.push("");
  for (; r < n.length; r++) n[r] = n[r].trim().replace(m.slashPipe, "|");
  return n;
}
function I(u3, e, t) {
  let n = u3.length;
  if (n === 0) return "";
  let r = 0;
  for (; r < n; ) {
    let i = u3.charAt(n - r - 1);
    if (i === e && true) r++;
    else break;
  }
  return u3.slice(0, n - r);
}
function de(u3, e) {
  if (u3.indexOf(e[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < u3.length; n++) if (u3[n] === "\\") n++;
  else if (u3[n] === e[0]) t++;
  else if (u3[n] === e[1] && (t--, t < 0)) return n;
  return t > 0 ? -2 : -1;
}
function ge(u3, e = 0) {
  let t = e, n = "";
  for (let r of u3) if (r === "	") {
    let i = 4 - t % 4;
    n += " ".repeat(i), t += i;
  } else n += r, t++;
  return n;
}
function fe(u3, e, t, n, r) {
  let i = e.href, s = e.title || null, a = u3[1].replace(r.other.outputLinkReplace, "$1");
  n.state.inLink = true;
  let o = { type: u3[0].charAt(0) === "!" ? "image" : "link", raw: t, href: i, title: s, text: a, tokens: n.inlineTokens(a) };
  return n.state.inLink = false, o;
}
function nt(u3, e, t) {
  let n = u3.match(t.other.indentCodeCompensation);
  if (n === null) return e;
  let r = n[1];
  return e.split(`
`).map((i) => {
    let s = i.match(t.other.beginningSpace);
    if (s === null) return i;
    let [a] = s;
    return a.length >= r.length ? i.slice(r.length) : i;
  }).join(`
`);
}
var w = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || O;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0) return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = t[0].replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: t[0], codeBlockStyle: "indented", text: this.options.pedantic ? n : I(n, `
`) };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], r = nt(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: r };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let r = I(n, "#");
        (this.options.pedantic || !r || this.rules.other.endingSpaceChar.test(r)) && (n = r.trim());
      }
      return { type: "heading", raw: t[0], depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t) return { type: "hr", raw: I(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = I(t[0], `
`).split(`
`), r = "", i = "", s = [];
      for (; n.length > 0; ) {
        let a = false, o = [], l;
        for (l = 0; l < n.length; l++) if (this.rules.other.blockquoteStart.test(n[l])) o.push(n[l]), a = true;
        else if (!a) o.push(n[l]);
        else break;
        n = n.slice(l);
        let p = o.join(`
`), c = p.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        r = r ? `${r}
${p}` : p, i = i ? `${i}
${c}` : c;
        let d = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(c, s, true), this.lexer.state.top = d, n.length === 0) break;
        let h = s.at(-1);
        if (h?.type === "code") break;
        if (h?.type === "blockquote") {
          let R = h, f = R.raw + `
` + n.join(`
`), S = this.blockquote(f);
          s[s.length - 1] = S, r = r.substring(0, r.length - R.raw.length) + S.raw, i = i.substring(0, i.length - R.text.length) + S.text;
          break;
        } else if (h?.type === "list") {
          let R = h, f = R.raw + `
` + n.join(`
`), S = this.list(f);
          s[s.length - 1] = S, r = r.substring(0, r.length - h.raw.length) + S.raw, i = i.substring(0, i.length - R.raw.length) + S.raw, n = f.substring(s.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: r, tokens: s, text: i };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = t[1].trim(), r = n.length > 1, i = { type: "list", raw: "", ordered: r, start: r ? +n.slice(0, -1) : "", loose: false, items: [] };
      n = r ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = r ? n : "[*+-]");
      let s = this.rules.other.listItemRegex(n), a = false;
      for (; e; ) {
        let l = false, p = "", c = "";
        if (!(t = s.exec(e)) || this.rules.block.hr.test(e)) break;
        p = t[0], e = e.substring(p.length);
        let d = ge(t[2].split(`
`, 1)[0], t[1].length), h = e.split(`
`, 1)[0], R = !d.trim(), f = 0;
        if (this.options.pedantic ? (f = 2, c = d.trimStart()) : R ? f = t[1].length + 1 : (f = d.search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, c = d.slice(f), f += t[1].length), R && this.rules.other.blankLine.test(h) && (p += h + `
`, e = e.substring(h.length + 1), l = true), !l) {
          let S = this.rules.other.nextBulletRegex(f), Y = this.rules.other.hrRegex(f), ee = this.rules.other.fencesBeginRegex(f), te = this.rules.other.headingBeginRegex(f), me = this.rules.other.htmlBeginRegex(f), xe = this.rules.other.blockquoteBeginRegex(f);
          for (; e; ) {
            let Z = e.split(`
`, 1)[0], A;
            if (h = Z, this.options.pedantic ? (h = h.replace(this.rules.other.listReplaceNesting, "  "), A = h) : A = h.replace(this.rules.other.tabCharGlobal, "    "), ee.test(h) || te.test(h) || me.test(h) || xe.test(h) || S.test(h) || Y.test(h)) break;
            if (A.search(this.rules.other.nonSpaceChar) >= f || !h.trim()) c += `
` + A.slice(f);
            else {
              if (R || d.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ee.test(d) || te.test(d) || Y.test(d)) break;
              c += `
` + h;
            }
            R = !h.trim(), p += Z + `
`, e = e.substring(Z.length + 1), d = A.slice(f);
          }
        }
        i.loose || (a ? i.loose = true : this.rules.other.doubleBlankLine.test(p) && (a = true)), i.items.push({ type: "list_item", raw: p, task: !!this.options.gfm && this.rules.other.listIsTask.test(c), loose: false, text: c, tokens: [] }), i.raw += p;
      }
      let o = i.items.at(-1);
      if (o) o.raw = o.raw.trimEnd(), o.text = o.text.trimEnd();
      else return;
      i.raw = i.raw.trimEnd();
      for (let l of i.items) {
        if (this.lexer.state.top = false, l.tokens = this.lexer.blockTokens(l.text, []), l.task) {
          if (l.text = l.text.replace(this.rules.other.listReplaceTask, ""), l.tokens[0]?.type === "text" || l.tokens[0]?.type === "paragraph") {
            l.tokens[0].raw = l.tokens[0].raw.replace(this.rules.other.listReplaceTask, ""), l.tokens[0].text = l.tokens[0].text.replace(this.rules.other.listReplaceTask, "");
            for (let c = this.lexer.inlineQueue.length - 1; c >= 0; c--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[c].src)) {
              this.lexer.inlineQueue[c].src = this.lexer.inlineQueue[c].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
          }
          let p = this.rules.other.listTaskCheckbox.exec(l.raw);
          if (p) {
            let c = { type: "checkbox", raw: p[0] + " ", checked: p[0] !== "[ ]" };
            l.checked = c.checked, i.loose ? l.tokens[0] && ["paragraph", "text"].includes(l.tokens[0].type) && "tokens" in l.tokens[0] && l.tokens[0].tokens ? (l.tokens[0].raw = c.raw + l.tokens[0].raw, l.tokens[0].text = c.raw + l.tokens[0].text, l.tokens[0].tokens.unshift(c)) : l.tokens.unshift({ type: "paragraph", raw: c.raw, text: c.raw, tokens: [c] }) : l.tokens.unshift(c);
          }
        }
        if (!i.loose) {
          let p = l.tokens.filter((d) => d.type === "space"), c = p.length > 0 && p.some((d) => this.rules.other.anyLine.test(d.raw));
          i.loose = c;
        }
      }
      if (i.loose) for (let l of i.items) {
        l.loose = true;
        for (let p of l.tokens) p.type === "text" && (p.type = "paragraph");
      }
      return i;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) return { type: "html", block: true, raw: t[0], pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: t[0] };
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      let n = t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), r = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", i = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: t[0], href: r, title: i };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
    let n = V(t[1]), r = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), i = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], s = { type: "table", raw: t[0], header: [], align: [], rows: [] };
    if (n.length === r.length) {
      for (let a of r) this.rules.other.tableAlignRight.test(a) ? s.align.push("right") : this.rules.other.tableAlignCenter.test(a) ? s.align.push("center") : this.rules.other.tableAlignLeft.test(a) ? s.align.push("left") : s.align.push(null);
      for (let a = 0; a < n.length; a++) s.header.push({ text: n[a], tokens: this.lexer.inline(n[a]), header: true, align: s.align[a] });
      for (let a of i) s.rows.push(V(a, s.header.length).map((o, l) => ({ text: o, tokens: this.lexer.inline(o), header: false, align: s.align[l] })));
      return s;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return { type: "heading", raw: t[0], depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t) return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(n)) {
        if (!this.rules.other.endAngleBracket.test(n)) return;
        let s = I(n.slice(0, -1), "\\");
        if ((n.length - s.length) % 2 === 0) return;
      } else {
        let s = de(t[2], "()");
        if (s === -2) return;
        if (s > -1) {
          let o = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + s;
          t[2] = t[2].substring(0, s), t[0] = t[0].substring(0, o).trim(), t[3] = "";
        }
      }
      let r = t[2], i = "";
      if (this.options.pedantic) {
        let s = this.rules.other.pedanticHrefTitle.exec(r);
        s && (r = s[1], i = s[3]);
      } else i = t[3] ? t[3].slice(1, -1) : "";
      return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(n) ? r = r.slice(1) : r = r.slice(1, -1)), fe(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: i && i.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let r = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), i = t[r.toLowerCase()];
      if (!i) {
        let s = n[0].charAt(0);
        return { type: "text", raw: s, text: s };
      }
      return fe(n, i, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let r = this.rules.inline.emStrongLDelim.exec(e);
    if (!r || !r[1] && !r[2] && !r[3] && !r[4] || r[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
    if (!(r[1] || r[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let s = [...r[0]].length - 1, a, o, l = s, p = 0, c = r[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (c.lastIndex = 0, t = t.slice(-1 * e.length + s); (r = c.exec(t)) !== null; ) {
        if (a = r[1] || r[2] || r[3] || r[4] || r[5] || r[6], !a) continue;
        if (o = [...a].length, r[3] || r[4]) {
          l += o;
          continue;
        } else if ((r[5] || r[6]) && s % 3 && !((s + o) % 3)) {
          p += o;
          continue;
        }
        if (l -= o, l > 0) continue;
        o = Math.min(o, o + l + p);
        let d = [...r[0]][0].length, h = e.slice(0, s + r.index + d + o);
        if (Math.min(s, o) % 2) {
          let f = h.slice(1, -1);
          return { type: "em", raw: h, text: f, tokens: this.lexer.inlineTokens(f) };
        }
        let R = h.slice(2, -2);
        return { type: "strong", raw: h, text: R, tokens: this.lexer.inlineTokens(R) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), r = this.rules.other.nonSpaceChar.test(n), i = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return r && i && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t) return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let r = this.rules.inline.delLDelim.exec(e);
    if (!r) return;
    if (!(r[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let s = [...r[0]].length - 1, a, o, l = s, p = this.rules.inline.delRDelim;
      for (p.lastIndex = 0, t = t.slice(-1 * e.length + s); (r = p.exec(t)) !== null; ) {
        if (a = r[1] || r[2] || r[3] || r[4] || r[5] || r[6], !a || (o = [...a].length, o !== s)) continue;
        if (r[3] || r[4]) {
          l += o;
          continue;
        }
        if (l -= o, l > 0) continue;
        o = Math.min(o, o + l);
        let c = [...r[0]][0].length, d = e.slice(0, s + r.index + c + o), h = d.slice(s, -s);
        return { type: "del", raw: d, text: h, tokens: this.lexer.inlineTokens(h) };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, r;
      return t[2] === "@" ? (n = t[1], r = "mailto:" + n) : (n = t[1], r = n), { type: "link", raw: t[0], text: n, href: r, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, r;
      if (t[2] === "@") n = t[0], r = "mailto:" + n;
      else {
        let i;
        do
          i = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (i !== t[0]);
        n = t[0], t[1] === "www." ? r = "http://" + t[0] : r = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: r, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: t[0], escaped: n };
    }
  }
};
var x = class u {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || O, this.options.tokenizer = this.options.tokenizer || new w(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, top: true };
    let t = { other: m, block: B.normal, inline: E.normal };
    this.options.pedantic ? (t.block = B.pedantic, t.inline = E.pedantic) : this.options.gfm && (t.block = B.gfm, this.options.breaks ? t.inline = E.breaks : t.inline = E.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: B, inline: E };
  }
  static lex(e, t) {
    return new u(t).lex(e);
  }
  static lexInline(e, t) {
    return new u(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(m.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0; t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    for (this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, "")); e; ) {
      let r;
      if (this.options.extensions?.block?.some((s) => (r = s.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        r.raw.length === 1 && s !== void 0 ? s.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.at(-1).src = s.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "paragraph" || s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.raw, this.inlineQueue.at(-1).src = s.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let i = e;
      if (this.options.extensions?.startBlock) {
        let s = 1 / 0, a = e.slice(1), o;
        this.options.extensions.startBlock.forEach((l) => {
          o = l.call({ lexer: this }, a), typeof o == "number" && o >= 0 && (s = Math.min(s, o));
        }), s < 1 / 0 && s >= 0 && (i = e.substring(0, s + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(i))) {
        let s = t.at(-1);
        n && s?.type === "paragraph" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r), n = i.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let s = t.at(-1);
        s?.type === "text" ? (s.raw += (s.raw.endsWith(`
`) ? "" : `
`) + r.raw, s.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = s.text) : t.push(r);
        continue;
      }
      if (e) {
        let s = "Infinite loop on byte: " + e.charCodeAt(0);
        if (this.options.silent) {
          console.error(s);
          break;
        } else throw new Error(s);
      }
    }
    return this.state.top = true, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = e, r = null;
    if (this.tokens.links) {
      let o = Object.keys(this.tokens.links);
      if (o.length > 0) for (; (r = this.tokenizer.rules.inline.reflinkSearch.exec(n)) !== null; ) o.includes(r[0].slice(r[0].lastIndexOf("[") + 1, -1)) && (n = n.slice(0, r.index) + "[" + "a".repeat(r[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
    }
    for (; (r = this.tokenizer.rules.inline.anyPunctuation.exec(n)) !== null; ) n = n.slice(0, r.index) + "++" + n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
    let i;
    for (; (r = this.tokenizer.rules.inline.blockSkip.exec(n)) !== null; ) i = r[2] ? r[2].length : 0, n = n.slice(0, r.index + i) + "[" + "a".repeat(r[0].length - i - 2) + "]" + n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
    n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let s = false, a = "";
    for (; e; ) {
      s || (a = ""), s = false;
      let o;
      if (this.options.extensions?.inline?.some((p) => (o = p.call({ lexer: this }, e, t)) ? (e = e.substring(o.raw.length), t.push(o), true) : false)) continue;
      if (o = this.tokenizer.escape(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.tag(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.link(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(o.raw.length);
        let p = t.at(-1);
        o.type === "text" && p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : t.push(o);
        continue;
      }
      if (o = this.tokenizer.emStrong(e, n, a)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.codespan(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.br(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.del(e, n, a)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (o = this.tokenizer.autolink(e)) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      if (!this.state.inLink && (o = this.tokenizer.url(e))) {
        e = e.substring(o.raw.length), t.push(o);
        continue;
      }
      let l = e;
      if (this.options.extensions?.startInline) {
        let p = 1 / 0, c = e.slice(1), d;
        this.options.extensions.startInline.forEach((h) => {
          d = h.call({ lexer: this }, c), typeof d == "number" && d >= 0 && (p = Math.min(p, d));
        }), p < 1 / 0 && p >= 0 && (l = e.substring(0, p + 1));
      }
      if (o = this.tokenizer.inlineText(l)) {
        e = e.substring(o.raw.length), o.raw.slice(-1) !== "_" && (a = o.raw.slice(-1)), s = true;
        let p = t.at(-1);
        p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : t.push(o);
        continue;
      }
      if (e) {
        let p = "Infinite loop on byte: " + e.charCodeAt(0);
        if (this.options.silent) {
          console.error(p);
          break;
        } else throw new Error(p);
      }
    }
    return t;
  }
};
var y = class {
  options;
  parser;
  constructor(e) {
    this.options = e || O;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let r = (t || "").match(m.notSpaceStart)?.[0], i = e.replace(m.endingNewline, "") + `
`;
    return r ? '<pre><code class="language-' + T(r) + '">' + (n ? i : T(i, true)) + `</code></pre>
` : "<pre><code>" + (n ? i : T(i, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let t = e.ordered, n = e.start, r = "";
    for (let a = 0; a < e.items.length; a++) {
      let o = e.items[a];
      r += this.listitem(o);
    }
    let i = t ? "ol" : "ul", s = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + i + s + `>
` + r + "</" + i + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let i = 0; i < e.header.length; i++) n += this.tablecell(e.header[i]);
    t += this.tablerow({ text: n });
    let r = "";
    for (let i = 0; i < e.rows.length; i++) {
      let s = e.rows[i];
      n = "";
      for (let a = 0; a < s.length; a++) n += this.tablecell(s[a]);
      r += this.tablerow({ text: n });
    }
    return r && (r = `<tbody>${r}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + r + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${T(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, tokens: n }) {
    let r = this.parser.parseInline(n), i = J(e);
    if (i === null) return r;
    e = i;
    let s = '<a href="' + e + '"';
    return t && (s += ' title="' + T(t) + '"'), s += ">" + r + "</a>", s;
  }
  image({ href: e, title: t, text: n, tokens: r }) {
    r && (n = this.parser.parseInline(r, this.parser.textRenderer));
    let i = J(e);
    if (i === null) return T(n);
    e = i;
    let s = `<img src="${e}" alt="${T(n)}"`;
    return t && (s += ` title="${T(t)}"`), s += ">", s;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : T(e.text);
  }
};
var $ = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var b = class u2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || O, this.options.renderer = this.options.renderer || new y(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new $();
  }
  static parse(e, t) {
    return new u2(t).parse(e);
  }
  static parseInline(e, t) {
    return new u2(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0; n < e.length; n++) {
      let r = e[n];
      if (this.options.extensions?.renderers?.[r.type]) {
        let s = r, a = this.options.extensions.renderers[s.type].call({ parser: this }, s);
        if (a !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(s.type)) {
          t += a || "";
          continue;
        }
      }
      let i = r;
      switch (i.type) {
        case "space": {
          t += this.renderer.space(i);
          break;
        }
        case "hr": {
          t += this.renderer.hr(i);
          break;
        }
        case "heading": {
          t += this.renderer.heading(i);
          break;
        }
        case "code": {
          t += this.renderer.code(i);
          break;
        }
        case "table": {
          t += this.renderer.table(i);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(i);
          break;
        }
        case "list": {
          t += this.renderer.list(i);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(i);
          break;
        }
        case "html": {
          t += this.renderer.html(i);
          break;
        }
        case "def": {
          t += this.renderer.def(i);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(i);
          break;
        }
        case "text": {
          t += this.renderer.text(i);
          break;
        }
        default: {
          let s = 'Token with "' + i.type + '" type was not found.';
          if (this.options.silent) return console.error(s), "";
          throw new Error(s);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let r = 0; r < e.length; r++) {
      let i = e[r];
      if (this.options.extensions?.renderers?.[i.type]) {
        let a = this.options.extensions.renderers[i.type].call({ parser: this }, i);
        if (a !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(i.type)) {
          n += a || "";
          continue;
        }
      }
      let s = i;
      switch (s.type) {
        case "escape": {
          n += t.text(s);
          break;
        }
        case "html": {
          n += t.html(s);
          break;
        }
        case "link": {
          n += t.link(s);
          break;
        }
        case "image": {
          n += t.image(s);
          break;
        }
        case "checkbox": {
          n += t.checkbox(s);
          break;
        }
        case "strong": {
          n += t.strong(s);
          break;
        }
        case "em": {
          n += t.em(s);
          break;
        }
        case "codespan": {
          n += t.codespan(s);
          break;
        }
        case "br": {
          n += t.br(s);
          break;
        }
        case "del": {
          n += t.del(s);
          break;
        }
        case "text": {
          n += t.text(s);
          break;
        }
        default: {
          let a = 'Token with "' + s.type + '" type was not found.';
          if (this.options.silent) return console.error(a), "";
          throw new Error(a);
        }
      }
    }
    return n;
  }
};
var P = class {
  options;
  block;
  constructor(e) {
    this.options = e || O;
  }
  static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? x.lex : x.lexInline;
  }
  provideParser(e = this.block) {
    return e ? b.parse : b.parseInline;
  }
};
var D = class {
  defaults = M();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = b;
  Renderer = y;
  TextRenderer = $;
  Lexer = x;
  Tokenizer = w;
  Hooks = P;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let r of e) switch (n = n.concat(t.call(this, r)), r.type) {
      case "table": {
        let i = r;
        for (let s of i.header) n = n.concat(this.walkTokens(s.tokens, t));
        for (let s of i.rows) for (let a of s) n = n.concat(this.walkTokens(a.tokens, t));
        break;
      }
      case "list": {
        let i = r;
        n = n.concat(this.walkTokens(i.items, t));
        break;
      }
      default: {
        let i = r;
        this.defaults.extensions?.childTokens?.[i.type] ? this.defaults.extensions.childTokens[i.type].forEach((s) => {
          let a = i[s].flat(1 / 0);
          n = n.concat(this.walkTokens(a, t));
        }) : i.tokens && (n = n.concat(this.walkTokens(i.tokens, t)));
      }
    }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((n) => {
      let r = { ...n };
      if (r.async = this.defaults.async || r.async || false, n.extensions && (n.extensions.forEach((i) => {
        if (!i.name) throw new Error("extension name required");
        if ("renderer" in i) {
          let s = t.renderers[i.name];
          s ? t.renderers[i.name] = function(...a) {
            let o = i.renderer.apply(this, a);
            return o === false && (o = s.apply(this, a)), o;
          } : t.renderers[i.name] = i.renderer;
        }
        if ("tokenizer" in i) {
          if (!i.level || i.level !== "block" && i.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
          let s = t[i.level];
          s ? s.unshift(i.tokenizer) : t[i.level] = [i.tokenizer], i.start && (i.level === "block" ? t.startBlock ? t.startBlock.push(i.start) : t.startBlock = [i.start] : i.level === "inline" && (t.startInline ? t.startInline.push(i.start) : t.startInline = [i.start]));
        }
        "childTokens" in i && i.childTokens && (t.childTokens[i.name] = i.childTokens);
      }), r.extensions = t), n.renderer) {
        let i = this.defaults.renderer || new y(this.defaults);
        for (let s in n.renderer) {
          if (!(s in i)) throw new Error(`renderer '${s}' does not exist`);
          if (["options", "parser"].includes(s)) continue;
          let a = s, o = n.renderer[a], l = i[a];
          i[a] = (...p) => {
            let c = o.apply(i, p);
            return c === false && (c = l.apply(i, p)), c || "";
          };
        }
        r.renderer = i;
      }
      if (n.tokenizer) {
        let i = this.defaults.tokenizer || new w(this.defaults);
        for (let s in n.tokenizer) {
          if (!(s in i)) throw new Error(`tokenizer '${s}' does not exist`);
          if (["options", "rules", "lexer"].includes(s)) continue;
          let a = s, o = n.tokenizer[a], l = i[a];
          i[a] = (...p) => {
            let c = o.apply(i, p);
            return c === false && (c = l.apply(i, p)), c;
          };
        }
        r.tokenizer = i;
      }
      if (n.hooks) {
        let i = this.defaults.hooks || new P();
        for (let s in n.hooks) {
          if (!(s in i)) throw new Error(`hook '${s}' does not exist`);
          if (["options", "block"].includes(s)) continue;
          let a = s, o = n.hooks[a], l = i[a];
          P.passThroughHooks.has(s) ? i[a] = (p) => {
            if (this.defaults.async && P.passThroughHooksRespectAsync.has(s)) return (async () => {
              let d = await o.call(i, p);
              return l.call(i, d);
            })();
            let c = o.call(i, p);
            return l.call(i, c);
          } : i[a] = (...p) => {
            if (this.defaults.async) return (async () => {
              let d = await o.apply(i, p);
              return d === false && (d = await l.apply(i, p)), d;
            })();
            let c = o.apply(i, p);
            return c === false && (c = l.apply(i, p)), c;
          };
        }
        r.hooks = i;
      }
      if (n.walkTokens) {
        let i = this.defaults.walkTokens, s = n.walkTokens;
        r.walkTokens = function(a) {
          let o = [];
          return o.push(s.call(this, a)), i && (o = o.concat(i.call(this, a))), o;
        };
      }
      this.defaults = { ...this.defaults, ...r };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return x.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return b.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, r) => {
      let i = { ...r }, s = { ...this.defaults, ...i }, a = this.onError(!!s.silent, !!s.async);
      if (this.defaults.async === true && i.async === false) return a(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null) return a(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string") return a(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (s.hooks && (s.hooks.options = s, s.hooks.block = e), s.async) return (async () => {
        let o = s.hooks ? await s.hooks.preprocess(n) : n, p = await (s.hooks ? await s.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(o, s), c = s.hooks ? await s.hooks.processAllTokens(p) : p;
        s.walkTokens && await Promise.all(this.walkTokens(c, s.walkTokens));
        let h = await (s.hooks ? await s.hooks.provideParser(e) : e ? b.parse : b.parseInline)(c, s);
        return s.hooks ? await s.hooks.postprocess(h) : h;
      })().catch(a);
      try {
        s.hooks && (n = s.hooks.preprocess(n));
        let l = (s.hooks ? s.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(n, s);
        s.hooks && (l = s.hooks.processAllTokens(l)), s.walkTokens && this.walkTokens(l, s.walkTokens);
        let c = (s.hooks ? s.hooks.provideParser(e) : e ? b.parse : b.parseInline)(l, s);
        return s.hooks && (c = s.hooks.postprocess(c)), c;
      } catch (o) {
        return a(o);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let r = "<p>An error occurred:</p><pre>" + T(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(r) : r;
      }
      if (t) return Promise.reject(n);
      throw n;
    };
  }
};
var L = new D();
function g(u3, e) {
  return L.parse(u3, e);
}
g.options = g.setOptions = function(u3) {
  return L.setOptions(u3), g.defaults = L.defaults, G(g.defaults), g;
};
g.getDefaults = M;
g.defaults = O;
g.use = function(...u3) {
  return L.use(...u3), g.defaults = L.defaults, G(g.defaults), g;
};
g.walkTokens = function(u3, e) {
  return L.walkTokens(u3, e);
};
g.parseInline = L.parseInline;
g.Parser = b;
g.parser = b.parse;
g.Renderer = y;
g.TextRenderer = $;
g.Lexer = x;
g.lexer = x.lex;
g.Tokenizer = w;
g.Hooks = P;
g.parse = g;
g.options;
g.setOptions;
g.use;
g.walkTokens;
g.parseInline;
b.parse;
x.lex;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function frontmatter(text) {
  const m2 = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m2) return { meta: {}, body: text };
  const meta = {};
  for (const line of m2[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2]) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m2[0].length) };
}
const READER = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --line: #e4e4e7; --code: #f4f4f5; --accent: #b4690e; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e8ea; --muted: #9a9aa0; --line: #2e2e33; --code: #1c1c20; --accent: #e0a458; } }
html { background: transparent; }
body { margin: 0; padding: 40px 32px 80px; color: var(--fg); font: 16px/1.62 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
main { max-width: 1040px; margin: 0 auto; }
.meta { color: var(--muted); font-size: 13px; margin: 0 0 28px; }
.meta span + span::before { content: " · "; }
h1 { font-size: 30px; line-height: 1.2; font-weight: 600; margin: 0 0 8px; }
h2 { font-size: 21px; font-weight: 600; margin: 36px 0 10px; }
h3 { font-size: 17px; font-weight: 600; margin: 28px 0 8px; }
p, ul, ol, table, pre, blockquote { margin: 0 0 16px; }
a { color: var(--accent); }
code { font: 13.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: var(--code); padding: 1px 4px; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
th, td { border-bottom: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
th { font-weight: 600; }
blockquote { margin-left: 0; padding-left: 14px; border-left: 2px solid var(--line); color: var(--muted); }
hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
img { max-width: 100%; }
pre.text { white-space: pre-wrap; word-break: break-word; }
`;
const page = (title, inner) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${READER}</style></head><body><main>${inner}</main></body></html>`;
const DRAWN = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const SANDBOXED = "sandbox allow-scripts allow-popups; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";
const INLINE = /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm|quicktime))$/;
function viewResponse(show, bytes) {
  const isMutable = Boolean(show.local || show.provenance && show.provenance !== "shown");
  const base = {
    "cache-control": isMutable ? "no-store" : "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff"
  };
  const where = String(show.sourcePath || show.path || show.name || "").replace(/^\/Users\/[^/]+/, "~");
  const meta = (extra = []) => `<p class="meta">${[...extra, where, new Date(show.createdAt).toLocaleString()].map((x2) => `<span>${esc(x2)}</span>`).join("")}</p>`;
  const view = show.view;
  if ((view === "image" || view === "video") && INLINE.test(show.mediaType)) {
    return { status: 200, headers: { ...base, "content-type": show.mediaType, "content-security-policy": "sandbox; default-src 'none'" }, body: bytes };
  }
  if (view === "markdown") {
    const { meta: fm, body: body2 } = frontmatter(bytes.toString("utf8"));
    const hasH1 = /^#\s/m.test(body2.slice(0, 400));
    const title = fm.title || /^#\s+(.+)$/m.exec(body2)?.[1] || show.name;
    let html = g.parse(body2, { gfm: true, async: false });
    const line = meta([fm.status].filter(Boolean));
    if (hasH1 && !fm.title) html = html.replace(/<\/h1>/, `</h1>${line}`);
    else html = `<h1>${esc(title)}</h1>${line}${html}`;
    return { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": DRAWN }, body: page(title, html) };
  }
  if (view === "html") {
    return { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": SANDBOXED }, body: bytes };
  }
  if (view === "pdf") {
    return { status: 200, headers: { ...base, "content-type": "application/pdf", "content-disposition": "inline" }, body: bytes };
  }
  if (view === "text") {
    let text = bytes.toString("utf8");
    if (/json/.test(show.mediaType)) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
      }
    }
    return { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": DRAWN }, body: page(show.name, `<h1>${esc(show.name)}</h1>${meta()}<pre class="text">${esc(text)}</pre>`) };
  }
  return { status: 200, headers: { ...base, "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${show.name.replace(/"/g, "")}"` }, body: bytes };
}
const MIN_W$1 = 320, MIN_H$1 = 200;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const OPEN_SAFE_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const HTML_EXT = /\.html?$/i;
const MD_EXT = /\.(md|markdown|mdx)$/i;
const BOILERPLATE_MD = /^(readme|agents|claude|gemini|skill|changelog|contributing|license|code_of_conduct|security|todo)\.md$/i;
const DOC_NAME_HINT = /(?:plan|review|design|spec|brief|audit|roadmap|proposal|one[-_]?pager|dossier|study|notes|architecture|walkthrough|report)/i;
const DOC_DIR_HINT = /(?:^|\/)(?:plans|reviews|research|docs|artifacts|design|studies|notes|specs)(?:\/|$)/i;
const BUILD_DIR_RE = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|out|coverage|vendor|\.turbo|\.vercel|\.cache)(?:\/|$)/;
const SECRET_SEG_RE = /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.config\/gcloud)(?:\/|$)/i;
const SECRET_FILE_RE = /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.pypirc|id_rsa(?:\..+)?|id_ed25519(?:\..+)?|credentials(?:\..+)?|.*\.(?:pem|key|p12|pfx))$/i;
const SHELL_CAPTURE_RE = /\b(?:scout\s+browser\s+screenshot|agent-browser\s+screenshot|playwright\s+screenshot|screencapture|action\s+(?:.*\s+)?capture)\b/i;
const SCREENSHOT_TOOL_RE = /(?:screenshot|screencapture|capture_screen|save_screen)/i;
const FORBIDDEN_EXACT = /* @__PURE__ */ new Set([
  "/",
  "/Users",
  "/home",
  "/etc",
  "/private/etc",
  "/var",
  "/private/var",
  "/System",
  "/Library"
]);
function safeRealpath(p) {
  if (!p || typeof p !== "string") return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
function isSecretPath(p) {
  const normalized = String(p || "").split(path.sep).join("/");
  if (SECRET_SEG_RE.test(normalized)) return true;
  return SECRET_FILE_RE.test(path.basename(normalized));
}
function readSafeFile(realPath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(realPath, OPEN_SAFE_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.size <= 0 || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    const read2 = fs.readSync(fd, buf, 0, st.size, 0);
    return { bytes: buf.subarray(0, read2), st };
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
    }
  }
}
function isSafeProjectRoot(dir) {
  const real = safeRealpath(dir);
  if (!real || FORBIDDEN_EXACT.has(real)) return false;
  const userHome = safeRealpath(os.homedir()) || os.homedir();
  if (real === userHome) return false;
  for (const broad of ["Desktop", "Downloads", "Documents", "Library", ".ssh", ".aws", ".gnupg"]) {
    if (real === path.join(userHome, broad)) return false;
  }
  const tmp = safeRealpath(os.tmpdir()) || os.tmpdir();
  if (real === tmp) return false;
  if (real.startsWith(tmp + path.sep)) return true;
  if (real.startsWith(userHome + path.sep)) {
    const rel = real.slice(userHome.length + 1).split(path.sep).filter(Boolean);
    return rel.length >= 1 && !rel[0].startsWith(".ssh");
  }
  return real.split(path.sep).filter(Boolean).length >= 3;
}
function allowedRootsFor(cwd, extraRoots = []) {
  const roots = /* @__PURE__ */ new Set();
  for (const candidate of [cwd, ...extraRoots]) {
    if (candidate && isSafeProjectRoot(candidate)) {
      const real = safeRealpath(candidate);
      if (real) roots.add(real);
    }
  }
  const studioReal = safeRealpath(HOME);
  if (studioReal) roots.add(studioReal);
  const openscoutHome = safeRealpath(process.env.OPENSCOUT_HOME || path.join(os.homedir(), ".openscout"));
  if (openscoutHome) {
    for (const sub of ["artifacts", "captures", "shows", ".studio"]) {
      const r = safeRealpath(path.join(openscoutHome, sub));
      if (r) roots.add(r);
    }
  }
  return [...roots];
}
function resolveContainedFile(candidate, cwd, allowedRoots) {
  if (!candidate || typeof candidate !== "string") return null;
  let cleaned = candidate.trim().replace(/^['"`]|['"`]$/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(new URL(cleaned).pathname);
    } catch {
      return null;
    }
  } else if (cleaned.startsWith("~/")) {
    cleaned = path.join(os.homedir(), cleaned.slice(2));
  }
  const resolved = path.isAbsolute(cleaned) ? cleaned : cwd ? path.resolve(cwd, cleaned) : null;
  if (!resolved || isSecretPath(resolved)) return null;
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const real = safeRealpath(resolved);
  if (!real || BUILD_DIR_RE.test(real) || isSecretPath(real)) return null;
  for (const root2 of allowedRoots) {
    if (real === root2 || real.startsWith(root2 + path.sep)) return real;
  }
  return null;
}
const ingestedImages = /* @__PURE__ */ new Map();
function ingestImageFile(filePath, cwd, allowedRoots, meta = {}) {
  const real = resolveContainedFile(filePath, cwd, allowedRoots);
  if (!real || !IMG_EXT.test(real)) return null;
  const opened = readSafeFile(real, MAX_IMAGE_BYTES);
  if (!opened) return null;
  const { bytes, st } = opened;
  const cacheKey = `${real}:${Math.floor(st.mtimeMs)}:${st.size}`;
  if (ingestedImages.has(cacheKey)) {
    const hit = ingestedImages.get(cacheKey);
    if (!hit) return null;
    const provenance2 = meta.provenance || hit.provenance || "captured";
    const subject2 = meta.subject || deriveSurfaceSubject({
      url: meta.url || hit.url,
      sourcePath: real,
      projectRoot: meta.projectRoot || cwd || path.dirname(real),
      kind: "screen"
    });
    return { ...hit, ...meta, provenance: provenance2, subject: subject2, at: meta.at || hit.at };
  }
  const size = imageSize(bytes);
  if (!size || size.w < MIN_W$1 || size.h < MIN_H$1) {
    ingestedImages.set(cacheKey, null);
    return null;
  }
  const ext = bytes[0] === 255 ? "jpg" : bytes[0] === 137 ? "png" : bytes[0] === 71 ? "gif" : "webp";
  const hash = crypto.createHash("sha1").update(bytes.toString("base64")).digest("hex").slice(0, 16);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const dest = path.join(IMG, `${hash}.${ext}`);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(IMG, { recursive: true });
    const tmp = `${dest}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const base = {
    hash,
    sha256,
    ext,
    w: size.w,
    h: size.h,
    at: Math.floor(st.mtimeMs),
    file: real,
    url: null,
    provenance: "captured",
    revision: 1
  };
  ingestedImages.set(cacheKey, base);
  const provenance = meta.provenance || "captured";
  const subject = meta.subject || deriveSurfaceSubject({
    url: meta.url,
    sourcePath: real,
    projectRoot: meta.projectRoot || cwd || path.dirname(real),
    kind: "screen"
  });
  return { ...base, ...meta, provenance, subject, at: meta.at || base.at };
}
const localShows = /* @__PURE__ */ new Map();
const captionCache = /* @__PURE__ */ new Map();
function localShowUuid(realPath) {
  const h = crypto.createHash("sha1").update(`studio-local-show:${realPath}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function sniffDocCaption(realPath, view, mtimeMs, size, headBytes) {
  const key2 = `${realPath}:${Math.floor(mtimeMs)}:${size}`;
  if (captionCache.has(key2)) return captionCache.get(key2);
  let caption = "";
  try {
    const head = headBytes.subarray(0, Math.min(4096, headBytes.length)).toString("utf8");
    if (view === "html") {
      const m2 = /<title[^>]*>([^<]+)<\/title>/i.exec(head);
      if (m2?.[1]?.trim()) caption = m2[1].trim().slice(0, 72);
    } else if (view === "markdown") {
      const { meta, body: body2 } = frontmatter(head);
      const h1 = /^#\s+(.+)$/m.exec(body2)?.[1]?.trim();
      caption = (meta.title || h1 || "").replace(/[`*_#]/g, "").trim().slice(0, 72);
    }
  } catch {
  }
  captionCache.set(key2, caption);
  return caption;
}
function isVisualHtmlCandidate(realPath, projectRoot, headText) {
  if (!HTML_EXT.test(realPath) || BUILD_DIR_RE.test(realPath)) return false;
  const base = path.basename(realPath).toLowerCase();
  if (base === "index.html" && projectRoot && path.dirname(realPath) === projectRoot) {
    if (/src=["']\/?src\/main\.[jt]sx?["']/i.test(headText.slice(0, 2048))) return false;
  }
  return true;
}
function isEditorialMarkdownCandidate(realPath, fromBrain = false) {
  if (!MD_EXT.test(realPath) || BUILD_DIR_RE.test(realPath)) return false;
  const base = path.basename(realPath);
  if (BOILERPLATE_MD.test(base)) return false;
  if (fromBrain) return true;
  const normalized = realPath.split(path.sep).join("/");
  return DOC_DIR_HINT.test(normalized) || DOC_NAME_HINT.test(base);
}
function registerLocalShow(filePath, cwd, allowedRoots, opts = {}) {
  const real = resolveContainedFile(filePath, cwd, allowedRoots);
  if (!real) return null;
  const allowedRoot = allowedRoots.find((r) => real === r || real.startsWith(r + path.sep));
  if (!allowedRoot) return null;
  const opened = readSafeFile(real, MAX_DOC_BYTES);
  if (!opened) return null;
  const { bytes, st } = opened;
  const headText = bytes.subarray(0, Math.min(4096, bytes.length)).toString("utf8");
  const projectRoot = opts.projectRoot || allowedRoot;
  let view = null;
  let mediaType = "application/octet-stream";
  if (isVisualHtmlCandidate(real, projectRoot, headText)) {
    view = "html";
    mediaType = "text/html";
  } else if (isEditorialMarkdownCandidate(real, Boolean(opts.fromBrain))) {
    view = "markdown";
    mediaType = "text/markdown";
  } else {
    return null;
  }
  const id = localShowUuid(real);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const caption = opts.caption || sniffDocCaption(real, view, st.mtimeMs, st.size, bytes);
  const provenance = opts.provenance || "written";
  const subject = deriveSurfaceSubject({ sourcePath: real, projectRoot, kind: view });
  const show = {
    id,
    itemId: subject.key,
    sessionId: opts.sessionId || null,
    agentId: opts.agentId || opts.harness || "local",
    harness: opts.harness || null,
    projectRoot,
    worktree: opts.worktree || cwd || projectRoot,
    branch: opts.branch || "",
    path: real,
    sourcePath: real,
    name: path.basename(real),
    view,
    mediaType,
    size: st.size,
    sha256,
    caption,
    at: opts.at || Math.floor(st.mtimeMs),
    createdAt: opts.at || Math.floor(st.mtimeMs),
    versions: opts.versions || 1,
    revision: opts.revision || 1,
    provenance,
    subject,
    local: true
  };
  localShows.set(id, { show, realPath: real, allowedRoot });
  return show;
}
function localShowById(id) {
  return localShows.get(id)?.show || null;
}
function localShowBytes(id) {
  const entry = localShows.get(id);
  if (!entry || isSecretPath(entry.realPath)) return null;
  try {
    if (fs.lstatSync(entry.realPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const real = safeRealpath(entry.realPath);
  if (!real || isSecretPath(real) || !(real === entry.allowedRoot || real.startsWith(entry.allowedRoot + path.sep))) return null;
  return readSafeFile(real, MAX_DOC_BYTES)?.bytes || null;
}
function extractImageTokens(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  const re2 = /(?:['"`]([^'"`\r\n]+\.(?:png|jpe?g|webp|gif))['"`]|(\S+\.(?:png|jpe?g|webp|gif)))/gi;
  for (const m2 of text.matchAll(re2)) {
    const p = (m2[1] || m2[2] || "").replace(/[),.;:]+$/, "");
    if (p && !/^https?:\/\//i.test(p)) out.push(p);
  }
  return out;
}
function extractToolArtifacts(toolName, input = {}, outputText = "", rawPatch = "") {
  const name = String(toolName || "");
  const screenshots = [];
  const docs = [];
  if (SCREENSHOT_TOOL_RE.test(name)) {
    for (const k2 of ["path", "outputPath", "file_path", "file", "filename", "Path", "TargetFile"]) {
      if (typeof input[k2] === "string") screenshots.push(input[k2]);
    }
    screenshots.push(...extractImageTokens(outputText));
  }
  const cmd = String(input.command || input.CommandLine || input.cmd || "");
  if (cmd && SHELL_CAPTURE_RE.test(cmd)) {
    screenshots.push(...extractImageTokens(cmd));
    screenshots.push(...extractImageTokens(outputText));
  }
  if (/^(?:Write|Edit|MultiEdit|write_file|edit_file|create_file|replace_file_content)$/i.test(name)) {
    const target = input.file_path || input.path || input.Path || input.TargetFile;
    if (typeof target === "string") docs.push(target);
  }
  const patchBody = rawPatch || (name === "apply_patch" ? String(input.patch || input.input || "") : "");
  if (patchBody) {
    for (const m2 of patchBody.matchAll(/\*\*\* (?:Add|Update) File:\s*([^\r\n]+)/g)) {
      if (m2[1]?.trim()) docs.push(m2[1].trim());
    }
  }
  return { screenshots: [...new Set(screenshots)], docs: [...new Set(docs)] };
}
const WORKSPACE_DIRS = [
  "design/studio",
  "design",
  "plans",
  "reviews",
  "artifacts",
  "scratch",
  "docs/studies",
  ".openscout/artifacts"
];
const wsCache = /* @__PURE__ */ new Map();
function walkShallow(dir, maxDepth, out = [], depth = 0) {
  if (depth > maxDepth) return out;
  let entries2 = [];
  try {
    entries2 = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries2) {
    if (ent.name.startsWith(".") && ent.name !== ".openscout") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (BUILD_DIR_RE.test(full)) continue;
      walkShallow(full, maxDepth, out, depth + 1);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}
function discoverWorkspaceArtifacts(roots, since) {
  const bucket = Math.floor(since / 6e4);
  const out = [];
  for (const root2 of roots) {
    if (!root2 || !isSafeProjectRoot(root2)) continue;
    const realRoot = safeRealpath(root2);
    if (!realRoot) continue;
    const hit = wsCache.get(realRoot);
    if (hit && hit.sinceBucket === bucket && Date.now() - hit.at < 15e3) {
      if (hit.shows.length || hit.screens.length) out.push({ root: realRoot, ...hit });
      continue;
    }
    const allowed = [realRoot];
    const candidates = [];
    for (const sub of WORKSPACE_DIRS) {
      const target = path.join(realRoot, sub);
      if (fs.existsSync(target)) walkShallow(target, 3, candidates);
    }
    const recent = [];
    for (const file of new Set(candidates)) {
      try {
        const st = fs.lstatSync(file);
        if (st.isFile() && st.mtimeMs >= since && st.size > 0) recent.push({ file, mtimeMs: st.mtimeMs });
      } catch {
      }
    }
    recent.sort((a, b2) => b2.mtimeMs - a.mtimeMs);
    const shows = [];
    const screens = [];
    for (const item of recent) {
      if (IMG_EXT.test(item.file) && /(?:^|\/)(?:scratch|artifacts|design)(?:\/|$)/.test(item.file)) {
        if (screens.length < 12) {
          const sc = ingestImageFile(item.file, realRoot, allowed, {
            at: Math.floor(item.mtimeMs),
            tool: "workspace",
            caption: path.basename(item.file),
            open: false,
            provenance: "workspace",
            projectRoot: realRoot
          });
          if (sc) screens.push(sc);
        }
      } else if (shows.length < 16) {
        const sh = registerLocalShow(item.file, realRoot, allowed, {
          projectRoot: realRoot,
          worktree: realRoot,
          harness: "scout",
          provenance: "workspace",
          at: Math.floor(item.mtimeMs)
        });
        if (sh) shows.push(sh);
      }
    }
    wsCache.set(realRoot, { at: Date.now(), sinceBucket: bucket, shows, screens });
    if (shows.length || screens.length) out.push({ root: realRoot, shows, screens });
  }
  return out;
}
function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function antigravityBrainRoots() {
  if (process.env.SCOUT_STUDIO_ANTIGRAVITY_BRAIN) {
    return [process.env.SCOUT_STUDIO_ANTIGRAVITY_BRAIN];
  }
  const home = os.homedir();
  return [
    path.join(home, ".gemini", "antigravity-cli", "brain"),
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain")
  ];
}
function kimiSessionRoots() {
  if (process.env.SCOUT_STUDIO_KIMI_SESSIONS) {
    return [process.env.SCOUT_STUDIO_KIMI_SESSIONS];
  }
  const home = os.homedir();
  const primary = path.join(process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code"), "sessions");
  return process.env.KIMI_CODE_HOME ? [primary] : [primary, path.join(home, ".kimi", "sessions")];
}
function extraCodexRoots() {
  if (process.env.CODEX_HOME) return [];
  const alt = path.join(os.homedir(), ".openai-codex", "sessions");
  return alt !== CODEX_SESSIONS ? [alt] : [];
}
function watchableRoots() {
  const candidates = [
    CLAUDE_PROJECTS,
    CODEX_SESSIONS,
    ...extraCodexRoots(),
    ...antigravityBrainRoots(),
    ...kimiSessionRoots(),
    path.join(HOME, "shared-screens")
  ];
  return [...new Set(candidates)].filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}
function antigravityFiles(since = 0, targetSession = null) {
  const out = [];
  for (const root2 of antigravityBrainRoots()) {
    for (const ent of entries(root2)) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      if (targetSession && ent.name !== targetSession) continue;
      const brainDir = path.join(root2, ent.name);
      const file = path.join(brainDir, ".system_generated", "logs", "transcript.jsonl");
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs >= since && st.size > 0) {
        out.push({
          file,
          session: ent.name,
          harness: "antigravity",
          brainDir,
          mtime: st.mtimeMs,
          size: st.size
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
      const m2 = /sessions[\\/][^\\/]+[\\/]([^\\/]+)/.exec(full);
      const session = m2?.[1] || path.basename(path.dirname(full));
      if (targetSession && session !== targetSession) continue;
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= since && st.size > 0) {
          out.push({ file: full, session, harness: "kimi", mtime: st.mtimeMs, size: st.size });
        }
      } catch {
      }
    }
  }
  return out;
}
function kimiFiles(since = 0, targetSession = null) {
  const out = [];
  for (const root2 of kimiSessionRoots()) walkKimi(root2, since, targetSession, out);
  return out;
}
function extraHarnessFiles(since = 0, targetSession = null) {
  const out = [
    ...antigravityFiles(since, targetSession),
    ...kimiFiles(since, targetSession)
  ];
  for (const dir of extraCodexRoots()) {
    out.push(...codexFilesIn(dir, since, targetSession));
  }
  return out;
}
function antigravityBrainAssets(since, cwdBySession = /* @__PURE__ */ new Map()) {
  const results = [];
  for (const root2 of antigravityBrainRoots()) {
    for (const ent of entries(root2)) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const session = ent.name;
      const brainDir = path.join(root2, session);
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
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.mtimeMs < since) continue;
          const sc = ingestImageFile(full, brainDir, allowed, {
            at: Math.floor(st.mtimeMs),
            tool: sub === "scratch" ? "antigravity_scratch" : "user_upload",
            caption: f.name,
            open: false
          });
          if (sc) screens.push(sc);
        }
      }
      const shows = [];
      for (const f of entries(brainDir)) {
        if (!f.isFile() || f.name.startsWith(".")) continue;
        const full = path.join(brainDir, f.name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.mtimeMs < since) continue;
        const sh = registerLocalShow(full, cwd || brainDir, allowed, {
          sessionId: session,
          harness: "antigravity",
          projectRoot: cwd || brainDir,
          worktree: cwd || brainDir,
          at: Math.floor(st.mtimeMs),
          fromBrain: true
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
  const m2 = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  return (m2 ? m2[1] : raw).trim();
}
function antigravityEntry(raw) {
  const step2 = raw?.step || raw;
  if (!step2 || typeof step2 !== "object") return null;
  const type = String(step2.type || "");
  const timestamp = step2.metadata?.createdAt || raw.timestamp || "";
  let cwd = "";
  const uri = step2.userInput?.activeUserState?.activeDocument?.workspaceUri;
  if (typeof uri === "string" && uri.startsWith("file://")) {
    try {
      cwd = decodeURIComponent(new URL(uri).pathname);
    } catch {
    }
  }
  if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
    const rawPrompt = String(step2.userInput?.userResponse ?? step2.content ?? "");
    if (!cwd) cwd = sniffWorkspaceText(rawPrompt);
    const text = unwrapUserRequest(rawPrompt);
    if (!text) return cwd ? { timestamp, cwd } : null;
    return { timestamp, cwd, type: "user", message: { content: [{ type: "text", text }] } };
  }
  if (type === "PLANNER_RESPONSE" || type.endsWith("_PLANNER_RESPONSE")) {
    const pr = step2.plannerResponse || {};
    const calls = pr.toolCalls || step2.tool_calls || [];
    const content = [];
    const reply = String(pr.modifiedResponse ?? pr.response ?? (typeof step2.content === "string" ? step2.content : "")).trim();
    if (reply) content.push({ type: "text", text: reply });
    for (const tc of calls) {
      let args = tc.arguments || tc.args || {};
      if (typeof tc.argumentsJson === "string") {
        try {
          args = JSON.parse(tc.argumentsJson);
        } catch {
        }
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
      message: { stop_reason: calls.length ? "tool_use" : "end_turn", content }
    };
  }
  if (step2.runCommand?.combinedOutput?.full || step2.runCommand?.commandLine) {
    const out = String(step2.runCommand?.combinedOutput?.full || "");
    const cmd = String(step2.runCommand?.commandLine || "");
    if (!cwd && step2.runCommand?.cwd) cwd = step2.runCommand.cwd;
    const callId = step2.metadata?.toolCallId || "agy_cmd";
    return {
      timestamp,
      cwd,
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: callId, content: [{ type: "text", text: `${cmd}
${out}` }] }]
      }
    };
  }
  return cwd ? { timestamp, cwd } : null;
}
function kimiEntry(raw) {
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
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = { command: input };
        }
      }
      return {
        timestamp,
        type: "assistant",
        message: { content: [{ type: "tool_use", id: ev.id || "kimi_tc", name: ev.name || "tool", input }] }
      };
    }
    if (ev.part?.text) {
      return {
        timestamp,
        type: "assistant",
        message: { content: [{ type: "text", text: String(ev.part.text) }] }
      };
    }
  }
  if (raw.type === "turn.end") return { timestamp, turnEnded: true };
  return null;
}
function classifyTranscriptFile(file) {
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
      brainDir: file.slice(0, file.indexOf(`${path.sep}.system_generated`))
    };
  }
  if (file.endsWith(`${path.sep}wire.jsonl`)) {
    const m2 = /sessions[\\/][^\\/]+[\\/]([^\\/]+)/.exec(file);
    return { session: m2?.[1] || path.basename(path.dirname(file)), harness: "kimi", subagent: false };
  }
  return null;
}
const clip = (s, n) => {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const bare = (url) => String(url || "").replace(/^https?:\/\//, "");
function describe(name = "", input = {}) {
  const file = input.file_path || input.notebook_path || "";
  const base = file ? path.basename(file) : "";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name) && base) return `Edited ${base}`;
  if (name === "Read" && base) return `Read ${base}`;
  if (name === "Grep" || name === "Glob") return `Searched ${clip(input.pattern, 48)}`;
  if (name === "Bash") {
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
function said(text) {
  const line = String(text || "").split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim()).find(Boolean) || "";
  return clip(line, 64);
}
const MIN_W = 320, MIN_H = 200;
const MARK = /\[scout-(?:studio|canvas):(n_[a-z0-9]+)\]/g;
const states = /* @__PURE__ */ new Map();
const places = /* @__PURE__ */ new Map();
function fresh(file, owner, meta = {}) {
  return {
    file,
    owner,
    harness: meta.harness || "claude",
    extraRoots: meta.brainDir ? [meta.brainDir] : [],
    offset: 0,
    carry: Buffer.alloc(0),
    line: null,
    cwd: "",
    firstAt: 0,
    lastAt: 0,
    lastStop: "",
    openTools: 0,
    prompt: "",
    turn: 0,
    said: "",
    uses: /* @__PURE__ */ new Map(),
    screens: [],
    turnScreens: [],
    writtenShows: /* @__PURE__ */ new Map(),
    lastOf: /* @__PURE__ */ new Map(),
    mark: null,
    arrived: {},
    answers: {},
    // what it did last, in a few words, and when
    now: null
  };
}
function subjectOf(tool, input = {}, text = "") {
  const url = text.match(/"url"\s*:\s*"([^"]+)"/)?.[1] || input.url;
  if (url) {
    try {
      const u3 = new URL(url);
      return `page:${u3.host}${u3.pathname.replace(/\/$/, "")}`;
    } catch {
    }
  }
  if (input.wid != null) return `window:${input.wid}`;
  const file = input.file_path || input.outputPath || input.path;
  if (typeof file === "string" && /\.(png|jpe?g|webp|gif)$/i.test(file)) {
    const stem = path.basename(file).replace(/\.[a-z]+$/i, "").replace(/([-_. ]?(before|after|old|new|v?\d+))+$/i, "");
    return `file:${path.dirname(file)}/${stem || path.basename(file)}`;
  }
  return null;
}
const sameShape = (a, b2) => Math.abs(a.w / a.h - b2.w / b2.h) / (b2.w / b2.h) < 0.12;
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b2) => b2?.type === "text").map((b2) => b2.text).join("\n");
}
function plain(text) {
  return text.replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)[^>]*>[\s\S]*?<\/\1>/g, " ").replace(/<\/?[a-z_][\w-]*(\s[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim();
}
const WRAPPED = /^New (?:broker )?(?:ask|message) from \S+\s+(?:Task|Message):\s*/;
const isWrapped = (text) => WRAPPED.test(text || "");
function asked(text) {
  if (!isWrapped(text)) return text;
  return text.replace(WRAPPED, "").replace(/\s*Follow the OpenScout collaboration contract:[\s\S]*$/, "").trim();
}
function prose(text) {
  return (text || "").replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1").replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?)/gm, "").replace(/\s+/g, " ").trim();
}
const hashOf = (b64) => crypto.createHash("sha1").update(b64).digest("hex").slice(0, 16);
const extOf = (media) => media === "image/jpeg" ? "jpg" : media === "image/webp" ? "webp" : media === "image/gif" ? "gif" : "png";
function noteImage(s, b64, media) {
  const hash = hashOf(b64);
  const ext = extOf(media);
  const size = imageSize(Buffer.from(b64.slice(0, 1 << 18), "base64")) || imageSize(Buffer.from(b64, "base64"));
  if (!size) return null;
  if (!places.has(hash) && s.line) places.set(hash, { file: s.file, at: s.line.at, len: s.line.len, ext });
  return { hash, ext, ...size };
}
function materialize(hash, ext) {
  const out = path.join(IMG, `${hash}.${ext}`);
  if (fs.existsSync(out)) return out;
  const p = places.get(hash);
  if (!p) return null;
  let entry;
  try {
    const fd = fs.openSync(p.file, "r");
    const buf = Buffer.alloc(p.len);
    try {
      fs.readSync(fd, buf, 0, p.len, p.at);
    } finally {
      fs.closeSync(fd);
    }
    entry = JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  if (entry.type === "response_item") entry = codexEntry(entry);
  for (const r of Array.isArray(entry?.message?.content) ? entry.message.content : []) {
    for (const part of Array.isArray(r?.content) ? r.content : []) {
      const b64 = part?.type === "image" && part.source?.data;
      if (!b64 || hashOf(b64) !== hash) continue;
      fs.mkdirSync(IMG, { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
      fs.renameSync(tmp, out);
      return out;
    }
  }
  return null;
}
function closeTurn(s) {
  const kept = [];
  for (const sc of s.turnScreens) {
    const i = sc.subject ? kept.findIndex((k2) => k2.subject === sc.subject) : -1;
    if (i >= 0) kept[i] = sc;
    else kept.push(sc);
  }
  for (const sc of kept) {
    sc.caption = prose(s.said).slice(0, 600);
    sc.provenance ||= "captured";
    const prev = sc.subject && s.lastOf.get(sc.subject);
    if (prev && prev.hash === sc.hash) continue;
    sc.revision = prev ? (prev.revision || 1) + 1 : 1;
    if (prev) sc.supersedes = prev.hash;
    if (prev && sameShape(sc, prev)) sc.before = { hash: prev.hash, ext: prev.ext, at: prev.at };
    if (sc.subject) s.lastOf.set(sc.subject, sc);
    s.screens.push(sc);
  }
  s.turnScreens = [];
  s.said = "";
}
function onEntry(s, e) {
  const at = Date.parse(e.timestamp || "") || 0;
  if (at) {
    s.firstAt ||= at;
    s.lastAt = Math.max(s.lastAt, at);
  }
  if (e.cwd && !s.cwd) s.cwd = e.cwd;
  if (e.turnEnded) {
    closeTurn(s);
    s.lastStop = "end_turn";
  }
  const m2 = e.message;
  if (!m2) return;
  const content = m2.content;
  if (e.type === "user") {
    const results = Array.isArray(content) ? content.filter((b2) => b2?.type === "tool_result") : [];
    if (!results.length) {
      const text = textOf(content);
      if (!text || e.isMeta) return;
      closeTurn(s);
      s.turn++;
      const marks = [...text.matchAll(MARK)].map((x2) => x2[1]);
      if (marks.length) {
        for (const id of marks) {
          s.arrived[id] = at;
          s.answers[id] = [];
        }
        s.mark = marks;
      } else {
        s.mark = null;
        if (!s.prompt) s.prompt = asked(plain(text)).slice(0, 200);
      }
      return;
    }
    for (const r of results) {
      s.openTools = Math.max(0, s.openTools - 1);
      const use = s.uses.get(r.tool_use_id) || { name: "", input: {} };
      s.uses.delete(r.tool_use_id);
      const parts = Array.isArray(r.content) ? r.content : typeof r.content === "string" ? [{ type: "text", text: r.content }] : [];
      const text = textOf(parts);
      let hadInlineImage = false;
      for (const p of parts) {
        if (p?.type !== "image" || p.source?.type !== "base64") continue;
        const img = noteImage(s, p.source.data, p.source.media_type);
        if (!img || img.w < MIN_W || img.h < MIN_H) continue;
        hadInlineImage = true;
        const url = text.match(/"url"\s*:\s*"([^"]+)"/)?.[1] || use.input.url || null;
        s.turnScreens.push({
          hash: img.hash,
          ext: img.ext,
          w: img.w,
          h: img.h,
          at,
          turn: s.turn,
          tool: use.name,
          url,
          file: use.input.file_path || use.input.outputPath || null,
          subject: subjectOf(use.name, use.input, text)
        });
      }
      if (!hadInlineImage && (s.cwd || s.extraRoots.length)) {
        const extracted = extractToolArtifacts(use.name, use.input, text, use.rawPatch);
        if (extracted.screenshots.length) {
          const allowed = allowedRootsFor(s.cwd, s.extraRoots);
          for (const candidate of extracted.screenshots) {
            const img = ingestImageFile(candidate, s.cwd, allowed, { at: at || Date.now() });
            if (!img) continue;
            const url = text.match(/"url"\s*:\s*"([^"]+)"/)?.[1] || use.input.url || null;
            s.turnScreens.push({
              hash: img.hash,
              ext: img.ext,
              w: img.w,
              h: img.h,
              at: img.at,
              turn: s.turn,
              tool: use.name,
              url,
              file: img.file,
              subject: subjectOf(use.name, { ...use.input, file_path: img.file }, text)
            });
          }
        }
      }
    }
    return;
  }
  if (e.type === "assistant") {
    s.lastStop = m2.stop_reason || s.lastStop;
    if (!Array.isArray(content)) return;
    for (const b2 of content) {
      if (b2?.type === "tool_use") {
        s.uses.set(b2.id, { name: b2.name, input: b2.input || {}, rawPatch: b2.rawPatch || "" });
        s.openTools++;
        s.now = { at, text: describe(b2.name, b2.input || {}) };
        if (s.cwd || s.extraRoots.length) {
          const extracted = extractToolArtifacts(b2.name, b2.input || {}, "", b2.rawPatch || "");
          if (extracted.docs.length || extracted.screenshots.length) {
            const allowed = allowedRootsFor(s.cwd, s.extraRoots);
            for (const docPath of extracted.docs) {
              const sh = registerLocalShow(docPath, s.cwd, allowed, {
                sessionId: s.owner,
                harness: s.harness || "claude",
                worktree: s.cwd,
                at: at || void 0
              });
              if (sh) s.writtenShows.set(sh.id, sh);
            }
            for (const shotPath of extracted.screenshots) {
              const img = ingestImageFile(shotPath, s.cwd, allowed, { at: at || void 0 });
              if (img) {
                s.turnScreens.push({
                  hash: img.hash,
                  ext: img.ext,
                  w: img.w,
                  h: img.h,
                  at: img.at,
                  turn: s.turn,
                  tool: b2.name,
                  url: b2.input?.url || null,
                  file: img.file,
                  subject: subjectOf(b2.name, { ...b2.input || {}, file_path: img.file }, "")
                });
              }
            }
          }
        }
      }
      if (b2?.type === "text" && b2.text?.trim()) {
        s.said = b2.text;
        if (said(b2.text)) s.now = { at, text: said(b2.text) };
        if (s.mark) for (const id of s.mark) s.answers[id].push({ at, text: b2.text.trim().slice(0, 4e3) });
      }
    }
  }
}
const tick = () => new Promise((r) => setImmediate(r));
const reading = /* @__PURE__ */ new Map();
function readTranscript(file, owner, meta) {
  if (!reading.has(file)) reading.set(file, read(file, owner, meta).finally(() => reading.delete(file)));
  return reading.get(file);
}
async function read(file, owner, meta = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    states.delete(file);
    return null;
  }
  let s = states.get(file);
  if (!s || st.size < s.offset) {
    s = fresh(file, owner, meta);
    states.set(file, s);
  }
  if (meta.harness) s.harness = meta.harness;
  if (meta.brainDir && !s.extraRoots.includes(meta.brainDir)) s.extraRoots.push(meta.brainDir);
  s.size = st.size;
  if (st.size > s.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const STEP = 4 << 20;
      while (s.offset < st.size) {
        const len = Math.min(STEP, st.size - s.offset);
        const chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, s.offset);
        const data = s.carry.length ? Buffer.concat([s.carry, chunk]) : chunk;
        const base = s.offset - s.carry.length;
        s.offset += len;
        let pos = 0;
        for (let nl = data.indexOf(10, pos); nl >= 0; pos = nl + 1, nl = data.indexOf(10, pos)) {
          if (nl === pos) continue;
          let e;
          try {
            e = JSON.parse(data.toString("utf8", pos, nl));
          } catch {
            continue;
          }
          s.line = { at: base + pos, len: nl - pos };
          if (s.harness === "antigravity" || e.step) e = antigravityEntry(e);
          else if (s.harness === "kimi" || String(e.type || "").startsWith("turn.") || e.type === "context.append_loop_event") e = kimiEntry(e);
          else if (e.payload && !e.message) e = codexEntry(e);
          if (e) onEntry(s, e);
        }
        s.carry = Buffer.from(data.subarray(pos));
        s.line = null;
        await tick();
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  s.mtime = st.mtimeMs;
  return s;
}
const stateOf$1 = (file) => states.get(file) || null;
function screensOf$1(s) {
  const open = s.turnScreens.map((sc) => {
    const prev = sc.subject && s.lastOf.get(sc.subject);
    return {
      ...sc,
      provenance: sc.provenance || "captured",
      revision: prev && prev.hash !== sc.hash ? (prev.revision || 1) + 1 : prev?.revision || 1,
      ...prev && prev.hash !== sc.hash ? { supersedes: prev.hash } : {},
      caption: prose(s.said).slice(0, 600),
      open: true
    };
  });
  return [...s.screens, ...open];
}
const root = path.join(HOME, "shared-screens");
const valid = (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(id);
const portable = (id) => typeof id === "string" && /^studio-[0-9a-f]{32}$/.test(id);
function sharedScreens(session) {
  if (!valid(session)) return [];
  const dir = path.join(root, session);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const screens = [];
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    try {
      screens.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
    } catch {
    }
  }
  return screens.sort((a, b2) => b2.at - a.at);
}
function sharedInWindow(since) {
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirs.filter((d) => d.isDirectory()).flatMap((d) => {
    const screens = sharedScreens(d.name).filter((s) => s.at >= since);
    return screens.length ? [{ id: d.name, screens }] : [];
  });
}
const WORKING_MS = 9e4;
let discovery = { url: "", at: 0, up: false, byId: /* @__PURE__ */ new Map() };
const FOLLOW = 24;
async function discover() {
  const url = runtimeUrl();
  if (discovery.url === url && Date.now() - discovery.at < 15e3) return discovery;
  const next2 = { url, at: Date.now(), up: false, byId: /* @__PURE__ */ new Map() };
  try {
    const res = await fetch(`${url}/v1/tail/discover`, { signal: AbortSignal.timeout(5e3) });
    if (res.ok) {
      const d = await res.json();
      next2.up = true;
      for (const t of d.transcripts || []) next2.byId.set(t.sessionId, t);
    }
  } catch {
  }
  discovery = next2;
  return next2;
}
function openSessions() {
  const dir = path.join(os.homedir(), ".claude", "sessions");
  const open = /* @__PURE__ */ new Map();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return open;
  }
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      process.kill(r.pid, 0);
      if (r.sessionId) open.set(r.sessionId, { pid: r.pid, status: r.status || "", kind: r.kind || "", name: r.name || "" });
    } catch {
    }
  }
  return open;
}
const repoCache = /* @__PURE__ */ new Map();
function repoOf(cwd) {
  if (!cwd) return { root: "", name: "unknown" };
  if (repoCache.has(cwd)) return repoCache.get(cwd);
  let root2 = cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, "");
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4e3 }).trim();
    if (common) root2 = common.endsWith("/.git") ? path.dirname(common) : common;
  } catch {
    const parent = path.dirname(root2), base = path.basename(root2);
    let sibs = [];
    try {
      sibs = fs.readdirSync(parent).filter((n) => base.startsWith(`${n}-`) && fs.existsSync(path.join(parent, n, ".git")));
    } catch {
    }
    const best = sibs.sort((a, b2) => b2.length - a.length)[0];
    if (best) root2 = path.join(parent, best);
  }
  const r = { root: root2, name: path.basename(root2) || root2 };
  repoCache.set(cwd, r);
  return r;
}
const branchCache = /* @__PURE__ */ new Map();
function branchOf(cwd) {
  if (!cwd) return "";
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 6e4) return hit.v;
  let v2 = "";
  try {
    v2 = execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3e3 }).trim();
  } catch {
  }
  branchCache.set(cwd, { at: Date.now(), v: v2 });
  return v2;
}
function transcriptsSince(since) {
  const out = [...codexFiles(since), ...extraHarnessFiles(since)];
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const base = path.join(CLAUDE_PROJECTS, d);
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(base, n);
      if (n.endsWith(".jsonl")) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= since) out.push({ file: p, session: n.slice(0, -6), harness: "claude", mtime: st.mtimeMs, size: st.size });
        } catch {
        }
      } else if (!n.includes(".")) {
        const sub = path.join(p, "subagents");
        let subs2 = [];
        try {
          subs2 = fs.readdirSync(sub).filter((x2) => x2.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const x2 of subs2) {
          const f = path.join(sub, x2);
          try {
            const st = fs.statSync(f);
            if (st.mtimeMs >= since) out.push({ file: f, session: n, harness: "claude", subagent: true, mtime: st.mtimeMs, size: st.size });
          } catch {
          }
        }
      }
    }
  }
  return out;
}
const MAX_LONG_WINDOW_FILES = 80;
const loads = /* @__PURE__ */ new Map();
function load$2(hours) {
  const curUrl = runtimeUrl();
  const was = loads.get(hours);
  if (was && was.url === curUrl && (!was.done || was.files.length > 0 && Date.now() - was.endedAt < 1e4)) return was;
  let files = transcriptsSince(Date.now() - hours * 36e5).sort((a, b2) => b2.mtime - a.mtime);
  if (hours > 72 && files.length > MAX_LONG_WINDOW_FILES) files = files.slice(0, MAX_LONG_WINDOW_FILES);
  const l = { url: curUrl, files, done: files.length === 0, endedAt: files.length === 0 ? Date.now() : 0, first: !was, start: new Map(files.map((t) => [t.file, stateOf$1(t.file)?.offset || 0])) };
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
  return [d?.customTitle, d?.aiTitle, d?.title, d?.harnessTitle, o?.name, d?.sessionName].find((t) => t && !/^session-[a-z0-9]+-[a-z0-9]+/.test(t) && !isWrapped(t)) || own?.prompt?.slice(0, 80) || fallback;
}
function stackFallbackProjectRevisions(project) {
  const provenanceOrder = { workspace: 0, captured: 1, written: 2, shown: 3 };
  const entries2 = [];
  for (const session of project.sessions) {
    for (const sh of session.shows || []) {
      const subject = sh.subject || deriveSurfaceSubject({
        sourcePath: sh.path,
        projectRoot: project.root,
        kind: sh.view === "html" ? "html" : sh.view === "markdown" ? "markdown" : sh.view === "image" ? "screen" : "document"
      });
      sh.subject = subject;
      sh.provenance ||= "shown";
      entries2.push({ kind: "show", ref: sh, key: subject.key, at: sh.at, prov: sh.provenance, sha: sh.sha256 || sh.id });
    }
    for (const sc of session.screens || []) {
      const subject = sc.subject && typeof sc.subject === "object" ? sc.subject : deriveSurfaceSubject({
        url: sc.url || void 0,
        sourcePath: sc.file || `${sc.hash}.${sc.ext}`,
        projectRoot: project.root,
        kind: "screen"
      });
      sc.subject = subject;
      sc.provenance ||= sc.tool === "workspace" ? "workspace" : "captured";
      entries2.push({ kind: "screen", ref: sc, key: subject.key, at: sc.at, prov: sc.provenance, sha: sc.sha256 || sc.hash });
    }
  }
  const bySubject = /* @__PURE__ */ new Map();
  for (const e of entries2) {
    const list = bySubject.get(e.key);
    if (list) list.push(e);
    else bySubject.set(e.key, [e]);
  }
  for (const group of bySubject.values()) {
    group.sort((a, b2) => a.at - b2.at || (provenanceOrder[a.prov] ?? 0) - (provenanceOrder[b2.prov] ?? 0));
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
function buildObservedProjects(inventory, since, bySession, disc, open) {
  const rawItems = (inventory.items || []).filter((item) => (item.createdAt || 0) >= since);
  const screenById = /* @__PURE__ */ new Map();
  for (const item of inventory.items || []) {
    if (item.kind !== "screen" || item.provenance === "shown") continue;
    screenById.set(item.id, {
      item,
      hash: surfaceScreenHash(item),
      ext: extFromMedia(item.mediaType, item.sourcePath),
      w: item.dimensions?.width || 1280,
      h: item.dimensions?.height || 800
    });
  }
  const showGroups = /* @__PURE__ */ new Map();
  const screenItems = [];
  for (const item of rawItems) {
    if (item.kind === "screen" && item.provenance !== "shown") {
      screenItems.push(item);
      continue;
    }
    const gKey = `${item.projectRoot || ""}\0${item.subject?.key || item.sourcePath || item.id}`;
    const list = showGroups.get(gKey);
    if (list) list.push(item);
    else showGroups.set(gKey, [item]);
  }
  const projects = /* @__PURE__ */ new Map();
  const sessionBuckets = /* @__PURE__ */ new Map();
  function ensureBucket(projectRoot, worktree, branch, sid, harness, provenance) {
    const repo = repoOf(projectRoot || worktree);
    const rootKey = repo.root || projectRoot || worktree;
    if (!projects.has(rootKey)) {
      projects.set(rootKey, { name: repo.name, root: rootKey, sessions: [] });
    }
    const bKey = `${rootKey}\0${sid}`;
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
        shows: []
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
    const sid = item.session?.nativeSessionId || (item.provenance === "workspace" ? `workspace:${repo.name}` : `captured:${repo.name}`);
    const harness = item.session?.harness || (item.provenance === "workspace" ? "scout" : "claude");
    const bucket = ensureBucket(item.projectRoot, item.worktree, item.branch, sid, harness, item.provenance);
    const cur = screenById.get(item.id) || {
      hash: surfaceScreenHash(item),
      ext: extFromMedia(item.mediaType, item.sourcePath),
      w: item.dimensions?.width || 1280,
      h: item.dimensions?.height || 800
    };
    const prev = item.supersedes ? screenById.get(item.supersedes) : null;
    const before = prev && sameShape({ w: cur.w, h: cur.h }, { w: prev.w, h: prev.h }) ? { hash: prev.hash, ext: prev.ext, at: prev.item.createdAt } : null;
    bucket.screens.push({
      id: `${sid}:${cur.hash}`,
      surfaceId: item.id,
      hash: cur.hash,
      ext: cur.ext,
      w: cur.w,
      h: cur.h,
      at: item.createdAt,
      tool: item.provenance === "workspace" ? "workspace" : item.session?.harness || "captured",
      url: item.url || null,
      file: item.sourcePath || null,
      caption: item.caption || item.title || "",
      before,
      open: false,
      provenance: item.provenance,
      revision: item.revision || 1,
      ...item.supersedes ? { supersedes: item.supersedes } : {},
      ...item.subject ? { subject: item.subject } : {}
    });
  }
  for (const group of showGroups.values()) {
    group.sort((a, b2) => (a.revision || 1) - (b2.revision || 1) || a.createdAt - b2.createdAt);
    const latest = group[group.length - 1];
    const repo = repoOf(latest.projectRoot || latest.worktree);
    const sid = latest.session?.nativeSessionId || (latest.provenance === "workspace" ? `workspace:${repo.name}` : `shown:${latest.worktree || latest.projectRoot || repo.name}`);
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
      ...latest.supersedes ? { supersedes: latest.supersedes } : {},
      ...latest.subject ? { subject: latest.subject } : {}
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
    const seenScreenHashes = /* @__PURE__ */ new Set();
    const screens = [];
    for (const sc of bucket.screens.sort((a, b2) => a.at - b2.at)) {
      if (seenScreenHashes.has(sc.hash)) continue;
      seenScreenHashes.add(sc.hash);
      screens.push(sc);
    }
    const shows = bucket.shows.sort((a, b2) => b2.at - a.at);
    if (!screens.length && !shows.length) continue;
    const allAt = [
      ...all.map((s) => s.lastAt || 0),
      ...screens.map((sc) => sc.at || 0),
      ...shows.map((sh) => sh.at || 0)
    ].filter((x2) => x2 > 0);
    const lastAt = allAt.length ? Math.max(...allAt) : Date.now();
    const firstAt = own?.firstAt || (allAt.length ? Math.min(...allAt) : lastAt);
    const working = !!o && (o.status === "busy" || Date.now() - lastAt < WORKING_MS && (!own || own.lastStop !== "end_turn" || own.openTools > 0));
    const defaultTitle = bucket.sid.startsWith("workspace:") ? `Workspace · ${bucket.repo.name}` : bucket.sid.startsWith("shown:") ? `Shown from ${path.basename(cwd)}` : shows[0]?.caption || screens[0]?.caption || bucket.sid.slice(0, 8);
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
      now: all.map((s) => s.now).filter(Boolean).sort((a, b2) => b2.at - a.at)[0]?.text || null,
      screens,
      shows
    });
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
        shows: []
      };
      group.sessions.push(session);
    }
    const seenHashes = new Set(session.screens.map((s) => s.hash));
    for (const sc of screens) {
      if (!seenHashes.has(sc.hash)) {
        session.screens.push({ ...sc, id: `${id}:${sc.hash}`, provenance: "captured", revision: 1 });
      }
    }
    session.screens.sort((a, b2) => a.at - b2.at);
    session.lastAt = Math.max(session.lastAt, first.at);
  }
  return [...projects.values()].filter((p) => p.sessions.length > 0);
}
async function canvas(hours = 4) {
  const since = Date.now() - hours * 36e5;
  const l = load$2(hours);
  const [disc, obs] = await Promise.all([discover(), observedSurfaces(hours * 36e5)]);
  const open = openSessions();
  const bySession = /* @__PURE__ */ new Map();
  let read2 = 0, total = 0;
  const partial = /* @__PURE__ */ new Set();
  for (const t of l.files) {
    const s = stateOf$1(t.file);
    const from = l.start.get(t.file) || 0;
    total += Math.max(0, t.size - from);
    read2 += s ? Math.max(0, Math.min(s.offset, t.size) - from) : 0;
    if (!s || s.offset < t.size) partial.add(t.session);
    if (!s) continue;
    s.harness = t.harness || "claude";
    let rec = bySession.get(t.session);
    if (!rec) bySession.set(t.session, rec = { id: t.session, own: null, parts: [] });
    if (t.subagent) rec.parts.push(s);
    else rec.own = s;
  }
  const seen = /* @__PURE__ */ new Map();
  const cwdBySession = /* @__PURE__ */ new Map();
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
  const latestFor = /* @__PURE__ */ new Map();
  for (const [cwd, at] of seen) {
    const r = repoOf(cwd).root;
    if (r) latestFor.set(r, Math.max(latestFor.get(r) || 0, at));
  }
  const roots = [...latestFor].sort((a, b2) => b2[1] - a[1]).map(([r]) => r).slice(0, FOLLOW);
  const runtimeUp = disc.up || obs.reachable;
  if (obs.supported && obs.inventory) {
    watchShows(roots);
    const list2 = buildObservedProjects(obs.inventory, since, bySession, disc, open);
    for (const p of list2) p.sessions.sort((a, b2) => b2.lastAt - a.lastAt);
    list2.sort((a, b2) => b2.sessions[0].lastAt - a.sessions[0].lastAt);
    const sessionsCount = (/* @__PURE__ */ new Set([
      ...l.files.map((t) => t.session),
      ...list2.flatMap((p) => p.sessions.map((s) => s.id))
    ])).size;
    const out2 = {
      at: Date.now(),
      hours,
      scout: {
        up: true,
        observedSurfaces: true,
        url: runtimeUrl(),
        shows: obs.inventory.counts?.shown ?? list2.flatMap((p) => p.sessions.flatMap((s) => s.shows)).filter((sh) => sh.provenance === "shown").length,
        counts: obs.inventory.counts
      },
      projects: list2,
      loading: { done: true, first: l.first, read: total, total, sessions: sessionsCount }
    };
    completed.add(hours);
    keepSnapshot(hours, out2);
    return out2;
  }
  const shows = runtimeUp ? (await showsFor(roots)).filter((sh) => sh.at >= since) : [];
  if (runtimeUp) watchShows(roots);
  const showsBy = /* @__PURE__ */ new Map();
  for (const sh of shows) showsBy.set(sh.sessionId, [...showsBy.get(sh.sessionId) || [], sh]);
  const brainBySession = /* @__PURE__ */ new Map();
  for (const b2 of antigravityBrainAssets(since, cwdBySession)) brainBySession.set(b2.session, b2);
  const projects = /* @__PURE__ */ new Map();
  for (const rec of bySession.values()) {
    const all = [rec.own, ...rec.parts].filter(Boolean);
    const brain = brainBySession.get(rec.id);
    brainBySession.delete(rec.id);
    const written = [];
    const seenShowPaths = /* @__PURE__ */ new Set();
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
      const priorWritten = written.find((w2) => w2.path === sh.path);
      if (priorWritten && priorWritten.sha256 && sh.sha256 && priorWritten.sha256 !== sh.sha256) {
        sh.revision = Math.max(sh.revision || 1, 2);
        sh.versions = Math.max(sh.versions || 1, 2);
        sh.supersedes ||= priorWritten.id;
      }
    }
    const shown = [...runtimeShown, ...written.filter((w2) => !runtimeShown.some((r) => r.path === w2.path))].sort((a, b2) => b2.at - a.at);
    const rawScreens = [
      ...all.flatMap(screensOf$1).filter((sc) => sc.at >= since),
      ...brain?.screens || []
    ];
    const dedupScreens = [];
    const seenHashes = /* @__PURE__ */ new Set();
    for (const sc of rawScreens.sort((a, b2) => a.at - b2.at)) {
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
      ...shown.map((sh) => sh.at || 0)
    );
    const working = !!o && (o.status === "busy" || Date.now() - lastAt < WORKING_MS && (own.lastStop !== "end_turn" || own.openTools > 0));
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
      now: all.map((s) => s.now).filter(Boolean).sort((a, b2) => b2.at - a.at)[0]?.text || null,
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
        ...sc.supersedes ? { supersedes: sc.supersedes } : {}
      })),
      shows: shown
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
        revision: sc.revision || 1
      })),
      shows: brain.shows.map((sh) => ({ ...sh, provenance: sh.provenance || "written" }))
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
        shows: (showsBy.get(id) || []).map((sh) => ({ ...sh, provenance: "shown" }))
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
    session.screens.sort((a, b2) => a.at - b2.at);
    session.lastAt = Math.max(session.lastAt, first.at);
  }
  for (const [sid, list2] of showsBy) {
    const first = list2[0], repo = repoOf(first.projectRoot);
    const session = {
      id: sid || `shown:${first.worktree}`,
      harness: first.harness || "scout",
      cwd: first.worktree,
      branch: first.branch,
      title: `Shown from ${path.basename(first.worktree)}`,
      prompt: "",
      firstAt: Math.min(...list2.map((x2) => x2.at)),
      lastAt: Math.max(...list2.map((x2) => x2.at)),
      open: false,
      working: false,
      attention: null,
      now: null,
      screens: [],
      shows: list2.map((sh) => ({ ...sh, provenance: "shown" }))
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
        ...(s.screens || []).map((sc) => sc.file).filter(Boolean)
      ])
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
        revision: sc.revision || 1
      })),
      shows: unclaimedShows
    };
    if (!projects.has(repo.root)) projects.set(repo.root, { name: repo.name, root: repo.root, sessions: [] });
    projects.get(repo.root).sessions.push(wsSession);
  }
  const list = [...projects.values()];
  for (const p of list) {
    stackFallbackProjectRevisions(p);
    p.sessions.sort((a, b2) => b2.lastAt - a.lastAt);
  }
  list.sort((a, b2) => b2.sessions[0].lastAt - a.sessions[0].lastAt);
  const sessions = new Set(l.files.map((t) => t.session)).size;
  const out = {
    at: Date.now(),
    hours,
    scout: { up: runtimeUp, observedSurfaces: false, url: runtimeUrl(), shows: shows.length },
    projects: list,
    loading: { done: l.done, first: l.first, read: read2, total, sessions }
  };
  if (l.done) {
    completed.add(hours);
    keepSnapshot(hours, out);
  } else if (!completed.has(hours)) out.projects = merge(snapshot(hours, since), list, partial);
  return out;
}
const completed = /* @__PURE__ */ new Set();
const snapFile = (hours) => path.join(HOME, `canvas-${hours}h.json`);
const snapshots = /* @__PURE__ */ new Map();
function snapshot(hours, since) {
  if (!snapshots.has(hours)) {
    let projects = [];
    try {
      projects = JSON.parse(fs.readFileSync(snapFile(hours), "utf8")).projects || [];
    } catch {
    }
    snapshots.set(hours, projects);
  }
  return snapshots.get(hours).map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.lastAt >= since).map((s) => ({ ...s, working: false, shows: s.shows || [] })) })).filter((p) => p.sessions.length);
}
const savedAt = /* @__PURE__ */ new Map();
function keepSnapshot(hours, out) {
  if (Date.now() - (savedAt.get(hours) || 0) < 3e4) return;
  savedAt.set(hours, Date.now());
  fs.mkdir(HOME, { recursive: true }, () => fs.writeFile(snapFile(hours), JSON.stringify({ at: out.at, projects: out.projects }), () => {
  }));
}
function merge(old, fresh2, partial) {
  const projects = new Map(old.map((p) => [p.root, { ...p, sessions: [...p.sessions] }]));
  for (const p of fresh2) {
    const o = projects.get(p.root);
    if (!o) {
      projects.set(p.root, p);
      continue;
    }
    const had = new Map(o.sessions.map((s) => [s.id, s]));
    const take = p.sessions.filter((s) => !(partial.has(s.id) && had.has(s.id)));
    const ids = new Set(take.map((s) => s.id));
    o.sessions = [...take, ...o.sessions.filter((s) => !ids.has(s.id))].sort((a, b2) => b2.lastAt - a.lastAt);
  }
  return [...projects.values()].sort((a, b2) => b2.sessions[0].lastAt - a.sessions[0].lastAt);
}
async function touch(file) {
  const meta = classifyTranscriptFile(file);
  if (!meta) return;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return;
  }
  for (const l of loads.values()) {
    if (l.files.some((t) => t.file === file)) continue;
    l.files.unshift({ file, ...meta, mtime: st.mtimeMs, size: st.size });
    l.start.set(file, 0);
  }
  await readTranscript(file, meta.session, meta).catch(() => null);
}
async function stateOf(sessionId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(sessionId)) return null;
  const codex = codexFiles(0, sessionId)[0];
  if (codex) return readTranscript(codex.file, sessionId, codex);
  const extra = extraHarnessFiles(0, sessionId)[0];
  if (extra) return readTranscript(extra.file, sessionId, extra);
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(CLAUDE_PROJECTS, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return readTranscript(f, sessionId, { harness: "claude" });
  }
  return null;
}
const isOpen = (sessionId) => openSessions().get(sessionId) || null;
let listeners = /* @__PURE__ */ new Set();
const changed$1 = () => {
  for (const fn of listeners) try {
    fn();
  } catch {
  }
};
function load$1() {
  try {
    return JSON.parse(fs.readFileSync(NOTES, "utf8"));
  } catch {
    return [];
  }
}
function save$1(list) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${NOTES}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, NOTES);
  changed$1();
}
function update(id, fn) {
  const list = load$1();
  const n = list.find((x2) => x2.id === id);
  if (!n) return null;
  fn(n);
  save$1(list);
  return n;
}
function step(n, ev) {
  const last = n.trail.at(-1);
  if (last && last.what === ev.what && last.why === ev.why) return;
  n.trail.push({ ...ev, at: Date.now() });
}
let bin = null;
function scoutBin() {
  return bin || (bin = findScout()) || "scout";
}
function scout(args, timeout = 6e4) {
  return new Promise((resolve) => {
    execFile(scoutBin(), ["--json", ...args], { timeout, maxBuffer: 16e6 }, (err, out) => {
      let json = null;
      try {
        json = JSON.parse(String(out).slice(String(out).indexOf("{")));
      } catch {
      }
      resolve({ json, err: err && !json ? String(err.message || err).slice(0, 200) : null });
    });
  });
}
function message(n) {
  const where = `${Math.round(n.x * 100)}% across, ${Math.round(n.y * 100)}% down`;
  const of = n.screen.url ? ` of ${n.screen.url}` : n.screen.file ? ` (${n.screen.file})` : "";
  if (n.re) {
    return [
      `A reply from Scout Studio to what you pointed at on a screen you took${of}, at ${where} [scout-studio:${n.id}] (pointer ${n.re}).`,
      ...n.reSay ? ["", `You said: ${n.reSay}`] : [],
      "",
      `They answered: ${n.text}`,
      "",
      `The screen is ${path.join(IMG, `${n.screen.hash}.${n.screen.ext}`)}. Answer here as usual; the canvas shows your reply beside theirs.`
    ].join("\n");
  }
  return [
    `A note from Scout Studio on a screen you took${of}, at ${where} [scout-studio:${n.id}]:`,
    "",
    n.text,
    "",
    `The screen is ${path.join(IMG, `${n.screen.hash}.${n.screen.ext}`)}. Answer here as usual; the canvas shows your reply beside the note.`
  ].join("\n");
}
const carrying = /* @__PURE__ */ new Set();
async function deliver(id) {
  const n = load$1().find((x2) => x2.id === id);
  if (!n || carrying.has(id)) return;
  const last = n.trail.at(-1)?.what;
  if (["sent", "handed", "available"].includes(last) || n.kept || n.readAt) return;
  if (portable(n.session) || n.harness && n.harness !== "claude" && n.harness !== "codex") {
    update(id, (x2) => step(x2, { what: "available" }));
    return;
  }
  if (n.harness !== "codex" && !isOpen(n.session)) {
    update(id, (x2) => step(x2, { what: "waiting" }));
    return;
  }
  carrying.add(id);
  try {
    await materializeRuntimeScreen(n.screen.hash, n.screen.ext);
    const { json, err } = await scout(["session", "send", n.session, message(n), ...n.harness === "codex" ? ["--harness", "codex"] : []]);
    update(id, (x2) => {
      if (json?.ok) {
        step(x2, { what: "sent", how: json.delivery || json.route || json.host || null });
        x2.sentAt = Date.now();
      } else if (json?.code === "not_live") step(x2, { what: "waiting" });
      else {
        step(x2, { what: "failed", why: json?.code || json?.error?.message || json?.error || err || "no answer from scout" });
        x2.tries = (x2.tries || 0) + 1;
      }
    });
  } finally {
    carrying.delete(id);
  }
}
async function handOff(id) {
  const n = load$1().find((x2) => x2.id === id);
  if (!n || portable(n.session) || n.harness && n.harness !== "claude") return null;
  const { json, err } = await scout(["ask", "--project", n.cwd, "--harness", "claude", "--label", "scout-studio", message(n)], 12e4);
  const ok = json && json.ok !== false && json.receipt?.ok !== false;
  return update(id, (x2) => {
    if (ok) step(x2, { what: "handed", task: json.receipt?.taskId || json.taskId || json.handle || null });
    else step(x2, { what: "failed", why: json?.receipt?.reason || json?.error?.message || json?.error || err || "Scout refused it" });
  });
}
async function notes() {
  return Promise.all(load$1().map(async (n) => {
    const s = n.trail.some((t) => t.what === "sent") ? await stateOf(n.session) : null;
    return { ...n, arrivedAt: n.readAt || s?.arrived[n.id] || null, answers: [...s?.answers[n.id] || [], ...n.directAnswers || []].sort((a, b2) => a.at - b2.at) };
  }));
}
function feedback(session, note, reply) {
  if (!session || typeof session !== "string") throw Error("Choose a session.");
  const list = load$1();
  const mine = list.filter((n) => n.session === session);
  if (note !== void 0 || reply !== void 0) {
    const n = mine.find((n2) => n2.id === note);
    if (!n || typeof reply !== "string" || !reply.trim()) throw Error("Give a note from this session and a reply.");
    const text = reply.trim().slice(0, 4e3);
    n.directAnswers ||= [];
    if (n.directAnswers.at(-1)?.text !== text) n.directAnswers.push({ text, at: Date.now() });
  }
  const unread = mine.filter((n) => !n.readAt);
  for (const n of unread) n.readAt = Date.now();
  if (unread.length || note) save$1(list);
  return mine.map((n) => ({
    id: n.id,
    text: n.text,
    screen: n.screen,
    x: n.x,
    y: n.y,
    at: n.at,
    pointer: n.re,
    answering: n.reSay,
    replies: n.directAnswers || []
  }));
}
function addNote({ session, harness, project, cwd, screen, x: x2, y: y2, text, re: re2, reSay }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(session || "") || !screen?.hash || typeof text !== "string" || !text.trim()) return null;
  const n = {
    id: `n_${crypto.randomBytes(5).toString("hex")}`,
    session,
    harness,
    project: project || "",
    cwd: cwd || "",
    screen: { hash: screen.hash, ext: screen.ext || "png", w: screen.w, h: screen.h, url: screen.url || null, file: screen.file || null },
    x: Math.min(1, Math.max(0, Number(x2) || 0)),
    y: Math.min(1, Math.max(0, Number(y2) || 0)),
    text: text.trim().slice(0, 4e3),
    at: Date.now(),
    trail: [],
    // a reply to a pointer the session made: the session hears what it is an answer to
    ...typeof re2 === "string" && /^p_[a-z0-9]+$/.test(re2) ? { re: re2, reSay: String(reSay || "").slice(0, 2e3) } : {}
  };
  materialize(n.screen.hash, n.screen.ext);
  save$1([...load$1(), n]);
  deliver(n.id);
  return n;
}
function retry(id) {
  update(id, (x2) => {
    x2.tries = 0;
  });
  return deliver(id);
}
function keep(id, kept = true) {
  return update(id, (x2) => {
    x2.kept = kept;
  });
}
function remove(id) {
  save$1(load$1().filter((x2) => x2.id !== id));
}
let timer$1 = null;
function startSweep() {
  if (timer$1) return;
  timer$1 = setInterval(() => {
    for (const n of load$1()) {
      const last = n.trail.at(-1)?.what;
      if (!n.kept && !n.readAt && last !== "available" && last !== "sent" && last !== "handed" && !(last === "failed" && n.tries >= 6)) deliver(n.id);
    }
  }, 2e4);
  timer$1.unref?.();
}
function findSession({ session: id }) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(id)) return null;
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {
  }
  for (const d of dirs) {
    const file = path.join(CLAUDE_PROJECTS, d, `${id}.jsonl`);
    if (fs.existsSync(file)) return { id, file };
  }
  const codex = codexFiles(0, id)[0];
  return { id, file: codex?.file || null };
}
async function screensFor({ id, file }) {
  const shared = sharedScreens(id);
  if (!file) return shared;
  const files = [file];
  const sub = path.join(path.dirname(file), id, "subagents");
  try {
    for (const n of fs.readdirSync(sub)) if (n.endsWith(".jsonl")) files.push(path.join(sub, n));
  } catch {
  }
  const all = [...shared];
  for (const f of files) {
    const s = await readTranscript(f, id);
    if (s) all.push(...screensOf$1(s));
  }
  return all.sort((a, b2) => b2.at - a.at);
}
function pickScreen(screens, which = "latest") {
  if (!screens.length) return null;
  if (!which || which === "latest") return screens[0];
  if (/^[0-9a-f]{4,16}$/.test(which)) {
    const s = screens.find((x2) => x2.hash.startsWith(which));
    if (s) return s;
  }
  if (/^https?:\/\//.test(which) || /^[\w.-]+:\d+/.test(which)) {
    const s = screens.find((x2) => x2.url && (x2.url === which || x2.url.includes(which.replace(/^https?:\/\//, ""))));
    if (s) return s;
  }
  const abs = path.resolve(which);
  return screens.find((x2) => x2.file === abs) || screens.find((x2) => x2.file && path.basename(x2.file) === path.basename(which)) || null;
}
function load() {
  try {
    return JSON.parse(fs.readFileSync(POINTERS, "utf8"));
  } catch {
    return [];
  }
}
function save(list) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${POINTERS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, POINTERS);
}
async function screensOf(session, limit = 12) {
  if (!session) return null;
  const s = findSession({ session });
  if (!s) return null;
  return (await screensFor(s)).slice(0, limit).map(brief);
}
const brief = (sc) => ({
  id: sc.hash,
  ext: sc.ext,
  at: new Date(sc.at).toISOString(),
  w: sc.w,
  h: sc.h,
  page: sc.url || null,
  file: sc.file || null,
  tool: sc.tool,
  settled: !sc.open,
  said: (sc.caption || "").slice(0, 160)
});
function boxOf({ x: x2, y: y2, w: w2 = 0, h = 0, unit = "px" }, screen) {
  const n = [x2, y2, w2, h].map(Number);
  if (n.some((v2) => !Number.isFinite(v2) || v2 < 0)) throw new Error("x, y, w and h must be numbers, 0 or more");
  if (unit !== "px" && unit !== "fraction") throw new Error('unit is "px" or "fraction"');
  const [fx, fy, fw, fh] = unit === "px" ? [n[0] / screen.w, n[1] / screen.h, n[2] / screen.w, n[3] / screen.h] : n;
  if (fx > 1 || fy > 1 || fx + fw > 1.001 || fy + fh > 1.001) {
    throw new Error(`that falls outside the screen, which is ${screen.w}×${screen.h} px`);
  }
  const r = (v2) => Math.round(v2 * 1e4) / 1e4;
  return { x: r(fx), y: r(fy), w: r(fw), h: r(fh) };
}
async function addPointer({ session, screen = "latest", at, say }) {
  if (!session) throw new Error("a pointer needs the session it comes from");
  const s = findSession({ session });
  if (!s) throw new Error("Invalid session.");
  const screens = await screensFor(s);
  if (!screens.length) throw new Error("this session has no screens yet; take a screenshot first");
  const sc = pickScreen(screens, screen);
  if (!sc) throw new Error(`no screen "${screen}" in this session; list them with the screens tool`);
  const box = boxOf(at || {}, sc);
  if (!materialize(sc.hash, sc.ext)) throw new Error("couldn't keep a copy of that screen");
  const p = {
    id: `p_${crypto.randomBytes(5).toString("hex")}`,
    session: s.id,
    cwd: sc.cwd || stateOf$1(s.file)?.cwd || "",
    screen: { hash: sc.hash, ext: sc.ext, w: sc.w, h: sc.h, at: sc.at, url: sc.url || null, file: sc.file || null, tool: sc.tool, caption: sc.caption || "" },
    box,
    say: typeof say === "string" ? say.trim().slice(0, 2e3) : "",
    at: Date.now(),
    seenAt: null
  };
  save([...load(), p]);
  return p;
}
async function pointer(id) {
  const p = load().find((x2) => x2.id === id);
  if (!p) return null;
  const replies = (await notes()).filter((n) => n.re === id).map((n) => ({ at: n.at, text: n.text, note: n.id }));
  return { ...p, replies };
}
async function pointersOf(session) {
  const all = await notes();
  return load().filter((p) => p.session === session).sort((a, b2) => b2.at - a.at).map((p) => ({
    ...p,
    replies: all.filter((n) => n.re === p.id).map((n) => ({ at: n.at, text: n.text, note: n.id }))
  }));
}
function markSeen(id) {
  const list = load();
  const p = list.find((x2) => x2.id === id);
  if (p && !p.seenAt) {
    p.seenAt = Date.now();
    save(list);
  }
  return p || null;
}
const WRITE_GAP = 800;
const READ_GAP = 450;
const TICK = 1e4;
const subs = /* @__PURE__ */ new Map();
const sent = /* @__PURE__ */ new Map();
const changed = /* @__PURE__ */ new Set();
let timer = null, busy = false, watchers = [], ticker = null, offShows = null;
const frame = (d) => `event: canvas
data: ${JSON.stringify(d)}

`;
const key = ({ at, ...rest }) => JSON.stringify(rest);
async function events(req, res, hours) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.write("retry: 2000\n\n");
  if (!subs.has(hours)) subs.set(hours, /* @__PURE__ */ new Set());
  subs.get(hours).add(res);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 2e4);
  req.on("close", () => {
    clearInterval(keepalive);
    subs.get(hours)?.delete(res);
    if (![...subs.values()].some((s) => s.size)) stop();
  });
  start();
  const d = await canvas(hours);
  res.write(frame(d));
  if (!d.loading.done) soon(READ_GAP);
}
function soon(ms) {
  if (!timer) timer = setTimeout(flush, ms);
}
async function flush() {
  timer = null;
  if (busy) return soon(WRITE_GAP);
  busy = true;
  let reading2 = false;
  try {
    const files = [...changed];
    changed.clear();
    for (const f of files) await touch(f);
    for (const [hours, set] of subs) {
      if (!set.size) continue;
      const d = await canvas(hours);
      if (!d.loading.done) reading2 = true;
      const k2 = key(d);
      if (k2 === sent.get(hours)) continue;
      sent.set(hours, k2);
      const msg = frame(d);
      for (const res of set) res.write(msg);
    }
  } catch {
  } finally {
    busy = false;
  }
  if (reading2) soon(READ_GAP);
}
function start() {
  if (ticker) return;
  for (const root2 of watchableRoots()) {
    try {
      const w2 = fs.watch(root2, { recursive: true }, (_2, name) => {
        if (!name) return;
        const s = String(name);
        if (s.endsWith(".jsonl")) changed.add(path.join(root2, s));
        else if (!/\.(json|html?|md|png|jpe?g|webp|gif)$/i.test(s)) return;
        soon(WRITE_GAP);
      });
      watchers.push(w2);
    } catch {
    }
  }
  offShows = onShows(() => soon(50));
  ticker = setInterval(() => soon(0), TICK);
}
function stop() {
  for (const w2 of watchers) {
    try {
      w2.close();
    } catch {
    }
  }
  watchers = [];
  offShows?.();
  offShows = null;
  clearInterval(ticker);
  ticker = null;
  sent.clear();
}
const LOCAL$1 = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
function local(req) {
  if (!LOCAL$1.test(req.headers.host || "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
const send = (res, code, body2) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body2));
};
function body(req) {
  return new Promise((resolve) => {
    let b2 = "";
    req.on("data", (c) => {
      b2 += c;
      if (b2.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(b2 || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}
const SIZES = { t: 520, m: 1600 };
const making = /* @__PURE__ */ new Map();
const queue = [];
let running = 0;
function next() {
  while (running < 4 && queue.length) {
    const job = queue.shift();
    running++;
    execFile("sips", ["-Z", String(SIZES[job.size]), "-s", "format", "jpeg", "-s", "formatOptions", "80", job.src, "--out", job.out], { timeout: 2e4 }, (e) => {
      running--;
      making.delete(job.out);
      job.ok(e ? null : job.out);
      next();
    });
  }
}
function thumb(src, hash, size = "t") {
  const out = path.join(IMG, size, `${hash}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (!making.has(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    making.set(out, new Promise((ok) => {
      queue.push({ src, out, size, ok });
      next();
    }));
  }
  return making.get(out);
}
const TYPES$1 = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
async function handle(req, res) {
  const url = new URL(req.url, "http://local");
  const p = url.pathname;
  if (!p.startsWith("/api/") && !p.startsWith("/img/")) return false;
  if (!local(req)) {
    send(res, 403, { error: "local only" });
    return true;
  }
  startSweep();
  const img = p.match(/^\/img\/(?:([tm])\/)?([0-9a-f]{16})\.(png|jpg|webp|gif)$/);
  if (img) {
    let file = materialize(img[2], img[3]) || path.join(IMG, `${img[2]}.${img[3]}`);
    if (!fs.existsSync(file)) file = await materializeRuntimeScreen(img[2], img[3]) || file;
    if (img[1] && fs.existsSync(file)) file = await thumb(file, img[2], img[1]) || file;
    if (!fs.existsSync(file)) {
      send(res, 404, { error: "no such screen" });
      return true;
    }
    res.writeHead(200, { "content-type": TYPES$1[path.extname(file).slice(1)], "cache-control": "max-age=31536000, immutable" });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  try {
    if (p === "/api/events" && req.method === "GET") {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 4));
      return await events(req, res, hours), true;
    }
    if (p === "/api/canvas" && req.method === "GET") {
      const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 4));
      return send(res, 200, await canvas(hours)), true;
    }
    const sv = p.match(/^\/api\/shows\/([A-Za-z0-9_-]{1,128})\/view$/);
    if (sv && req.method === "GET") {
      const id = sv[1];
      const localShow = localShowById(id);
      if (localShow) {
        const bytes = localShowBytes(localShow.id);
        if (!bytes) return send(res, 404, { error: "file is no longer available" }), true;
        const out2 = viewResponse({ ...localShow, view: viewOf(localShow), name: path.basename(localShow.sourcePath) }, bytes);
        res.writeHead(out2.status, out2.headers);
        res.end(out2.body);
        return true;
      }
      let obsShow = observedShowById(id);
      if (!obsShow) {
        await observedSurfaces(72 * 36e5);
        obsShow = observedShowById(id);
      }
      if (obsShow) {
        let bytes;
        try {
          bytes = await observedShowBytes(obsShow.id);
        } catch {
          return send(res, 404, { error: "surface bytes are no longer available" }), true;
        }
        const out2 = viewResponse({ ...obsShow, view: viewOf(obsShow), name: path.basename(obsShow.sourcePath) }, bytes);
        res.writeHead(out2.status, out2.headers);
        res.end(out2.body);
        return true;
      }
      let show = showById(id);
      if (!show && url.searchParams.get("root")) {
        await showsFor([url.searchParams.get("root")]);
        show = showById(id);
      }
      if (!show) return send(res, 404, { error: "Scout's runtime has no such shown file" }), true;
      const out = viewResponse({ ...show, view: viewOf(show), name: path.basename(show.sourcePath) }, await showBytes(show.id));
      res.writeHead(out.status, out.headers);
      res.end(out.body);
      return true;
    }
    if (p === "/api/notes" && req.method === "GET") return send(res, 200, { notes: await notes() }), true;
    if (p === "/api/notes" && req.method === "POST") {
      const n = addNote(await body(req));
      return send(res, n ? 200 : 400, n ? { note: n } : { error: "a note needs a session, a screen and some words" }), true;
    }
    if (p === "/api/feedback" && req.method === "POST") {
      const { session, note, reply } = await body(req);
      try {
        return send(res, 200, { notes: feedback(session, note, reply) }), true;
      } catch (e) {
        return send(res, 400, { error: e.message }), true;
      }
    }
    const m2 = p.match(/^\/api\/notes\/(n_[a-z0-9]+)(?:\/(handoff|retry|keep))?$/);
    if (m2 && req.method === "POST" && m2[2] === "handoff") return send(res, 200, { note: await handOff(m2[1]) }), true;
    if (m2 && req.method === "POST" && m2[2] === "retry") return await retry(m2[1]), send(res, 200, { ok: true }), true;
    if (m2 && req.method === "POST" && m2[2] === "keep") return send(res, 200, { note: keep(m2[1], (await body(req)).kept !== false) }), true;
    if (m2 && req.method === "DELETE" && !m2[2]) return remove(m2[1]), send(res, 200, { ok: true }), true;
    const sid = url.searchParams.get("session") || "";
    if (p === "/api/screens" && req.method === "GET") {
      const list = await screensOf(sid, Math.min(50, Number(url.searchParams.get("limit")) || 12));
      return send(res, list ? 200 : 404, list ? { screens: list } : { error: `no transcript for session ${sid}` }), true;
    }
    if (p === "/api/pointers" && req.method === "GET") return send(res, 200, { pointers: await pointersOf(sid) }), true;
    if (p === "/api/pointers" && req.method === "POST") {
      try {
        const ptr = await addPointer(await body(req));
        return send(res, 200, { pointer: ptr, url: `http://${req.headers.host}/p/${ptr.id}` }), true;
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) }), true;
      }
    }
    const pm = p.match(/^\/api\/pointers\/(p_[a-z0-9]+)(\/seen)?$/);
    if (pm && req.method === "GET" && !pm[2]) {
      const ptr = await pointer(pm[1]);
      return send(res, ptr ? 200 : 404, ptr ? { pointer: ptr } : { error: "no such pointer" }), true;
    }
    if (pm && req.method === "POST" && pm[2]) return send(res, 200, { pointer: markSeen(pm[1]) }), true;
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e?.message || e) });
  }
  return true;
}
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
function isLocalRequest(req) {
  const host = req.headers.host || "";
  if (!LOCAL.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8"
};
const THIN_SHARED_PATHS = /* @__PURE__ */ new Set([
  "/api/host-status",
  "/api/setup",
  "/api/recent-sessions",
  "/api/session-context",
  "/api/messages",
  "/v1/events/stream",
  "/v1/tail/events"
]);
function isThinSharedRoute(pathname) {
  return THIN_SHARED_PATHS.has(pathname) || pathname.startsWith("/api/session-ref/");
}
const handleThinRoutes = createScoutThinHttpHandler({
  packageName: "@openscout/studio",
  product: "Studio",
  apiHandler: async (req, res, { pathname }) => {
    if (req.method === "GET" && pathname === "/api/host-status") {
      const base = runtimeUrl$1();
      const runtimeUp = await checkRuntime(base);
      const localSessions = scanLocalFeedSessions({ maxPerHarness: 15, limit: 30 }).length;
      sendJson(res, 200, { runtimeUp, runtimeUrl: base, localSessions });
      return true;
    }
    return false;
  }
});
function createStudioServer() {
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (isThinSharedRoute(url.pathname)) {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: "local only" });
        return;
      }
      if (await handleThinRoutes(req, res)) return;
    }
    if (await handle(req, res)) return;
    const u3 = url.pathname;
    const rel = path.normalize(u3).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    let file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, "index.html");
    }
    if (!fs.existsSync(file)) {
      sendJson(res, 503, { error: "dist/index.html is missing. Run npm run build first." });
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600"
    });
    fs.createReadStream(file).pipe(res);
  });
}
function serve(port, host = "127.0.0.1") {
  const server = createStudioServer();
  return new Promise((ok, no) => server.once("error", no).listen(port, host, () => ok(server)));
}
export {
  DIST,
  createStudioServer,
  serve
};
