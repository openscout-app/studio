// Screens explicitly shared by a local tool. Each receipt is independent, so concurrent
// shares cannot overwrite each other. Only the CLI/MCP reads the chosen image file.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME, IMG } from "./paths.mjs";
import { imageSize } from "./image-size.mjs";

const root = path.join(HOME, "shared-screens");
const valid = id => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,160}$/.test(id);
export const portable = id => typeof id === "string" && /^studio-[0-9a-f]{32}$/.test(id);

export function callerSession(requested, env = process.env, host = "") {
  const native = host === "claude" ? env.CLAUDE_CODE_SESSION_ID :
    host === "codex" ? env.CODEX_THREAD_ID :
    host ? env.OPENSCOUT_SESSION_ID : env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.OPENSCOUT_SESSION_ID;
  if (requested && native && requested !== native) throw Error("That session does not match this conversation.");
  const id = native || requested;
  if (id && !valid(id)) throw Error("Invalid Studio session handle.");
  return id || null;
}

export function sharedScreens(session) {
  if (!valid(session)) return [];
  const dir = path.join(root, session);
  let files; try { files = fs.readdirSync(dir); } catch { return []; }
  const screens = [];
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    try { screens.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))); } catch {}
  }
  return screens.sort((a, b) => b.at - a.at);
}

export function sharedInWindow(since) {
  let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return dirs.filter(d => d.isDirectory()).flatMap(d => {
    const screens = sharedScreens(d.name).filter(s => s.at >= since);
    return screens.length ? [{ id: d.name, screens }] : [];
  });
}

function publish(file, data) {
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export function shareScreen({ file, session, host, caption = "", cwd = process.cwd() }) {
  if (typeof file !== "string" || !file) throw Error("Choose a screenshot file to share.");
  if (!host || !/^[a-z][a-z0-9-]{0,39}$/.test(host)) throw Error("Give the harness name with --host.");
  if (session && !valid(session)) throw Error("Invalid Studio session handle.");
  const id = session || "studio-" + crypto.randomUUID().replaceAll("-", "");
  const source = path.resolve(cwd, file);
  const st = fs.statSync(source);
  if (!st.isFile() || st.size > 32 * 1024 * 1024) throw Error("Choose an image file up to 32 MB.");
  const bytes = fs.readFileSync(source);
  const size = imageSize(bytes);
  if (!size?.w || !size.h) throw Error("Choose a PNG, JPEG, GIF or WebP screenshot.");
  const ext = bytes[0] === 0xff ? "jpg" : bytes[0] === 0x89 ? "png" : bytes[0] === 0x47 ? "gif" : "webp";
  const hash = crypto.createHash("sha1").update(bytes.toString("base64")).digest("hex").slice(0,16);
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(IMG, { recursive: true, mode: 0o700 });
  publish(path.join(IMG, hash + "." + ext), bytes);
  const screen = { hash, ext, ...size, at: Date.now(), file: source, tool: host, harness: host,
    cwd, caption: String(caption).slice(0,600), open: false };
  publish(path.join(dir, hash + ".json"), JSON.stringify(screen));
  return { session: id, screen: hash };
}
