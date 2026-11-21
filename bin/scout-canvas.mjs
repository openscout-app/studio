#!/usr/bin/env node
// npx @openscout/canvas [--port 4801] [--no-open]     start Scout Canvas and open it
// npx @openscout/canvas setup                          give Claude Code the Scout Canvas tools
// npx @openscout/canvas mcp                            the tools themselves (Claude Code runs this)
// npx @openscout/canvas link --at x,y --say "…"        point the person at a spot, from a shell
//
// Starting: if Scout Canvas already runs on the port, it opens that one; if something else holds
// the port, it takes the next free one.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BIN = fileURLToPath(import.meta.url);
const HELP = `Usage:
  scout-canvas [--port <n>] [--no-open]
      Show what your Claude Code sessions made, on Scout's canvas, at http://localhost:4801.

  scout-canvas setup [--print]
      Give every Claude Code session the Scout Canvas tools (screens, point, pointers), so an
      agent can show you a precise spot on a screen it took. --print shows the command instead.

  scout-canvas mcp
      The tools, as an MCP server over stdio. Claude Code runs this; you don't need to.

  scout-canvas link [--screen <id|latest>] (--at <x,y> | --box <x,y,w,h>) [--fraction] --say <text> [--session <id>] [--open]
      From a shell in a Claude Code session: point the person at a spot and print the link.
      Coordinates are pixels of the screenshot, or 0 to 1 with --fraction.`;
if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
const fail = (m) => { console.error(`scout-canvas: ${m}`); process.exit(1); };

if (args[0] === "mcp") {
  const { serveMcp } = await import("../server/mcp.mjs");
  serveMcp();
} else if (args[0] === "setup") {
  // from npx the package sits in a cache that can go away, so name the package, not the path
  const viaNpx = BIN.includes(`${path.sep}_npx${path.sep}`);
  const run = viaNpx ? ["npx", "-y", "@openscout/canvas", "mcp"] : [process.execPath, BIN, "mcp"];
  const add = ["mcp", "add", "--scope", "user", "scout-canvas", "--", ...run];
  const shown = `claude ${add.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  if (args.includes("--print")) { console.log(shown); process.exit(0); }
  let has = false;
  try { execFileSync("claude", ["mcp", "get", "scout-canvas"], { stdio: "ignore" }); has = true; } catch (e) {
    if (e.code === "ENOENT") fail(`the claude command isn't on PATH. Run this where it is:\n  ${shown}`);
  }
  if (has) {
    console.log("Claude Code already has the Scout Canvas tools. To set them up again: claude mcp remove --scope user scout-canvas, then this again.");
    process.exit(0);
  }
  try { execFileSync("claude", add, { stdio: "inherit" }); } catch { fail(`that didn't work. The command was:\n  ${shown}`); }
  console.log("\nDone. New Claude Code sessions have screens, point and pointers. Sessions already open get them after /mcp or a restart.");
} else if (args[0] === "link") {
  const { ensure, call } = await import("../server/local.mjs");
  const { findSession } = await import("../server/link.mjs");
  const session = opt("--session") || findSession()?.id;
  if (!session) fail("no Claude Code session here. Run it from a session, or pass --session <id>.");
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
      console.log(`Scout Canvas is at ${url}`);
      show(url);
      break;
    } catch (e) {
      if (e.code !== "EADDRINUSE") fail(e.message);
      if (await ours(port)) {
        const url = `http://localhost:${port}`;
        console.log(`Scout Canvas is already running at ${url}`);
        show(url);
        process.exit(0);
      }
      if (asked) fail(`port ${port} is taken. Try another --port.`);
      if (port === first + 9) fail(`ports ${first} to ${port} are all taken. Use --port <n>.`);
    }
  }
}
