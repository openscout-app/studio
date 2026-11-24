#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import { callerSession, shareScreen } from "../server/shared-screens.mjs";
import { setupStudio } from "../server/setup.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BIN = fileURLToPath(import.meta.url);
const HELP = `Usage:
  scout-studio [--port <n>] [--no-open] [--no-setup]
      Open the local canvas, connect installed hosts and start Scout if needed.
  scout-studio setup [--print] [--no-scout]
      Check connections again. --print previews host registration commands.
  scout-studio mcp [--host <harness>]
      Serve Studio tools over stdio.
  scout-studio share <image> --host <harness> [--session <id>] [--caption <text>]
      Share a local screenshot. Reuse the returned handle in this conversation.
  scout-studio feedback --session <id> [--note <id> --reply <text>]
      Read pinned notes or answer a note on this canvas.
  scout-studio link [--screen <id|latest>] (--at <x,y> | --box <x,y,w,h>) [--fraction] --say <text> [--session <id>] [--open]
      Print a link to a spot on the screen.`;
if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
const fail = (m) => { console.error(`scout-studio: ${m}`); process.exit(1); };

if (args[0] === "mcp") {
  const { serveMcp } = await import("../server/mcp.mjs");
  serveMcp();
} else if (args[0] === "setup" || args[0] === "init") {
  await setupStudio(BIN, { print: args.includes("--print"), scout: !args.includes("--no-scout") });
} else if (args[0] === "share" || args[0] === "feedback") {
  try {
    const host = opt("--host") || (process.env.CODEX_THREAD_ID ? "codex" : process.env.CLAUDE_CODE_SESSION_ID ? "claude" : "");
    const session = callerSession(opt("--session"), process.env, host);
    if (args[0] === "share") {
      const receipt = shareScreen({ file: args[1], session, host, caption: opt("--caption") });
      console.log(JSON.stringify(receipt));
    } else {
      if (!session) fail("Pass the session handle returned by share.");
      const { ensure, call } = await import("../server/local.mjs");
      console.log(JSON.stringify(await call(await ensure(), "POST", "/api/feedback", { session, note: opt("--note"), reply: opt("--reply") })));
    }
  } catch (e) { fail(e.message); }
} else if (args[0] === "link") {
  const { ensure, call } = await import("../server/local.mjs");
  let session;
  try { session = callerSession(opt("--session"), process.env, opt("--host")); } catch (e) { fail(e.message); }
  if (!session) fail("Pass this conversation’s session ID or the handle returned by share.");
  const nums = (s, n) => {
    const v = String(s || "").split(",").map((x) => Number(x.trim()));
    if (v.length !== n || v.some((x) => !Number.isFinite(x))) fail(`expected ${n} numbers separated by commas, not "${s}"`);
    return v;
  };
  const at = opt("--box") ? nums(opt("--box"), 4) : opt("--at") ? [...nums(opt("--at"), 2), 0, 0] : fail("say where: --at x,y or --box x,y,w,h");
  const say = opt("--say") || fail('say what about it: --say "…"');
  try {
    const base = await ensure();
    const { url } = await call(base, "POST", "/api/pointers", {
      session, screen: opt("--screen") || "latest", say,
      at: { x: at[0], y: at[1], w: at[2], h: at[3], unit: args.includes("--fraction") ? "fraction" : "px" },
    });
    console.log(url);
    if (args.includes("--open")) execFile("open", [url], () => {});
  } catch (e) { fail(e.message); }
} else {
  const { serve } = await import("../server/serve.mjs");
  const { ours, FIRST_PORT } = await import("../server/local.mjs");
  const asked = Number(opt("--port") ?? process.env.PORT) || 0;
  const first = asked || FIRST_PORT;
  const open = !args.includes("--no-open");
  const dist = path.join(path.dirname(BIN), "..", "dist", "index.html");
  if (!fs.existsSync(dist)) fail("the app isn't built. Run `npm run build` first.");
  const show = (url) => { if (open) execFile("open", [url], () => {}); };
  for (let port = first; port < first + 10; port++) {
    try {
      await serve(port);
      const url = `http://localhost:${port}`;
      console.log(`Scout Studio is at ${url}`);
      show(url);
      break;
    } catch (e) {
      if (e.code !== "EADDRINUSE") fail(e.message);
      if (await ours(port)) {
        const url = `http://localhost:${port}`;
        console.log(`Scout Studio is already running at ${url}`);
        show(url);
        break;
      }
      if (asked) fail(`port ${port} is taken. Try another --port.`);
      if (port === first + 9) fail(`ports ${first} to ${port} are all taken. Use --port <n>.`);
    }
  }
  if (!args.includes("--no-setup")) await setupStudio(BIN);
}
