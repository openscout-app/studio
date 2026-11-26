// Reads Claude Code transcripts into what the canvas shows: each session's screens, what it said
// about them, which earlier screen each one follows, and the answers to notes Scout carried in.
//
// A transcript is read once and then only from where the last read stopped, so a long session
// that is still running costs one small read per refresh. Reading yields between steps, so the
// server answers while a long transcript is still being read. An image stays in its transcript
// until it is first shown; only where it is (which line of which file) is kept until then.
import { codexEntry } from "./codex.mjs";
import { antigravityEntry, kimiEntry } from "./harnesses.mjs";
import { allowedRootsFor, extractToolArtifacts, ingestImageFile, registerLocalShow } from "./artifacts.mjs";
import fs from "node:fs";
import path from "node:path";
import { describe, said } from "./doing.mjs";
import crypto from "node:crypto";
import { IMG } from "./paths.mjs";
import { imageSize } from "./image-size.mjs";

/** smaller than this is an icon or a crop, not a screen */
const MIN_W = 320, MIN_H = 200;
/** a note's marker, as it reads in the message Scout delivers */
export const MARK = /\[scout-(?:studio|canvas):(n_[a-z0-9]+)\]/g; // canvas: notes sent before the rename

const states = new Map(); // transcript path -> parse state
/** hash -> where its image is: { file, at (byte offset of its line), len, ext } */
const places = new Map();

function fresh(file, owner, meta = {}) {
  return {
    file, owner, harness: meta.harness || "claude", extraRoots: meta.brainDir ? [meta.brainDir] : [],
    offset: 0, carry: Buffer.alloc(0), line: null,
    cwd: "", firstAt: 0, lastAt: 0, lastStop: "", openTools: 0,
    prompt: "", turn: 0, said: "", uses: new Map(),
    screens: [], turnScreens: [], writtenShows: new Map(), lastOf: new Map(),
    mark: null, arrived: {}, answers: {},
    // what it did last, in a few words, and when
    now: null,
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

// Scout delivers an ask or a message wrapped: "New broker ask from <who>. Task: <task> Follow the
// OpenScout collaboration contract: …". A person wants the task, not the wrapping.
const WRAPPED = /^New (?:broker )?(?:ask|message) from \S+\s+(?:Task|Message):\s*/;
export const isWrapped = (text) => WRAPPED.test(text || "");
/** What was asked, without Scout's delivery wrapping. */
export function asked(text) {
  if (!isWrapped(text)) return text;
  return text.replace(WRAPPED, "").replace(/\s*Follow the OpenScout collaboration contract:[\s\S]*$/, "").trim();
}

/** What an agent said, as plain words for a caption: its Markdown marks taken out. */
export function prose(text) {
  return (text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

const hashOf = (b64) => crypto.createHash("sha1").update(b64).digest("hex").slice(0, 16);
const extOf = (media) => media === "image/jpeg" ? "jpg" : media === "image/webp" ? "webp" : media === "image/gif" ? "gif" : "png";

/** An image's hash and size, read from the start of its data; where it is, remembered for later. */
function noteImage(s, b64, media) {
  const hash = hashOf(b64);
  const ext = extOf(media);
  // the header is near the start; a JPEG's can sit behind its metadata, so read more if it must
  const size = imageSize(Buffer.from(b64.slice(0, 1 << 18), "base64")) || imageSize(Buffer.from(b64, "base64"));
  if (!size) return null;
  if (!places.has(hash) && s.line) places.set(hash, { file: s.file, at: s.line.at, len: s.line.len, ext });
  return { hash, ext, ...size };
}

/**
 * Write an image out of its transcript, the first time it's asked for. Returns its path, or null
 * if nothing says where it is.
 */
export function materialize(hash, ext) {
  const out = path.join(IMG, `${hash}.${ext}`);
  if (fs.existsSync(out)) return out;
  const p = places.get(hash);
  if (!p) return null;
  let entry;
  try {
    const fd = fs.openSync(p.file, "r");
    const buf = Buffer.alloc(p.len);
    try { fs.readSync(fd, buf, 0, p.len, p.at); } finally { fs.closeSync(fd); }
    entry = JSON.parse(buf.toString("utf8"));
  } catch { return null; }
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

/** End a turn: keep its last screen of each subject, and give each the screen it follows. */
function closeTurn(s) {
  const kept = [];
  for (const sc of s.turnScreens) {
    const i = sc.subject ? kept.findIndex((k) => k.subject === sc.subject) : -1;
    if (i >= 0) kept[i] = sc; else kept.push(sc);
  }
  for (const sc of kept) {
    sc.caption = prose(s.said).slice(0, 600);
    sc.provenance ||= "captured";
    const prev = sc.subject && s.lastOf.get(sc.subject);
    if (prev && prev.hash === sc.hash) continue; // the same screen again: it's on the canvas already
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
  if (at) { s.firstAt ||= at; s.lastAt = Math.max(s.lastAt, at); }
  if (e.cwd && !s.cwd) s.cwd = e.cwd;
  if (e.turnEnded) { closeTurn(s); s.lastStop = "end_turn"; }
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
          hash: img.hash, ext: img.ext, w: img.w, h: img.h, at, turn: s.turn,
          tool: use.name, url, file: use.input.file_path || use.input.outputPath || null,
          subject: subjectOf(use.name, use.input, text),
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
              hash: img.hash, ext: img.ext, w: img.w, h: img.h, at: img.at, turn: s.turn,
              tool: use.name, url, file: img.file,
              subject: subjectOf(use.name, { ...use.input, file_path: img.file }, text),
            });
          }
        }
      }
    }
    return;
  }
  if (e.type === "assistant") {
    s.lastStop = m.stop_reason || s.lastStop;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") {
        s.uses.set(b.id, { name: b.name, input: b.input || {}, rawPatch: b.rawPatch || "" });
        s.openTools++;
        s.now = { at, text: describe(b.name, b.input || {}) };
        if (s.cwd || s.extraRoots.length) {
          const extracted = extractToolArtifacts(b.name, b.input || {}, "", b.rawPatch || "");
          if (extracted.docs.length || extracted.screenshots.length) {
            const allowed = allowedRootsFor(s.cwd, s.extraRoots);
            for (const docPath of extracted.docs) {
              const sh = registerLocalShow(docPath, s.cwd, allowed, {
                sessionId: s.owner,
                harness: s.harness || "claude",
                worktree: s.cwd,
                at: at || undefined,
              });
              if (sh) s.writtenShows.set(sh.id, sh);
            }
            for (const shotPath of extracted.screenshots) {
              const img = ingestImageFile(shotPath, s.cwd, allowed, { at: at || undefined });
              if (img) {
                s.turnScreens.push({
                  hash: img.hash, ext: img.ext, w: img.w, h: img.h, at: img.at, turn: s.turn,
                  tool: b.name, url: b.input?.url || null, file: img.file,
                  subject: subjectOf(b.name, { ...(b.input || {}), file_path: img.file }, ""),
                });
              }
            }
          }
        }
      }
      if (b?.type === "text" && b.text?.trim()) {
        s.said = b.text;
        if (said(b.text)) s.now = { at, text: said(b.text) };
        if (s.mark) for (const id of s.mark) s.answers[id].push({ at, text: b.text.trim().slice(0, 4000) });
      }
    }
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const reading = new Map(); // transcript path -> the read in progress

