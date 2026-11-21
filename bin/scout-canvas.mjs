#!/usr/bin/env node
// npx @openscout/canvas [--port 4801] [--no-open]
// npx @openscout/canvas link [--screen latest|<file>|<url>|<hash>] [--at x,y] [--say "…"] [--session <id>]
//
// Starts Scout Canvas and opens it. If Scout Canvas is already running on the port, it opens that
// one instead; if something else holds the port, it takes the next free one.
//
// `link` prints a link to a session, one of its screens, and a point on it, for an agent to hand
// to a person. Run from a Claude Code session, it links that session.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../server/serve.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const HELP = `Usage:
  scout-canvas [--port <n>] [--no-open]
      Show what your Claude Code sessions made, on Scout's canvas, at http://localhost:4801.

  scout-canvas link [--screen <which>] [--at <x,y>] [--say <text>] [--session <id>] [--open] [--json]
      Print a link to a session's screen, for a person to open.
      --screen   latest (default), an image file the session read, a page address, or a screen hash
      --at       a point on the screen: pixels (640,380) or fractions (0.5,0.42)
      --say      what to tell the person about that point; shown beside it
      --session  which session; defaults to the Claude Code session running this command
      --open     open the link as well as printing it
      --json     print the link with what it points at`;
if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
const asked = Number(opt("--port") ?? process.env.PORT) || 0;
const first = asked || 4801;
const open = !args.includes("--no-open");

const show = (url) => { if (open) execFile("open", [url], () => {}); };

/** Is Scout Canvas already answering on this port? */
async function ours(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/notes`, { signal: AbortSignal.timeout(1500) });
    return res.ok && Array.isArray((await res.json()).notes);
  } catch { return false; }
}

if (args[0] === "link") {
  const { findSession, screensFor, pickScreen, pointOf, linkTo } = await import("../server/link.mjs");
  const fail = (m) => { console.error(`scout-canvas link: ${m}`); process.exit(1); };
  const session = findSession({ session: opt("--session") });
  if (!session) fail("no Claude Code session here. Run it from a session, or pass --session <id>.");
  if (!session.file) fail(`no transcript for session ${session.id}.`);
  const which = opt("--screen");
  const screens = await screensFor(session);
  const screen = pickScreen(screens, which);
  if (which && which !== "latest" && !screen) fail(`no screen in this session matches "${which}". It has ${screens.length}.`);
  let point = null;
  try { point = pointOf(opt("--at"), screen); } catch (e) { fail(e.message); }
  let port = 0;
  for (let p = first; p < first + 10 && !port; p++) if (await ours(p)) port = p;
  const url = linkTo(`http://localhost:${port || first}`, { session: session.id, screen, point, say: opt("--say") });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ url, running: !!port, session: session.id, screen: screen && { hash: screen.hash, w: screen.w, h: screen.h, at: new Date(screen.at).toISOString(), url: screen.url, file: screen.file }, point }, null, 2));
  } else console.log(url);
  if (!screen) console.error("scout-canvas link: this session has no screens yet; the link opens the session.");
  if (!port) console.error("scout-canvas link: Scout Canvas isn't running. Start it with `npx @openscout/canvas`.");
  if (args.includes("--open") && port) execFile("open", [url], () => {});
  process.exit(0);
}

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.html");
if (!fs.existsSync(dist)) { console.error("scout-canvas: the app isn't built. Run `npm run build` first."); process.exit(1); }

for (let port = first; port < first + 10; port++) {
  try {
    await serve(port);
    const url = `http://localhost:${port}`;
    console.log(`Scout Canvas is at ${url}`);
    show(url);
    break;
  } catch (e) {
    if (e.code !== "EADDRINUSE") { console.error(`scout-canvas: ${e.message}`); process.exit(1); }
    if (await ours(port)) {
      const url = `http://localhost:${port}`;
      console.log(`Scout Canvas is already running at ${url}`);
      show(url);
      process.exit(0);
    }
    if (asked) { console.error(`scout-canvas: port ${port} is taken. Try another --port.`); process.exit(1); }
    if (port === first + 9) { console.error(`scout-canvas: ports ${first} to ${port} are all taken. Use --port <n>.`); process.exit(1); }
  }
}
