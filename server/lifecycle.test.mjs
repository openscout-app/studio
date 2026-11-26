import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-lifecycle-"));
process.env.SCOUT_STUDIO_HOME = path.join(dir, "studio");
process.env.SCOUT_STUDIO_CLAUDE_PROJECTS = path.join(dir, "claude");
process.env.CODEX_HOME = path.join(dir, "codex");
process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1";

const { serve } = await import("./serve.mjs");
const { buildInfo, statusAt, stopInstance } = await import("./local.mjs");
const BIN = fileURLToPath(new URL("../bin/scout-studio.mjs", import.meta.url));

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test("statusAt reports build metadata and stopInstance cleanly closes the server", async () => {
  const server = await serve(0);
  const port = server.address().port;
  const info = await statusAt(port);
  assert.ok(info);
  assert.equal(info.legacy, false);
  assert.equal(info.product, "scout-studio");
  assert.equal(info.buildId, buildInfo().buildId);
  assert.equal(info.pid, process.pid);

  // Browser or headerless POSTs cannot stop the server.
  const noHeader = await fetch(`http://localhost:${port}/api/stop`, { method: "POST" });
  assert.equal(noHeader.status, 403);
  const withOrigin = await fetch(`http://localhost:${port}/api/stop`, {
    method: "POST",
    headers: { "x-scout-studio": "cli", origin: `http://localhost:${port}` },
  });
  assert.equal(withOrigin.status, 403);

  const stopped = await stopInstance(info);
  assert.equal(stopped.stopped, true);
  assert.equal(await statusAt(port), null);
});

test("statusAt detects legacy servers without /api/status", async () => {
  const legacy = http.createServer((req, res) => {
    if (req.url === "/api/notes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ notes: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((ok) => legacy.listen(0, "127.0.0.1", ok));
  const port = legacy.address().port;
  try {
    const info = await statusAt(port);
    assert.ok(info);
    assert.equal(info.legacy, true);
    assert.equal(info.buildId, null);
  } finally {
    await new Promise((ok) => legacy.close(ok));
  }
});

test("CLI status and stop manage a live background Studio server", async () => {
  const server = await serve(0);
  const port = server.address().port;
  const env = { ...process.env, SCOUT_STUDIO_PORT: String(port) };

  const statusRun = await execFileAsync(process.execPath, [BIN, "status", "--port", String(port), "--json"], { env });
  const parsed = JSON.parse(statusRun.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.instances.length, 1);
  assert.equal(parsed.instances[0].port, port);
  assert.equal(parsed.instances[0].upToDate, true);

  const stopRun = await execFileAsync(process.execPath, [BIN, "stop", "--port", String(port)], { env });
  assert.match(stopRun.stdout, /Stopped Scout Studio/);
  assert.equal(await statusAt(port), null);
});

test("launching Studio replaces a stale build holding the same port", async () => {
  let closed = false;
  const stale = http.createServer((req, res) => {
    if (req.url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, product: "scout-studio", version: "0.1.0", buildId: "000000000000", pid: process.pid }));
      return;
    }
    if (req.url === "/api/stop" && req.method === "POST" && req.headers["x-scout-studio"] === "cli") {
      res.once("finish", () => { closed = true; stale.close(); });
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((ok) => stale.listen(0, "127.0.0.1", ok));
  const port = stale.address().port;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [BIN, "--port", String(port), "--no-open", "--no-setup"], {
    env: { ...process.env, SCOUT_STUDIO_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  try {
    const deadline = Date.now() + 8000;
    let current = null;
    while (Date.now() < deadline) {
      current = await statusAt(port);
      if (current && current.buildId === buildInfo().buildId) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(closed, true);
    assert.equal(current?.buildId, buildInfo().buildId);
    assert.match(out, /Updated Scout Studio/);
  } finally {
    await stopInstance(port);
    child.kill("SIGTERM");
  }
});
