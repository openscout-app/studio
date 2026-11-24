// Use each host's own user-scoped registration. Never replace an existing entry.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { findBun, findScout } from "./paths.mjs";
import { runtimeUrl } from "./runtime.mjs";

const name = "scout-studio";
const quote = arg => /^[a-zA-Z0-9_./:@-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'";
const hosts = [
  { id: "hermes", bin: "hermes", inspect: ["config", "get", "mcp_servers." + name],
    present: r => r.ok, missing: r => /config key not set/i.test(r.error),
    add: ([command, ...args]) => ["config", "set", "mcp_servers." + name, JSON.stringify({ command, args })] },
  { id: "claude", bin: "claude", inspect: ["mcp", "get", name],
    present: r => r.ok, missing: r => /no MCP server named/i.test(r.error),
    add: run => ["mcp", "add", "--scope", "user", name, "--", ...run] },
  { id: "codex", bin: "codex", inspect: ["mcp", "list", "--json"],
    present: r => JSON.parse(r.out).some(s => s.name === name),
    add: run => ["mcp", "add", name, "--", ...run] },
  { id: "antigravity", bin: "agy", inspect: ["mcp", "list"],
    present: r => /^\s*scout-studio\s/m.test(r.out),
    add: run => ["mcp", "add", "--type", "stdio", name, ...run] },
  { id: "grok", bin: "grok", inspect: ["mcp", "list"],
    present: r => /^\s*scout-studio(?:\s|:|$)/m.test(r.out),
    add: ([exe, ...args]) => ["mcp", "add", "--scope", "user", name, exe, "--", ...args] },
];

function execute(bin, args, options = {}) {
  return new Promise(resolve => {
    const child = execFile(bin, args, { timeout: 10000, ...options }, (err, out, stderr) =>
      resolve({ ok: !err, missing: err?.code === "ENOENT", out, error: (stderr || "") + (err ? out : "") }));
    child.stdin?.end();
  });
}

function hasPlugin(value) {
  if (!value || typeof value !== "object") return false;
  if ((value.name === name || value.id?.split?.("@")[0] === name) && value.enabled !== false && value.installed !== false) return true;
  return Object.values(value).some(hasPlugin);
}

export async function registerTools(run, { print = false, exec = execute, log = console.log } = {}) {
  for (const h of hosts) {
    const add = h.add([...run, "--host", h.id]);
    if (print) { log([h.bin, ...add].map(quote).join(" ")); continue; }
    const r = await exec(h.bin, h.inspect);
    if (r.missing) continue;
    try {
      if (!r.ok && !h.missing?.(r)) { log(`${h.id}: couldn't read MCP settings.`); continue; }
      if (h.present(r)) { log(`${h.id}: already connected.`); continue; }
      if (h.id === "claude" || h.id === "codex") {
        const plugins = await exec(h.bin, ["plugin", "list", "--json"]);
        if (plugins.ok && hasPlugin(JSON.parse(plugins.out))) { log(`${h.id}: Studio plugin installed.`); continue; }
      }
      const result = await exec(h.bin, add);
      if (result.ok && h.id === "claude") {
        const legacy = await exec(h.bin, ["mcp", "get", "scout-canvas"]);
        if (legacy.ok) await exec(h.bin, ["mcp", "remove", "--scope", "user", "scout-canvas"]);
      }
      log(result.ok ? `${h.id}: connected. New sessions can use Studio.` : `${h.id}: registration failed. See setup --print for the command.`);
    } catch { log(`${h.id}: couldn't read MCP settings.`); }
  }
}

// Cursor uses a user JSON file. OpenCode has a native global add command, but its
// "mcp list" starts configured servers. Inspect the global entry without starting them.
export async function registerFileHosts(run, { print = false, exec = execute, log = console.log, home = os.homedir(), env = process.env } = {}) {
  const cursorDir = path.join(home, ".cursor");
  const config = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  const hosts = [
    { id: "cursor", file: path.join(cursorDir, "mcp.json"), key: "mcpServers" },
    { id: "opencode", file: path.join(config, "opencode.json"), key: "mcp" },
  ];
  for (const h of hosts) {
    const cmd = [...run, "--host", h.id];
    const entry = { command: cmd[0], args: cmd.slice(1) };
    let tmp;
    try {
      if (print) {
        log(h.id === "cursor" ? `Cursor: add ${JSON.stringify({ [name]: entry })} to mcpServers in ~/.cursor/mcp.json` : `OpenCode: opencode mcp add --global ${name} -- ${cmd.map(quote).join(" ")}`);
        continue;
      }
      if (h.id === "cursor") {
        if (!fs.existsSync(cursorDir) && !(await exec("cursor-agent", ["--version"])).ok) continue;
      } else {
        const help = await exec("opencode", ["mcp", "add", "--help"]);
        if (!help.ok || !help.out.includes("--global")) continue;
        if (env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR || ["opencode.jsonc", "config.json"].some(f => fs.existsSync(path.join(config, f)))) {
          log("opencode: custom configuration detected. See setup --print."); continue;
        }
      }
      let previous;
      try { previous = fs.readFileSync(h.file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const data = previous === undefined ? {} : JSON.parse(previous);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid configuration");
      const section = data[h.key] ?? {};
      if (typeof section !== "object" || Array.isArray(section)) throw Error("Invalid MCP configuration");
      if (Object.hasOwn(section, name) || (h.id === "opencode" && Object.hasOwn(section.servers || {}, name))) { log(h.id + ": already configured."); continue; }
      if (h.id === "opencode") {
        const r = await exec("opencode", ["mcp", "add", "--global", name, "--", ...cmd]);
        if (!r.ok) throw Error("Registration failed");
      } else {
        data[h.key] = { ...section, [name]: entry };
        fs.mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
        tmp = h.file + "." + crypto.randomUUID() + ".tmp";
        const stat = previous === undefined ? null : fs.lstatSync(h.file);
        if (stat && !stat.isFile()) throw Error("Custom configuration file");
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: stat ? stat.mode & 0o777 : 0o600 });
        if (previous === undefined) fs.linkSync(tmp, h.file);
        else {
          if (fs.readFileSync(h.file, "utf8") !== previous) throw Error("Configuration changed");
          fs.renameSync(tmp, h.file);
        }
      }
      log(h.id + ": connected. New sessions can use Studio.");
    } catch { log(h.id + ": couldn't update MCP settings. See setup --print."); }
    finally { if (tmp) fs.rmSync(tmp, { force: true }); }
  }
}

export async function setupStudio(bin, { print = false, scout = true } = {}) {
  const run = bin.includes(path.sep + "_npx" + path.sep)
    ? ["npx", "-y", "github:openscout-app/studio", "mcp"] : [process.execPath, bin, "mcp"];
  await Promise.all([registerTools(run, { print }), registerFileHosts(run, { print }), !print && scout && ensureScout()]);
}

async function ensureScout() {
  const up = await fetch(runtimeUrl() + "/v1/tail/discover", { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
  if (up) return;
  const bun = findBun(), scout = findScout();
  if (!bun || !scout) { console.log("Studio is ready. Live note delivery needs Scout and Bun 1.4.4+."); return; }
  const result = await execute(scout, ["setup"], { timeout: 90000, env: { ...process.env, PATH: path.dirname(bun) + ":" + (process.env.PATH || "") } });
  if (!result.ok) console.log("Studio is ready. Run scout doctor to check live note delivery.");
}
