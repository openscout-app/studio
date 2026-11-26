// Safe discovery of file-backed screens, agent-written HTML/Markdown documents, and workspace
// visual studies. Every file read from disk is verified with realpath containment against the
// session's project root (or Studio's own local capture roots), so transcripts cannot point Studio
// at arbitrary host files.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME, IMG } from "./paths.mjs";
import { imageSize } from "./image-size.mjs";
import { frontmatter } from "./show-view.mjs";

const MIN_W = 320, MIN_H = 200;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const HTML_EXT = /\.html?$/i;
const MD_EXT = /\.(md|markdown|mdx)$/i;
const BOILERPLATE_MD = /^(readme|agents|claude|gemini|skill|changelog|contributing|license|code_of_conduct|security|todo)\.md$/i;
const DOC_NAME_HINT = /(?:plan|review|design|spec|brief|audit|roadmap|proposal|one[-_]?pager|dossier|study|notes|architecture|walkthrough|report)/i;
const DOC_DIR_HINT = /(?:^|\/)(?:plans|reviews|research|docs|artifacts|design|studies|notes|specs)(?:\/|$)/i;
const BUILD_DIR_RE = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|out|coverage|vendor|\.turbo|\.vercel|\.cache)(?:\/|$)/;
const SHELL_CAPTURE_RE = /\b(?:scout\s+browser\s+screenshot|agent-browser\s+screenshot|playwright\s+screenshot|screencapture|action\s+(?:.*\s+)?capture)\b/i;
const SCREENSHOT_TOOL_RE = /(?:screenshot|screencapture|capture_screen|save_screen)/i;

const FORBIDDEN_EXACT = new Set([
  "/",
  "/Users",
  "/home",
  "/etc",
  "/private/etc",
  "/var",
  "/private/var",
  "/System",
  "/Library",
]);

function safeRealpath(p) {
  if (!p || typeof p !== "string") return null;
  try { return fs.realpathSync(p); } catch { return null; }
}