/**
 * Read whatever the transcript gained since last time, a step at a time. Resolves to the state, or
 * null if the file is gone. Two reads of one file share the one in progress.
 */
export function readTranscript(file, owner, meta) {
  if (!reading.has(file)) reading.set(file, read(file, owner, meta).finally(() => reading.delete(file)));
  return reading.get(file);
}

async function read(file, owner, meta = {}) {
  let st;
  try { st = fs.statSync(file); } catch { states.delete(file); return null; }
  let s = states.get(file);
  if (!s || st.size < s.offset) { s = fresh(file, owner, meta); states.set(file, s); }
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
        const base = s.offset - s.carry.length; // where data[0] sits in the file
        s.offset += len;
        let pos = 0;
        for (let nl = data.indexOf(10, pos); nl >= 0; pos = nl + 1, nl = data.indexOf(10, pos)) {
          if (nl === pos) continue;
          let e; try { e = JSON.parse(data.toString("utf8", pos, nl)); } catch { continue; }
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
    } finally { fs.closeSync(fd); }
  }
  s.mtime = st.mtimeMs;
  return s;
}

/** The parse state of a transcript read so far, without reading it. */
export const stateOf = (file) => states.get(file) || null;

/** A turn still open has screens that aren't settled yet; show them anyway, as they stand. */
export function screensOf(s) {
  const open = s.turnScreens.map((sc) => {
    const prev = sc.subject && s.lastOf.get(sc.subject);
    return {
      ...sc,
      provenance: sc.provenance || "captured",
      revision: prev && prev.hash !== sc.hash ? (prev.revision || 1) + 1 : (prev?.revision || 1),
      ...(prev && prev.hash !== sc.hash ? { supersedes: prev.hash } : {}),
      caption: prose(s.said).slice(0, 600),
      open: true,
    };
  });
  return [...s.screens, ...open];
}
