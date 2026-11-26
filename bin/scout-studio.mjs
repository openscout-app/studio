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
  scout-studio [--port <n>] [--restart] [--no-open] [--no-setup]
      Open the local canvas, replacing a stale build if one is running.
  scout-studio status [--port <n>] [--json]
      Show running Studio port, build, uptime, runtime health and 3-day counts.
  scout-studio restart [--port <n>] [--no-open] [--no-setup]
      Stop any running Studio server and start fresh on this build.
  scout-studio stop [--port <n>]
      Stop any running local Studio server.
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

function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
}

async function fetchQuickJson(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

if (args[0] === "mcp") {
  const { serveMcp } = await import("../server/mcp.mjs");
  serveMcp();
} else if (args[0] === "setup" || args[0] === "init") {
  await setupStudio(BIN, { print: args.includes("--print"), scout: !args.includes("--no-scout") });
} else if (args[0] === "status") {
  const { buildInfo, firstPort, instances, statusAt } = await import("../server/local.mjs");
  const cli = buildInfo();
  const asked = Number(opt("--port")) || 0;
  const list = asked ? [await statusAt(asked)].filter(Boolean) : await instances(firstPort());
  const enriched = await Promise.all(list.map(async (inst) => {
    const [hostStatus, canvas72] = await Promise.all([
      fetchQuickJson(`${inst.url}/api/host-status`, 1500),
      fetchQuickJson(`${inst.url}/api/canvas?hours=72`, 2500),
    ]);
    let summary = null;
    if (canvas72?.projects) {
      const sessions = canvas72.projects.flatMap((p) => p.sessions || []);
      const byHarness = {};
      for (const s of sessions) byHarness[s.harness || "claude"] = (byHarness[s.harness || "claude"] || 0) + 1;
      summary = {
        projects: canvas72.projects.length,
        sessions: sessions.length,
        byHarness,
        screens: sessions.reduce((n, s) => n + (s.screens?.length || 0), 0),
        shows: canvas72.shows?.length || 0,
        loading: canvas72.loading?.done === false,
      };
    }
    return {
      ...inst,
      upToDate: !inst.legacy && inst.buildId === cli.buildId,
      runtime: hostStatus ? { up: Boolean(hostStatus.runtimeUp), url: hostStatus.runtimeUrl } : null,
      canvas72h: summary,
    };
  }));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: enriched.length > 0, cli, instances: enriched }, null, 2));
  } else if (enriched.length === 0) {
    console.log("Scout Studio is not running.");
  } else {
    for (const inst of enriched) {
      const buildLabel = inst.legacy
        ? "legacy build (stale — run `scout-studio restart`)"
        : `${inst.version} (${inst.buildId}${inst.upToDate ? ", current" : ` -> ${cli.buildId} available, run \`scout-studio restart\``})`;
      const pidLabel = inst.pid ? ` · pid ${inst.pid}` : "";
      const upLabel = inst.uptimeMs != null ? ` · up ${formatUptime(inst.uptimeMs)}` : "";
      console.log(`Scout Studio at ${inst.url}${pidLabel}${upLabel}`);
      console.log(`  build:   ${buildLabel}`);
      if (inst.home) console.log(`  home:    ${inst.home}`);
      if (inst.runtime) console.log(`  runtime: ${inst.runtime.up ? "up" : "down"} (${inst.runtime.url})`);
      if (inst.canvas72h) {
        const c = inst.canvas72h;
        const harnesses = Object.entries(c.byHarness).map(([k, v]) => `${k}: ${v}`).join(", ");
        console.log(`  72h:     ${c.projects} project(s), ${c.sessions} session(s)${harnesses ? ` (${harnesses})` : ""}, ${c.screens} screen(s), ${c.shows} shown file(s)${c.loading ? " [scanning]" : ""}`);
      }
    }
  }
} else if (args[0] === "stop") {
  const { firstPort, instances, statusAt, stopInstance } = await import("../server/local.mjs");
  const asked = Number(opt("--port")) || 0;
  const list = asked ? [await statusAt(asked)].filter(Boolean) : await instances(firstPort());
  if (list.length === 0) {
    console.log("Scout Studio is not running.");
  } else {
    for (const inst of list) {
      const res = await stopInstance(inst);
      if (!res.stopped) fail(`couldn't stop Scout Studio at ${inst.url}`);
      console.log(`Stopped Scout Studio at ${inst.url}${res.pid ? ` (pid ${res.pid})` : ""}`);
    }
  }
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
  if (args[0] && !args[0].startsWith("-") && args[0] !== "restart") {
    fail(`unknown command "${args[0]}". Run \`scout-studio --help\`.`);
  }
  const { serve } = await import("../server/serve.mjs");
  const { buildInfo, firstPort, instances, statusAt, stopInstance } = await import("../server/local.mjs");
  const cli = buildInfo();
  const asked = Number(opt("--port") ?? process.env.PORT) || 0;
  const first = asked || firstPort();
  const open = !args.includes("--no-open");
  const forceRestart = args[0] === "restart" || args.includes("--restart");
  const dist = path.join(path.dirname(BIN), "..", "dist", "index.html");
  if (!fs.existsSync(dist)) fail("the app isn't built. Run `npm run build` first.");
  const show = (url) => { if (open && process.platform === "darwin") execFile("open", [url], () => {}); };
  const bind = async (port) => {
    const server = await serve(port);
    server.once("close", () => process.exit(0));
    return server;
  };
  if (forceRestart) {
    const list = asked ? [await statusAt(asked)].filter(Boolean) : await instances(firstPort());
    for (const inst of list) {
      const res = await stopInstance(inst);
      if (!res.stopped) fail(`couldn't stop Scout Studio at ${inst.url}`);
    }
  }
  for (let port = first; port < first + 10; port++) {
    try {
      await bind(port);
      const url = `http://localhost:${port}`;
      console.log(`${forceRestart ? "Restarted Scout Studio at" : "Scout Studio is at"} ${url}`);
      show(url);
      break;
    } catch (e) {
      if (e.code !== "EADDRINUSE") fail(e.message);
      const existing = await statusAt(port);
      if (existing) {
        if (!existing.legacy && existing.buildId === cli.buildId) {
          console.log(`Scout Studio is already running at ${existing.url}`);
          show(existing.url);
          break;
        }
        const stopped = await stopInstance(existing);
        if (!stopped.stopped) fail(`couldn't replace stale Scout Studio at ${existing.url}`);
        await bind(port);
        const url = `http://localhost:${port}`;
        console.log(`Updated Scout Studio at ${url} (${existing.buildId || "legacy"} -> ${cli.buildId})`);
        show(url);
        break;
      }
      if (asked) fail(`port ${port} is taken. Try another --port.`);
      if (port === first + 9) fail(`ports ${first} to ${port} are all taken. Use --port <n>.`);
    }
  }
  if (!args.includes("--no-setup")) await setupStudio(BIN);
}
