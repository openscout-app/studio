#!/usr/bin/env node
// npx @openscout/canvas [--port 4801] [--no-open]
//
// Starts Scout Canvas and opens it. If Scout Canvas is already running on the port, it opens that
// one instead; if something else holds the port, it takes the next free one.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../server/serve.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: scout-canvas [--port <n>] [--no-open]\n\nShows what your Claude Code sessions made, on Scout's canvas, at http://localhost:4801.");
  process.exit(0);
}
const at = args.indexOf("--port");
const asked = Number(at >= 0 ? args[at + 1] : process.env.PORT) || 0;
const first = asked || 4801;
const open = !args.includes("--no-open");
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.html");
if (!fs.existsSync(dist)) { console.error("scout-canvas: the app isn't built. Run `npm run build` first."); process.exit(1); }

const show = (url) => { if (open) execFile("open", [url], () => {}); };

/** Is Scout Canvas already answering on this port? */
async function ours(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/notes`, { signal: AbortSignal.timeout(1500) });
    return res.ok && Array.isArray((await res.json()).notes);
  } catch { return false; }
}

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
