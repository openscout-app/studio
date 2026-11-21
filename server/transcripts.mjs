// Reads Claude Code transcripts into what the canvas shows: each session's screens, what it said
// about them, which earlier screen each one follows, and the answers to notes Scout carried in.
//
// A transcript is read once and then only from where the last read stopped, so a long session
// that is still running costs one small read per refresh.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { IMG } from "./paths.mjs";
import { imageSize } from "./image-size.mjs";

/** smaller than this is an icon or a crop, not a screen */
const MIN_W = 320, MIN_H = 200;
/** a note's marker, as it reads in the message Scout delivers */
export const MARK = /\[scout-canvas:(n_[a-z0-9]+)\]/g;

const states = new Map(); // transcript path -> parse state

function fresh(file, owner) {
  return {
    file, owner, offset: 0, carry: "",
    cwd: "", firstAt: 0, lastAt: 0, lastStop: "", openTools: 0,
    prompt: "", turn: 0, said: "", uses: new Map(),
    screens: [], turnScreens: [], lastOf: new Map(),
    mark: null, arrived: {}, answers: {},
  };
}

/** The screen's identity for before/after: the same page, the same window, or the same file. */
export function subjectOf(tool, input = {}, text = "") {
  const url = text.match(/"url"\s*:\s*"([^"]+)"/)?.[1] || input.url;
  if (url) {
    try { const u = new URL(url); return `page:${u.host}${u.pathname.replace(/\/$/, "")}`; } catch {}
  }
  if (input.wid != null) return `window:${input.wid}`;
  const file = input.file_path || input.outputPath || input.path;
  if (typeof file === "string" && /\.(png|jpe?g|webp|gif)$/i.test(file)) {
    // the same name in the same folder, less a trailing count or before/after: shot-2.png follows shot-1.png
    const stem = path.basename(file).replace(/\.[a-z]+$/i, "")
      .replace(/([-_. ]?(before|after|old|new|v?\d+))+$/i, "");
    return `file:${path.dirname(file)}/${stem || path.basename(file)}`;
  }
  return null; // nothing says what it is a screen of, so it follows nothing
}

/** Two screens can be laid one over the other only if they have about the same shape. */
export const sameShape = (a, b) => Math.abs(a.w / a.h - b.w / b.h) / (b.w / b.h) < 0.12;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

/** A prompt as a person would read it: no wrapper tags, no command or system-reminder blocks. */
export function plain(text) {
  return text
    .replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/?[a-z_][\w-]*(\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function saveImage(b64, media) {
  const hash = crypto.createHash("sha1").update(b64).digest("hex").slice(0, 16);
  const ext = media === "image/jpeg" ? "jpg" : media === "image/webp" ? "webp" : media === "image/gif" ? "gif" : "png";
  const file = path.join(IMG, `${hash}.${ext}`);
  let buf = null;
  if (!fs.existsSync(file)) {
    buf = Buffer.from(b64, "base64");
    fs.mkdirSync(IMG, { recursive: true });
    fs.writeFileSync(file, buf);
  }
  const size = imageSize(buf || fs.readFileSync(file));
  return size ? { hash, ext, ...size } : null;
}

/** End a turn: keep its last screen of each subject, and give each the screen it follows. */
function closeTurn(s) {
  const kept = [];
  for (const sc of s.turnScreens) {
    const i = sc.subject ? kept.findIndex((k) => k.subject === sc.subject) : -1;
    if (i >= 0) kept[i] = sc; else kept.push(sc);
  }
  for (const sc of kept) {
    sc.caption = s.said.trim().slice(0, 600);
    const prev = sc.subject && s.lastOf.get(sc.subject);
    if (prev && prev.hash === sc.hash) continue; // the same screen again: it's on the canvas already
    if (prev && sameShape(sc, prev)) sc.before = { hash: prev.hash, ext: prev.ext, at: prev.at };
    if (sc.subject) s.lastOf.set(sc.subject, sc);
    s.screens.push(sc);
  }
  s.turnScreens = [];
  s.said = "";
}

function onEntry(s, e) {
  const at = Date.parse(e.timestamp || "") || 0;
  if (at) { s.firstAt ||= at; s.lastAt = Math.max(s.lastAt, at); }
  if (e.cwd && !s.cwd) s.cwd = e.cwd;
  const m = e.message;
  if (!m) return;
  const content = m.content;
  if (e.type === "user") {
    const results = Array.isArray(content) ? content.filter((b) => b?.type === "tool_result") : [];
    if (!results.length) {
      // a prompt: a person, or a note Scout delivered
      const text = textOf(content);
      if (!text || e.isMeta) return;
      closeTurn(s);
      s.turn++;
      const marks = [...text.matchAll(MARK)].map((x) => x[1]);
      if (marks.length) {
        for (const id of marks) { s.arrived[id] = at; s.answers[id] = []; }
        s.mark = marks;
      } else {
        s.mark = null;
        if (!s.prompt) s.prompt = plain(text).slice(0, 200);
      }
      return;
    }
    for (const r of results) {
      s.openTools = Math.max(0, s.openTools - 1);
      const use = s.uses.get(r.tool_use_id) || { name: "", input: {} };
      s.uses.delete(r.tool_use_id);
      const parts = Array.isArray(r.content) ? r.content : [];
      const text = textOf(parts);
      for (const p of parts) {
        if (p?.type !== "image" || p.source?.type !== "base64") continue;
        const img = saveImage(p.source.data, p.source.media_type);
        if (!img || img.w < MIN_W || img.h < MIN_H) continue;
        const url = text.match(/"url"\s*:\s*"([^"]+)"/)?.[1] || use.input.url || null;
        s.turnScreens.push({
          hash: img.hash, ext: img.ext, w: img.w, h: img.h, at, turn: s.turn,
          tool: use.name, url, file: use.input.file_path || use.input.outputPath || null,
          subject: subjectOf(use.name, use.input, text),
        });
      }
    }
    return;
  }
  if (e.type === "assistant") {
    s.lastStop = m.stop_reason || s.lastStop;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") { s.uses.set(b.id, { name: b.name, input: b.input || {} }); s.openTools++; }
      if (b?.type === "text" && b.text?.trim()) {
        s.said = b.text;
        if (s.mark) for (const id of s.mark) s.answers[id].push({ at, text: b.text.trim().slice(0, 4000) });
      }
    }
  }
}

/** Read whatever the transcript gained since last time. Returns the state, or null if it's gone. */
export function readTranscript(file, owner) {
  let st;
  try { st = fs.statSync(file); } catch { states.delete(file); return null; }
  let s = states.get(file);
  if (!s || st.size < s.offset) { s = fresh(file, owner); states.set(file, s); }
  if (st.size > s.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const CHUNK = 8 << 20;
      while (s.offset < st.size) {
        const len = Math.min(CHUNK, st.size - s.offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, s.offset);
        s.offset += len;
        const lines = (s.carry + buf.toString("utf8")).split("\n");
        s.carry = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          onEntry(s, e);
        }
      }
    } finally { fs.closeSync(fd); }
  }
  s.mtime = st.mtimeMs;
  return s;
}

/** A turn still open has screens that aren't settled yet; show them anyway, as they stand. */
export function screensOf(s) {
  const open = s.turnScreens.map((sc) => ({ ...sc, caption: s.said.trim().slice(0, 600), open: true }));
  return [...s.screens, ...open];
}