/** True only when `dir` is a specific project/worktree directory, never $HOME or a broad system root. */
export function isSafeProjectRoot(dir) {
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

/** Allowed realpath roots for files referenced by a session. */
export function allowedRootsFor(cwd, extraRoots = []) {
  const roots = new Set();
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

/** Resolves `candidate` (relative to `cwd` if needed) only if its realpath sits inside `allowedRoots`. */
export function resolveContainedFile(candidate, cwd, allowedRoots) {
  if (!candidate || typeof candidate !== "string") return null;
  let cleaned = candidate.trim().replace(/^['"`]|['"`]$/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("file://")) {
    try { cleaned = decodeURIComponent(new URL(cleaned).pathname); } catch { return null; }
  } else if (cleaned.startsWith("~/")) {
    cleaned = path.join(os.homedir(), cleaned.slice(2));
  }
  const resolved = path.isAbsolute(cleaned) ? cleaned : cwd ? path.resolve(cwd, cleaned) : null;
  if (!resolved) return null;
  const real = safeRealpath(resolved);
  if (!real || BUILD_DIR_RE.test(real)) return null;
  for (const root of allowedRoots) {
    if (real === root || real.startsWith(root + path.sep)) return real;
  }
  return null;
}

const ingestedImages = new Map(); // `${realPath}:${mtimeMs}:${size}` -> screen record | null

/** Copy/index a local screenshot file into Studio's image store if >= 320x200 and contained. */
export function ingestImageFile(filePath, cwd, allowedRoots, meta = {}) {
  const real = resolveContainedFile(filePath, cwd, allowedRoots);
  if (!real || !IMG_EXT.test(real)) return null;
  let st;
  try { st = fs.statSync(real); } catch { return null; }
  if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null;
  const cacheKey = `${real}:${Math.floor(st.mtimeMs)}:${st.size}`;
  if (ingestedImages.has(cacheKey)) {
    const hit = ingestedImages.get(cacheKey);
    return hit ? { ...hit, ...meta, at: meta.at || hit.at } : null;
  }
  let bytes;
  try { bytes = fs.readFileSync(real); } catch { return null; }
  const size = imageSize(bytes);
  if (!size || size.w < MIN_W || size.h < MIN_H) {
    ingestedImages.set(cacheKey, null);
    return null;
  }
  const ext = bytes[0] === 0xff ? "jpg" : bytes[0] === 0x89 ? "png" : bytes[0] === 0x47 ? "gif" : "webp";
  const hash = crypto.createHash("sha1").update(bytes.toString("base64")).digest("hex").slice(0, 16);
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
    ext,
    w: size.w,
    h: size.h,
    at: Math.floor(st.mtimeMs),
    file: real,
    url: null,
  };
  ingestedImages.set(cacheKey, base);
  return { ...base, ...meta, at: meta.at || base.at };
}

// ---- Local Show registry (HTML studies, Markdown plans/reviews, brain artifacts)

const localShows = new Map(); // id -> { show, realPath, allowedRoot }
const captionCache = new Map(); // `${real}:${mtime}:${size}` -> string

function localShowUuid(realPath) {
  const h = crypto.createHash("sha1").update(`studio-local-show:${realPath}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function sniffDocCaption(realPath, view, mtimeMs, size) {
  const key = `${realPath}:${Math.floor(mtimeMs)}:${size}`;
  if (captionCache.has(key)) return captionCache.get(key);
  let caption = "";
  try {
    const fd = fs.openSync(realPath, "r");
    const buf = Buffer.alloc(Math.min(4096, size));
    try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const head = buf.toString("utf8");
    if (view === "html") {
      const m = /<title[^>]*>([^<]+)<\/title>/i.exec(head);
      if (m?.[1]?.trim()) caption = m[1].trim().slice(0, 72);
    } else if (view === "markdown") {
      const { meta, body } = frontmatter(head);
      const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
      caption = (meta.title || h1 || "").replace(/[`*_#]/g, "").trim().slice(0, 72);
    }
  } catch {}
  captionCache.set(key, caption);
  return caption;
}

function isVisualHtmlCandidate(realPath, projectRoot) {
  if (!HTML_EXT.test(realPath) || BUILD_DIR_RE.test(realPath)) return false;
  const base = path.basename(realPath).toLowerCase();
  if (base === "index.html" && projectRoot && path.dirname(realPath) === projectRoot) {
    // Skip Vite/Next app entry shells at repository root that only mount a JS bundle.
    try {
      const head = fs.readFileSync(realPath, "utf8").slice(0, 2048);
      if (/src=["']\/?src\/main\.[jt]sx?["']/i.test(head)) return false;
    } catch { return false; }
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

/** Register a local HTML or Markdown artifact as a Studio Show item if contained and eligible. */
export function registerLocalShow(filePath, cwd, allowedRoots, opts = {}) {
  const real = resolveContainedFile(filePath, cwd, allowedRoots);
  if (!real) return null;
  const allowedRoot = allowedRoots.find((r) => real === r || real.startsWith(r + path.sep));
  if (!allowedRoot) return null;
  let st;
  try { st = fs.statSync(real); } catch { return null; }
  if (!st.isFile() || st.size <= 0 || st.size > MAX_DOC_BYTES) return null;

  const projectRoot = opts.projectRoot || allowedRoot;
  let view = null;
  let mediaType = "application/octet-stream";
  if (isVisualHtmlCandidate(real, projectRoot)) {
    view = "html";
    mediaType = "text/html";
  } else if (isEditorialMarkdownCandidate(real, Boolean(opts.fromBrain))) {
    view = "markdown";
    mediaType = "text/markdown";
  } else {
    return null;
  }

  const id = localShowUuid(real);
  const caption = opts.caption || sniffDocCaption(real, view, st.mtimeMs, st.size);
  const show = {
    id,
    itemId: id,
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
    caption,
    at: opts.at || Math.floor(st.mtimeMs),
    createdAt: opts.at || Math.floor(st.mtimeMs),
    versions: 1,
    local: true,
  };
  localShows.set(id, { show, realPath: real, allowedRoot });
  return show;
}

export function localShowById(id) {
  return localShows.get(id)?.show || null;
}

export function localShowBytes(id) {
  const entry = localShows.get(id);
  if (!entry) return null;
  const real = safeRealpath(entry.realPath);
  if (!real || !(real === entry.allowedRoot || real.startsWith(entry.allowedRoot + path.sep))) return null;
  try { return fs.readFileSync(real); } catch { return null; }
}

// ---- Tool-call extraction (screenshots written by CLI/tools + HTML/Markdown written by tools)

function extractImageTokens(text) {
  if (!text || typeof text !== "string") return [];
  const out = [];
  const re = /(?:['"`]([^'"`\r\n]+\.(?:png|jpe?g|webp|gif))['"`]|(\S+\.(?:png|jpe?g|webp|gif)))/gi;
  for (const m of text.matchAll(re)) {
    const p = (m[1] || m[2] || "").replace(/[),.;:]+$/, "");
    if (p && !/^https?:\/\//i.test(p)) out.push(p);
  }
  return out;
}

/** Extract candidate screenshot paths and written document paths from a tool invocation + result. */
export function extractToolArtifacts(toolName, input = {}, outputText = "", rawPatch = "") {
  const name = String(toolName || "");
  const screenshots = [];
  const docs = [];

  // 1. Explicit screenshot tools
  if (SCREENSHOT_TOOL_RE.test(name)) {
    for (const k of ["path", "outputPath", "file_path", "file", "filename", "Path", "TargetFile"]) {
      if (typeof input[k] === "string") screenshots.push(input[k]);
    }
    screenshots.push(...extractImageTokens(outputText));
  }

  // 2. Shell commands running a screenshot/capture CLI
  const cmd = String(input.command || input.CommandLine || input.cmd || "");
  if (cmd && SHELL_CAPTURE_RE.test(cmd)) {
    screenshots.push(...extractImageTokens(cmd));
    screenshots.push(...extractImageTokens(outputText));
  }

  // 3. File-writing tools producing HTML studies or Markdown plans/reviews
  if (/^(?:Write|Edit|MultiEdit|write_file|edit_file|create_file|replace_file_content)$/i.test(name)) {
    const target = input.file_path || input.path || input.Path || input.TargetFile;
    if (typeof target === "string") docs.push(target);
  }
  const patchBody = rawPatch || (name === "apply_patch" ? String(input.patch || input.input || "") : "");
  if (patchBody) {
    for (const m of patchBody.matchAll(/\*\*\* (?:Add|Update) File:\s*([^\r\n]+)/g)) {
      if (m[1]?.trim()) docs.push(m[1].trim());
    }
  }

  return { screenshots: [...new Set(screenshots)], docs: [...new Set(docs)] };
}

// ---- Workspace cold-start discovery (HTML studies, plans, reviews, scratch screens in active repos)

const WORKSPACE_DIRS = [
  "design/studio",
  "design",
  "plans",
  "reviews",
  "artifacts",
  "scratch",
  "docs/studies",
  ".openscout/artifacts",
];

const wsCache = new Map(); // root -> { at, sinceBucket, shows, screens }

function walkShallow(dir, maxDepth, out = [], depth = 0) {
  if (depth > maxDepth) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
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

/** Discover recent visual studies, plans, and scratch screenshots in active repository roots. */
export function discoverWorkspaceArtifacts(roots, since) {
  const bucket = Math.floor(since / 60_000);
  const out = [];
  for (const root of roots) {
    if (!root || !isSafeProjectRoot(root)) continue;
    const realRoot = safeRealpath(root);
    if (!realRoot) continue;
    const hit = wsCache.get(realRoot);
    if (hit && hit.sinceBucket === bucket && Date.now() - hit.at < 15_000) {
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
        const st = fs.statSync(file);
        if (st.mtimeMs >= since && st.size > 0) recent.push({ file, mtimeMs: st.mtimeMs });
      } catch {}
    }
    recent.sort((a, b) => b.mtimeMs - a.mtimeMs);

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
          });
          if (sc) screens.push(sc);
        }
      } else if (shows.length < 16) {
        const sh = registerLocalShow(item.file, realRoot, allowed, {
          projectRoot: realRoot,
          worktree: realRoot,
          harness: "scout",
          at: Math.floor(item.mtimeMs),
        });
        if (sh) shows.push(sh);
      }
    }
    wsCache.set(realRoot, { at: Date.now(), sinceBucket: bucket, shows, screens });
    if (shows.length || screens.length) out.push({ root: realRoot, shows, screens });
  }
  return out;
}
