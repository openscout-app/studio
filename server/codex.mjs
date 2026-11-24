// Codex records tool output in dated rollout files. Use the native thread id in the filename.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_SESSIONS = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const uuid = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
const known = new Map();
export function codexFiles(since = 0, thread = null) {
  if (thread && !uuid.test("-" + thread + ".jsonl")) return [];
  const cached = thread && known.get(thread);
  if (cached && fs.existsSync(cached.file)) return [cached];
  const out = [];
  for (const y of entries(CODEX_SESSIONS)) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    for (const m of entries(path.join(CODEX_SESSIONS, y.name))) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      for (const d of entries(path.join(CODEX_SESSIONS, y.name, m.name))) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        const dir = path.join(CODEX_SESSIONS, y.name, m.name, d.name);
        for (const ent of entries(dir)) {
          const id = ent.name.match(uuid)?.[1];
          if (!id || !ent.isFile() || (thread && id !== thread)) continue;
          const file = path.join(dir, ent.name);
          let st; try { st = fs.statSync(file); } catch { continue; }
          const record = { file, session: id, harness: "codex", mtime: st.mtimeMs, size: st.size };
          known.set(id, record);
          if (st.mtimeMs >= since) out.push(record);
          if (thread) return out;
        }
      }
    }
  }
  return out;
}

// Normalize only user/assistant messages and tool output. Never read paths found in a transcript.
export function codexEntry(entry) {
  const p = entry.payload || {}, timestamp = entry.timestamp;
  if (entry.type === "session_meta" || entry.type === "turn_context") return { timestamp, cwd: p.cwd };
  if (entry.type === "event_msg" && p.type === "task_complete") return { timestamp, turnEnded: true };
  if (entry.type !== "response_item") return null;
  if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
    const content = (Array.isArray(p.content) ? p.content : []).filter(b => ["input_text", "output_text"].includes(b.type)).map(b => ({ type: "text", text: b.text }));
    return { timestamp, type: p.role, message: { content } };
  }
  if (p.type === "function_call" || p.type === "custom_tool_call") {
    let input = {}; try { input = JSON.parse(p.arguments || "{}") || {}; } catch {}
    return { timestamp, type: "assistant", message: { content: [{ type: "tool_use", id: p.call_id, name: p.name, input }] } };
  }
  if (p.type !== "function_call_output" && p.type !== "custom_tool_call_output") return null;
  const content = [];
  for (const b of Array.isArray(p.output) ? p.output : []) {
    if (b.type === "input_text" || b.type === "text") content.push({ type: "text", text: b.text });
    const uri = b.image_url?.url || b.image_url;
    const match = typeof uri === "string" && uri.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,/);
    if (match) content.push({ type: "image", source: { type: "base64", media_type: match[1], data: uri.slice(match[0].length) } });
  }
  return { timestamp, type: "user", message: { content: [{ type: "tool_result", tool_use_id: p.call_id, content }] } };
}
