import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-first-principles-"));
process.env.SCOUT_STUDIO_HOME = path.join(root, "studio");
process.env.SCOUT_STUDIO_CLAUDE_PROJECTS = path.join(root, "claude");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.SCOUT_STUDIO_ANTIGRAVITY_BRAIN = path.join(root, "agy-brain");
process.env.SCOUT_STUDIO_KIMI_SESSIONS = path.join(root, "kimi-sessions");
process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1";

const { handle } = await import("./api.mjs");
const { serve } = await import("./serve.mjs");
const { stopWatchShows, streamStats } = await import("./runtime.mjs");

const realFetch = globalThis.fetch;
const mockServers = [];
const virtualRuntimes = new Map();

// Probe whether this test runner permits outbound loopback TCP sockets (full host vs restricted sandbox)
let loopbackTcpAllowed = false;
let studioServer = null;
let studioBase = "http://localhost:4899";
try {
  studioServer = await serve(0);
  studioBase = `http://localhost:${studioServer.address().port}`;
  const probe = await realFetch(`${studioBase}/api/notes`);
  loopbackTcpAllowed = probe.status === 200;
} catch {
  loopbackTcpAllowed = false;
}

function invokeHandler(fn, method, rawUrl, headers = {}, bodyText = "") {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    const u = new URL(rawUrl);
    req.method = method;
    req.url = `${u.pathname}${u.search}`;
    req.headers = { host: u.host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
    req.destroy = () => {};

    const res = new EventEmitter();
    let status = 200;
    let outHeaders = {};
    const chunks = [];
    let resolved = false;
    let streamController = null;
    let streamClosed = false;

    const abortStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      if (streamController) {
        try { streamController.error(new DOMException("Aborted", "AbortError")); } catch {}
      }
      req.emit("close");
      res.emit("close");
    };

    const finishHttp = () => {
      if (resolved) return;
      resolved = true;
      const fullBuf = Buffer.concat(chunks);
      const hMap = new Headers();
      for (const [k, v] of Object.entries(outHeaders)) {
        if (v !== undefined) hMap.set(k.toLowerCase(), String(v));
      }
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: hMap,
        text: async () => fullBuf.toString("utf8"),
        json: async () => JSON.parse(fullBuf.toString("utf8")),
        arrayBuffer: async () => fullBuf.buffer.slice(fullBuf.byteOffset, fullBuf.byteOffset + fullBuf.byteLength),
      });
    };

    res.setHeader = (k, v) => { outHeaders[k.toLowerCase()] = v; };
    res.getHeader = (k) => outHeaders[k.toLowerCase()];
    res.writeHead = (code, h = {}) => {
      status = code;
      for (const [k, v] of Object.entries(h)) outHeaders[k.toLowerCase()] = v;
      if (String(outHeaders["content-type"] || "").includes("text/event-stream") && !resolved) {
        resolved = true;
        const hMap = new Headers();
        for (const [k, v] of Object.entries(outHeaders)) {
          if (v !== undefined) hMap.set(k.toLowerCase(), String(v));
        }
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            for (const c of chunks.splice(0)) controller.enqueue(c);
          },
          cancel() {
            streamClosed = true;
            req.emit("close");
            res.emit("close");
          },
        });
        resolve({ ok: status >= 200 && status < 300, status, headers: hMap, body: stream, _abortStream: abortStream });
      }
    };
    res.write = (chunk) => {
      if (streamClosed) return false;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (streamController) {
        try { streamController.enqueue(b); } catch { return false; }
      } else {
        chunks.push(b);
      }
      return true;
    };
    res.end = (chunk) => {
      if (chunk !== undefined && chunk !== null) res.write(chunk);
      if (streamController) {
        streamClosed = true;
        try { streamController.close(); } catch {}
      } else {
        finishHttp();
      }
      res.emit("finish");
    };
    res.once = res.on.bind(res);
    res.removeListener = res.off.bind(res);

    Promise.resolve(fn(req, res)).catch(() => {
      if (!resolved) {
        status = 500;
        finishHttp();
      }
    });

    setImmediate(() => {
      if (bodyText) req.emit("data", Buffer.from(bodyText));
      req.emit("end");
    });
  });
}

