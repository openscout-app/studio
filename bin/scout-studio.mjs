#!/usr/bin/env node
// npx github:openscout-app/studio [--port 4801] [--no-open]     start Scout Studio and open it
// npx github:openscout-app/studio setup        start Scout, give Claude Code the tools (or: init)
// npx github:openscout-app/studio mcp                            the tools themselves (Claude Code runs this)
// npx github:openscout-app/studio link --at x,y --say "…"        point the person at a spot, from a shell
//
// Starting: if Scout Studio already runs on the port, it opens that one; if something else holds
// the port, it takes the next free one.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BIN = fileURLToPath(import.meta.url);
// how people run it: straight from the open repository on GitHub
const SPEC = "github:openscout-app/studio";
const HELP = `Usage:
  scout-studio [--port <n>] [--no-open]
      Show what your Claude Code sessions made, on Scout's canvas, at http://localhost:4801.

  scout-studio setup [--print] [--no-scout]
      Start Scout's runtime if it isn't up (scout setup; Scout comes with Scout Studio, and its
      runtime runs on Bun), which carries notes to your sessions. Then give every Claude Code session
      the Scout Studio tools (screens, point, pointers), so an agent can show you a precise spot
      on a screen it took. --print shows the tools command instead; --no-scout leaves Scout alone.

  scout-studio mcp
      The tools, as an MCP server over stdio. Claude Code runs this; you don't need to.

  scout-studio link [--screen <id|latest>] (--at <x,y> | --box <x,y,w,h>) [--fraction] --say <text> [--session <id>] [--open]
      From a shell in a Claude Code session: point the person at a spot and print the link.
      Coordinates are pixels of the screenshot, or 0 to 1 with --fraction.`;
if (args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(0); }
const fail = (m) => { console.error(`scout-studio: ${m}`); process.exit(1); };

/** Scout carries notes into sessions. Scout Studio brings its CLI; its runtime runs on Bun. Start it if
 * it isn't up. */
async function setupScout() {
  const { findScout, findBun, RUNTIME } = await import("../server/paths.mjs");
  const up = await fetch(`${RUNTIME}/v1/tail/discover`, { signal: AbortSignal.timeout(3e3) }).then((r) => r.ok, () => false);
  if (up) { console.log("Scout is up."); return; }
  const bun = findBun(), scout = findScout();
  if (!bun) {
    console.log("Scout carries notes to your sessions. Its runtime runs on Bun, which isn't on this Mac.\n" +
      "Install Bun (curl -fsSL https://bun.sh/install | bash), then run this again.\n" +
      "The canvas works meanwhile; notes wait for Scout.\n");
    return;
  }
  if (!scout) { console.log("Scout's CLI didn't come with Scout Studio. Reinstall, or see https://openscout.app/install.md.\n"); return; }
  console.log("Starting Scout: scout setup");
  const env = { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` };
  try { execFileSync(scout, ["setup"], { stdio: "inherit", env }); console.log(""); } catch {
    console.log("scout setup didn't finish. Run scout doctor to see why. The canvas works meanwhile; notes wait for Scout.\n");
  }
}

if (args[0] === "mcp") {
  const { serveMcp } = await import("../server/mcp.mjs");
  serveMcp();
} else if (args[0] === "setup" || args[0] === "init") {
  // from npx the package sits in a cache that can go away, so name the package, not the path
  const viaNpx = BIN.includes(`${path.sep}_npx${path.sep}`);
  const run = viaNpx ? ["npx", "-y", SPEC, "mcp"] : [process.execPath, BIN, "mcp"];
  const add = ["mcp", "add", "--scope", "user", "scout-studio", "--", ...run];
  const shown = `claude ${add.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  if (args.includes("--print")) { console.log(shown); process.exit(0); }
  if (!args.includes("--no-scout")) await setupScout();
  let has = false;
  try { execFileSync("claude", ["mcp", "get", "scout-studio"], { stdio: "ignore" }); has = true; } catch (e) {
    if (e.code === "ENOENT") fail(`the claude command isn't on PATH. Run this where it is:\n  ${shown}`);
  }
  if (has) {
    console.log("Claude Code already has the Scout Studio tools. To set them up again: claude mcp remove --scope user scout-studio, then this again.");
    process.exit(0);
  }
  try { execFileSync("claude", add, { stdio: "inherit" }); } catch { fail(`that didn't work. The command was:\n  ${shown}`); }
  // The tools' name before Scout Canvas became Scout Studio. Left in place, every session would
  // get each tool twice, so the old registration goes once the new one is in.
  try {
    execFileSync("claude", ["mcp", "get", "scout-canvas"], { stdio: "ignore" });
    execFileSync("claude", ["mcp", "remove", "--scope", "user", "scout-canvas"], { stdio: "ignore" });
    console.log("Removed the tools' old registration, scout-canvas.");
  } catch {}
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
      console.log(`Scout Studio is at ${url}`);
      show(url);
      break;
    } catch (e) {
      if (e.code !== "EADDRINUSE") fail(e.message);
      if (await ours(port)) {
        const url = `http://localhost:${port}`;
        console.log(`Scout Studio is already running at ${url}`);
        show(url);
        process.exit(0);
      }
      if (asked) fail(`port ${port} is taken. Try another --port.`);
      if (port === first + 9) fail(`ports ${first} to ${port} are all taken. Use --port <n>.`);
    }
  }
}