if (!loopbackTcpAllowed) {
  globalThis.fetch = async (input, init = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw);
    const origin = `${u.protocol}//${u.host}`;
    if (origin === studioBase) {
      return invokeHandler(handle, init.method || "GET", raw, init.headers || {}, init.body ? String(init.body) : "");
    }
    const mockHandler = virtualRuntimes.get(origin);
    if (mockHandler) {
      if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const res = await invokeHandler(mockHandler, init.method || "GET", raw, init.headers || {}, init.body ? String(init.body) : "");
      if (init.signal && res._abortStream) {
        init.signal.addEventListener("abort", () => res._abortStream(), { once: true });
      }
      return res;
    }
    throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
  };
}

async function studioFetch(urlPath, init = {}) {
  return globalThis.fetch(`${studioBase}${urlPath}`, init);
}

async function studioJson(method, urlPath, body) {
  const res = await studioFetch(urlPath, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(res.ok, true, `${method} ${urlPath} failed with ${res.status}`);
  return res.json();
}

let virtualPort = 49100;
async function listenMock(handler) {
  if (loopbackTcpAllowed) {
    const s = http.createServer(handler);
    mockServers.push(s);
    await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
    return { url: `http://127.0.0.1:${s.address().port}` };
  }
  const url = `http://127.0.0.1:${virtualPort++}`;
  virtualRuntimes.set(url, handler);
  return { url };
}

after(async () => {
  stopWatchShows();
  globalThis.fetch = realFetch;
  virtualRuntimes.clear();
  for (const s of mockServers) {
    s.closeAllConnections?.();
    await new Promise((ok) => s.close(ok));
  }
  if (studioServer) {
    studioServer.closeAllConnections?.();
    await new Promise((ok) => studioServer.close(ok));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
  } catch {
    fs.mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
}

function makePng(w, h, fillByte = 0) {
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows = Buffer.alloc((w + 1) * h, fillByte);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("consumes scout.observed-surfaces/v1, single global /v1/shows/events SSE, revision stacking, and byte proxying", async () => {
  const repo = path.join(root, "atlas-core");
  initGitRepo(repo);

  const screenV1Bytes = makePng(960, 600, 12);
  const screenV2Bytes = makePng(960, 600, 88);
  const shaV1 = crypto.createHash("sha256").update(screenV1Bytes).digest("hex");
  const shaV2 = crypto.createHash("sha256").update(screenV2Bytes).digest("hex");

  const shownSpecBytes = Buffer.from("---\ntitle: Observed Surfaces Contract\nstatus: Final\n---\n\n# Contract v3\n\nFirst-principles surface model.\n");
  const writtenStudyBytes = Buffer.from("<!doctype html><html><head><title>Timeline Study</title></head><body><h1>Study v2</h1></body></html>");
  const workspaceDeckBytes = Buffer.from("<!doctype html><html><head><title>Ambient Architecture Deck</title></head><body><h1>Deck</h1></body></html>");

  const now = Date.now();
  const sessionId = "sess-observed-01";
  const surfaceBytes = new Map([
    ["srf_screen_v1", { bytes: screenV1Bytes, mediaType: "image/png" }],
    ["srf_screen_v2", { bytes: screenV2Bytes, mediaType: "image/png" }],
    ["srf_spec_v3", { bytes: shownSpecBytes, mediaType: "text/markdown" }],
    ["srf_study_v2", { bytes: writtenStudyBytes, mediaType: "text/html" }],
    ["srf_ws_deck", { bytes: workspaceDeckBytes, mediaType: "text/html" }],
  ]);

  let items = [
    {
      id: "srf_screen_v1",
      subject: { key: "page:localhost:4801/library", kind: "page", label: "localhost:4801/library" },
      revision: 1,
      provenance: "captured",
      kind: "screen",
      mediaType: "image/png",
      nodeId: "node-local",
      projectRoot: repo,
      worktree: repo,
      branch: "feat/surfaces",
      session: { nodeId: "node-local", harness: "claude", nativeSessionId: sessionId },
      url: "http://localhost:4801/library",
      dimensions: { width: 960, height: 600 },
      byteSize: screenV1Bytes.length,
      sha256: shaV1,
      title: "Initial library rail",
      caption: "Initial library rail",
      createdAt: now - 120_000,
    },
    {
      id: "srf_screen_v2",
      subject: { key: "page:localhost:4801/library", kind: "page", label: "localhost:4801/library" },
      revision: 2,
      supersedes: "srf_screen_v1",
      provenance: "captured",
      kind: "screen",
      mediaType: "image/png",
      nodeId: "node-local",
      projectRoot: repo,
      worktree: repo,
      branch: "feat/surfaces",
      session: { nodeId: "node-local", harness: "claude", nativeSessionId: sessionId },
      url: "http://localhost:4801/library",
      dimensions: { width: 960, height: 600 },
      byteSize: screenV2Bytes.length,
      sha256: shaV2,
      title: "Library with provenance badges",
      caption: "Library with provenance badges",
      createdAt: now - 60_000,
    },
    {
      id: "srf_spec_v1",
      subject: { key: "file:plans/surfaces.md", kind: "file", label: "plans/surfaces.md" },
      revision: 1,
      provenance: "written",
      kind: "markdown",
      mediaType: "text/markdown",
      nodeId: "node-local",
      projectRoot: repo,
      worktree: repo,
      branch: "feat/surfaces",
      session: { nodeId: "node-local", harness: "claude", nativeSessionId: sessionId },
      sourcePath: path.join(repo, "plans/surfaces.md"),
      byteSize: shownSpecBytes.length,
      title: "Observed Surfaces Draft",
      createdAt: now - 180_000,
    },
    {
      id: "srf_spec_v3",
      subject: { key: "file:plans/surfaces.md", kind: "file", label: "plans/surfaces.md" },
      revision: 3,
      supersedes: "srf_spec_v2",
      provenance: "shown",
      kind: "markdown",
      mediaType: "text/markdown",
      nodeId: "node-local",
      projectRoot: repo,
      worktree: repo,
      branch: "feat/surfaces",
      session: { nodeId: "node-local", harness: "claude", nativeSessionId: sessionId },
      agentId: "architect",
      sourcePath: path.join(repo, "plans/surfaces.md"),
      byteSize: shownSpecBytes.length,
      title: "Observed Surfaces Contract",
      caption: "Observed Surfaces Contract",
      createdAt: now - 30_000,
      showId: "11111111-2222-4333-8444-555555555555",
    },
    {
      id: "srf_study_v2",
      subject: { key: "file:design/studio/timeline.html", kind: "file", label: "design/studio/timeline.html" },
      revision: 2,
      supersedes: "srf_study_v1",
      provenance: "written",
      kind: "html",
      mediaType: "text/html",
      nodeId: "node-local",
      projectRoot: repo,
      worktree: repo,
      branch: "feat/surfaces",
      session: { nodeId: "node-local", harness: "claude", nativeSessionId: sessionId },
      sourcePath: path.join(repo, "design/studio/timeline.html"),
      byteSize: writtenStudyBytes.length,
      title: "Timeline Study",
      caption: "Timeline Study",
      createdAt: now - 45_000,
    },
    {
      id: "srf_ws_deck",
      subject: { key: "file:design/studio/ambient-deck.html", kind: "file", label: "design/studio/ambient-deck.html" },
      revision: 1,
      provenance: "workspace",
      kind: "html",
      mediaType: "text/html",
      nodeId: "node-local",
      projectRoot: repo,
      worktree: repo,
      branch: "feat/surfaces",
      sourcePath: path.join(repo, "design/studio/ambient-deck.html"),
      byteSize: workspaceDeckBytes.length,
      title: "Ambient Architecture Deck",
      caption: "Ambient Architecture Deck",
      createdAt: now - 90_000,
    },
  ];

  const seenRequests = [];
  const sseClients = new Set();

  const mockRuntime = await listenMock((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    seenRequests.push(`${req.method} ${u.pathname}${u.search}`);

    if (u.pathname === "/v1/tail/discover") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        transcripts: [{ sessionId, cwd: repo, source: "claude", customTitle: "First-Principles Surface Sweep", mtimeMs: now }],
      }));
      return;
    }

    if (u.pathname === "/v1/observed-surfaces") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        schema: "scout.observed-surfaces/v1",
        nodeId: "node-local",
        generatedAt: Date.now(),
        windowMs: Number(u.searchParams.get("windowMs") || 0),
        items,
        counts: { items: items.length, subjects: 4, shown: 1, captured: 2, written: 2, workspace: 1 },
      }));
      return;
    }

    const bMatch = u.pathname.match(/^\/v1\/observed-surfaces\/([^/]+)\/bytes$/);
    if (bMatch) {
      const entry = surfaceBytes.get(decodeURIComponent(bMatch[1]));
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "surface_not_found" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-security-policy": "sandbox; default-src 'none'",
      });
      res.end(entry.bytes);
      return;
    }

    if (u.pathname === "/v1/shows/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": connected\n\n");
      sseClients.add({ res, projectRoot: u.searchParams.get("projectRoot") });
      req.on("close", () => {
        for (const c of sseClients) if (c.res === res) sseClients.delete(c);
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  process.env.SCOUT_RUNTIME_URL = mockRuntime.url;

  const data = await studioJson("GET", "/api/canvas?hours=24");
  assert.equal(data.scout.up, true);
  assert.equal(data.scout.observedSurfaces, true);

  assert.ok(seenRequests.some((r) => r === `GET /v1/observed-surfaces?windowMs=${24 * 3600_000}`));
  for (let i = 0; i < 30 && sseClients.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(sseClients.size, 1, "should open exactly 1 global /v1/shows/events stream");
  assert.equal([...sseClients][0].projectRoot, null, "global /v1/shows/events stream must omit projectRoot");
  assert.equal(streamStats().perRootStreams, 0);

  const project = data.projects.find((p) => p.name === "atlas-core");
  assert.ok(project, "atlas-core project should be mapped from observed surfaces");

  const session = project.sessions.find((s) => s.id === sessionId);
  assert.ok(session, "Claude session should appear with title from /v1/tail/discover");
  assert.equal(session.title, "First-Principles Surface Sweep");

  assert.equal(session.screens.length, 2);
  const [sc1, sc2] = session.screens;
  assert.equal(sc1.provenance, "captured");
  assert.equal(sc1.revision, 1);
  assert.equal(sc2.provenance, "captured");
  assert.equal(sc2.revision, 2);
  assert.equal(sc2.supersedes, "srf_screen_v1");
  assert.deepEqual(sc2.before, { hash: sc1.hash, ext: "png", at: sc1.at });

  const imgRes = await studioFetch(`/img/${sc2.hash}.png`);
  assert.equal(imgRes.status, 200);
  assert.deepEqual(Buffer.from(await imgRes.arrayBuffer()), screenV2Bytes);

  assert.equal(session.shows.length, 2);
  const specShow = session.shows.find((s) => s.id === "srf_spec_v3");
  assert.ok(specShow);
  assert.equal(specShow.provenance, "shown");
  assert.equal(specShow.revision, 3);
  assert.equal(specShow.versions, 3);

  const studyShow = session.shows.find((s) => s.id === "srf_study_v2");
  assert.ok(studyShow);
  assert.equal(studyShow.provenance, "written");
  assert.equal(studyShow.revision, 2);

  const specView = await studioFetch(`/api/shows/${specShow.id}/view`);
  assert.equal(specView.status, 200);
  assert.match(specView.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.match(await specView.text(), /Contract v3/);

  const studyView = await studioFetch(`/api/shows/${studyShow.id}/view`);
  assert.equal(studyView.status, 200);
  assert.match(studyView.headers.get("content-security-policy") || "", /sandbox allow-scripts/);
  assert.equal(studyView.headers.get("cache-control"), "no-store");
  assert.match(await studyView.text(), /Study v2/);

  const wsSession = project.sessions.find((s) => s.id === "workspace:atlas-core");
  assert.ok(wsSession);
  assert.equal(wsSession.shows.length, 1);
  assert.equal(wsSession.shows[0].provenance, "workspace");
  assert.equal(wsSession.shows[0].revision, 1);

  // Global SSE `show.created` invalidates observedCache immediately so revision v4 appears without delay
  const specV4Bytes = Buffer.from("# Contract v4\n");
  surfaceBytes.set("srf_spec_v4", { bytes: specV4Bytes, mediaType: "text/markdown" });
  items = [
    ...items,
    {
      ...items.find((i) => i.id === "srf_spec_v3"),
      id: "srf_spec_v4",
      revision: 4,
      supersedes: "srf_spec_v3",
      createdAt: Date.now(),
    },
  ];
  for (const c of sseClients) {
    c.res.write(`event: show.created\nid: show-4\ndata: ${JSON.stringify({ id: "show-4", projectRoot: repo })}\n\n`);
  }
  await new Promise((r) => setTimeout(r, 30));

  const updated = await studioJson("GET", "/api/canvas?hours=24");
  const updatedSpec = updated.projects
    .find((p) => p.name === "atlas-core")
    .sessions.find((s) => s.id === sessionId)
    .shows.find((sh) => sh.subject?.key === "file:plans/surfaces.md");
  assert.equal(updatedSpec.id, "srf_spec_v4");
  assert.equal(updatedSpec.revision, 4);
});

test("falls back cleanly to per-root SSE + local multi-harness scanner when older runtime returns 400/404", async () => {
  const repo = path.join(root, "legacy-fallback-repo");
  initGitRepo(repo);
  const realRepo = fs.realpathSync(repo);

  const shot1 = path.join(realRepo, "scratch", "board-v1.png");
  const shot2 = path.join(realRepo, "scratch", "board-v2.png");
  fs.mkdirSync(path.dirname(shot1), { recursive: true });
  fs.writeFileSync(shot1, makePng(800, 500, 21));
  fs.writeFileSync(shot2, makePng(800, 500, 99));

  const writtenHtml = path.join(realRepo, "design", "studio", "cards-study.html");
  const wsHtml = path.join(realRepo, "design", "studio", "ambient-grid.html");
  fs.mkdirSync(path.dirname(writtenHtml), { recursive: true });
  fs.writeFileSync(writtenHtml, "<!doctype html><html><head><title>Cards Study</title></head><body>Cards</body></html>");
  fs.writeFileSync(wsHtml, "<!doctype html><html><head><title>Ambient Grid</title></head><body>Grid</body></html>");

  const shownMdPath = path.join(realRepo, "plans", "legacy-spec.md");
  fs.mkdirSync(path.dirname(shownMdPath), { recursive: true });
  fs.writeFileSync(shownMdPath, "# Legacy Draft v1\n");
  const shownV2Body = Buffer.from("---\ntitle: Legacy Spec\n---\n\n# Legacy Spec v2\n");

  const secretEnv = path.join(realRepo, ".env");
  fs.writeFileSync(secretEnv, "SECRET_TOKEN=nope\n");

  const sessionId = crypto.randomUUID();
  const codexDay = path.join(process.env.CODEX_HOME, "sessions/2026/11/26");
  fs.mkdirSync(codexDay, { recursive: true });
  const t1 = new Date(Date.now() - 60_000).toISOString();
  const t2 = new Date(Date.now() - 20_000).toISOString();
  const patch = `*** Begin Patch\n*** Add File: ${writtenHtml}\n+<!doctype html>\n*** Add File: ${shownMdPath}\n+# Draft\n*** Add File: ${secretEnv}\n+SECRET\n*** End Patch`;
  const records = [
    [t1, "session_meta", { id: sessionId, cwd: realRepo }],
    [t1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Capture board v1 and draft cards study" }] }],
    [t1, "response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "p1", input: patch }],
    [t1, "response_item", { type: "custom_tool_call_output", call_id: "p1", output: "Success." }],
    [t1, "response_item", { type: "function_call", name: "exec_command", call_id: "s1", arguments: JSON.stringify({ cmd: `scout browser screenshot "${shot1}"` }) }],
    [t1, "response_item", { type: "function_call_output", call_id: "s1", output: `Saved ${shot1}` }],
    [t1, "event_msg", { type: "task_complete" }],
    [t2, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Capture updated board v2" }] }],
    [t2, "response_item", { type: "function_call", name: "exec_command", call_id: "s2", arguments: JSON.stringify({ cmd: `scout browser screenshot "${shot2}"` }) }],
    [t2, "response_item", { type: "function_call_output", call_id: "s2", output: `Saved ${shot2}` }],
    [t2, "event_msg", { type: "task_complete" }],
  ];
  fs.writeFileSync(
    path.join(codexDay, `rollout-legacy-${sessionId}.jsonl`),
    records.map(([timestamp, type, payload]) => JSON.stringify({ type, payload, timestamp })).join("\n") + "\n",
  );

  const showIdV1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
  const showIdV2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
  const legacyCalls = { globalEvents400: 0, perRootEvents: [], observed404: 0, perRootShows: [] };

  const legacyRuntime = await listenMock((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/v1/observed-surfaces") {
      legacyCalls.observed404++;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (u.pathname === "/v1/tail/discover") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ transcripts: [{ sessionId, cwd: realRepo, source: "codex", mtimeMs: Date.now() }] }));
      return;
    }
    if (u.pathname === "/v1/shows/events") {
      const pr = u.searchParams.get("projectRoot");
      if (!pr) {
        legacyCalls.globalEvents400++;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_show_project" }));
        return;
      }
      legacyCalls.perRootEvents.push(pr);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      return;
    }
    if (u.pathname === "/v1/shows") {
      const pr = u.searchParams.get("projectRoot");
      if (!pr) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_show_project" }));
        return;
      }
      legacyCalls.perRootShows.push(pr);
      const shows = pr === realRepo
        ? [
            {
              id: showIdV1,
              itemId: "item-legacy-spec",
              sessionId,
              agentId: "codex",
              harness: "codex",
              projectRoot: realRepo,
              worktree: realRepo,
              branch: "main",
              sourcePath: shownMdPath,
              kind: "document",
              mediaType: "text/markdown",
              byteSize: 20,
              sha256: "1111",
              caption: "Legacy Spec",
              createdAt: Date.now() - 40_000,
            },
            {
              id: showIdV2,
              itemId: "item-legacy-spec",
              sessionId,
              agentId: "codex",
              harness: "codex",
              projectRoot: realRepo,
              worktree: realRepo,
              branch: "main",
              sourcePath: shownMdPath,
              kind: "document",
              mediaType: "text/markdown",
              byteSize: shownV2Body.length,
              sha256: "2222",
              caption: "Legacy Spec",
              createdAt: Date.now() - 10_000,
            },
          ]
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ shows }));
      return;
    }
    if (u.pathname === `/v1/shows/${showIdV2}/bytes`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(shownV2Body);
      return;
    }
    res.writeHead(404).end();
  });

  process.env.SCOUT_RUNTIME_URL = legacyRuntime.url;

  let data;
  for (let i = 0; i < 40; i++) {
    data = await studioJson("GET", "/api/canvas?hours=24");
    if (data.loading.done && data.projects.some((p) => p.name === "legacy-fallback-repo")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(data.scout.up, true);
  assert.equal(data.scout.observedSurfaces, false);
  assert.ok(legacyCalls.observed404 >= 1, "should probe /v1/observed-surfaces first");

  for (let i = 0; i < 30 && !legacyCalls.perRootEvents.includes(realRepo); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(legacyCalls.globalEvents400 >= 1, "should try global /v1/shows/events first");
  assert.ok(legacyCalls.perRootEvents.includes(realRepo), "should fall back to per-root /v1/shows/events on 400");
  assert.ok(legacyCalls.perRootShows.includes(realRepo), "should fall back to per-root /v1/shows on 400");

  const project = data.projects.find((p) => p.name === "legacy-fallback-repo");
  assert.ok(project);

  const session = project.sessions.find((s) => s.id === sessionId);
  assert.ok(session);

  assert.equal(session.screens.length, 2);
  assert.equal(session.screens[0].provenance, "captured");
  assert.equal(session.screens[0].revision, 1);
  assert.equal(session.screens[1].provenance, "captured");
  assert.equal(session.screens[1].revision, 2);
  assert.ok(session.screens[1].before);

  assert.equal(session.shows.some((s) => s.name === ".env"), false);
  const shownSpec = session.shows.find((s) => s.id === showIdV2);
  assert.ok(shownSpec);
  assert.equal(shownSpec.provenance, "shown");
  assert.ok(shownSpec.revision >= 2);

  const writtenCard = session.shows.find((s) => s.caption === "Cards Study");
  assert.ok(writtenCard);
  assert.equal(writtenCard.provenance, "written");
  assert.equal(writtenCard.revision, 1);

  const wsSession = project.sessions.find((s) => s.id === "workspace:legacy-fallback-repo");
  assert.ok(wsSession);
  assert.equal(wsSession.shows[0].provenance, "workspace");
  assert.equal(wsSession.shows[0].caption, "Ambient Grid");

  const crossOrigin = await studioFetch("/api/canvas", { headers: { origin: "https://evil.example" } });
  assert.equal(crossOrigin.status, 403);

  const nonLocalHost = await studioFetch("/api/canvas", { headers: { host: "example.com" } });
  assert.equal(nonLocalHost.status, 403);
});

test("rejects symlinks, hardlinks (nlink > 1), secret paths, and outside-worktree files in fallback discovery", async () => {
  const { allowedRootsFor, ingestImageFile, localShowBytes, registerLocalShow } = await import("./artifacts.mjs");
  const repo = path.join(root, "containment-repo");
  initGitRepo(repo);
  const realRepo = fs.realpathSync(repo);
  const allowed = allowedRootsFor(realRepo);

  // Outside file + symlink inside worktree
  const outsideHtml = path.join(root, "outside-secret.html");
  fs.writeFileSync(outsideHtml, "<!doctype html><html><head><title>Outside</title></head><body>no</body></html>");
  const symHtml = path.join(realRepo, "design", "sym.html");
  fs.mkdirSync(path.dirname(symHtml), { recursive: true });
  fs.symlinkSync(outsideHtml, symHtml);
  assert.equal(registerLocalShow(outsideHtml, realRepo, allowed), null);
  assert.equal(registerLocalShow(symHtml, realRepo, allowed), null);

  // Hardlinked document (nlink === 2) must be rejected both on registration and on byte read
  const origMd = path.join(realRepo, "plans", "hardlink-a.md");
  const hardMd = path.join(realRepo, "plans", "hardlink-b.md");
  fs.mkdirSync(path.dirname(origMd), { recursive: true });
  fs.writeFileSync(origMd, "# Hardlink Test\n");
  fs.linkSync(origMd, hardMd);
  assert.equal(registerLocalShow(origMd, realRepo, allowed), null, "nlink > 1 markdown must be rejected");
  fs.unlinkSync(hardMd);

  // Once nlink === 1, registration succeeds; if hardlinked later before read, localShowBytes rejects it
  const validShow = registerLocalShow(origMd, realRepo, allowed, { projectRoot: realRepo });
  assert.ok(validShow);
  assert.ok(localShowBytes(validShow.id));
  fs.linkSync(origMd, hardMd);
  assert.equal(localShowBytes(validShow.id), null, "localShowBytes must re-check nlink === 1 at read time");
  fs.unlinkSync(hardMd);

  // Hardlinked image must also be rejected
  const origShot = path.join(realRepo, "scratch", "shot-a.png");
  const hardShot = path.join(realRepo, "scratch", "shot-b.png");
  fs.mkdirSync(path.dirname(origShot), { recursive: true });
  fs.writeFileSync(origShot, makePng(800, 500, 55));
  fs.linkSync(origShot, hardShot);
  assert.equal(ingestImageFile(origShot, realRepo, allowed), null, "nlink > 1 screenshot must be rejected");
  fs.unlinkSync(hardShot);
});
