import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-autodiscovery-"));
process.env.SCOUT_STUDIO_HOME = path.join(root, "studio");
process.env.SCOUT_STUDIO_CLAUDE_PROJECTS = path.join(root, "claude");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.SCOUT_STUDIO_ANTIGRAVITY_BRAIN = path.join(root, "agy-brain");
process.env.SCOUT_STUDIO_KIMI_SESSIONS = path.join(root, "kimi-sessions");
process.env.SCOUT_RUNTIME_URL = "http://127.0.0.1:1";

const { serve } = await import("./serve.mjs");
const { call } = await import("./local.mjs");
const server = await serve(0);
const base = `http://localhost:${server.address().port}`;
const samplePng = fileURLToPath(new URL("../docs/studio-light.png", import.meta.url));

after(async () => {
  await new Promise((ok) => server.close(ok));
  fs.rmSync(root, { recursive: true, force: true });
});

function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"]);
}

test("discovers shell-captured screenshots, agent-written HTML/Markdown, and workspace studies while blocking escapes", async () => {
  const repo = path.join(root, "acme-web");
  initGitRepo(repo);

  // 1. A shell-captured screenshot and an agent-written HTML study + Markdown plan inside the repo
  const shotPath = path.join(repo, "scratch", "hero-after.png");
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.copyFileSync(samplePng, shotPath);

  const studyPath = path.join(repo, "design", "studio", "board-study.html");
  fs.mkdirSync(path.dirname(studyPath), { recursive: true });
  fs.writeFileSync(studyPath, "<!doctype html><html><head><title>Board Study</title></head><body><h1>Study</h1></body></html>");

  const planPath = path.join(repo, "plans", "rollout-plan.md");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, "---\ntitle: Rollout Plan\n---\n\nShip the discovery layer.\n");

  // Uncontained file outside the repo + symlink escape inside the repo
  const outsideShot = path.join(root, "secret-outside.png");
  fs.copyFileSync(samplePng, outsideShot);
  const symlinkEscape = path.join(repo, "scratch", "escape.png");
  fs.symlinkSync(outsideShot, symlinkEscape);

  // Workspace-only HTML study not touched by the transcript
  const wsOnlyStudy = path.join(repo, "design", "studio", "cold-start-deck.html");
  fs.writeFileSync(wsOnlyStudy, "<!doctype html><html><head><title>Cold Start Deck</title></head><body>Deck</body></html>");

  const sessionId = randomUUID();
  const codexDay = path.join(process.env.CODEX_HOME, "sessions/2026/11/25");
  fs.mkdirSync(codexDay, { recursive: true });
  const timestamp = new Date().toISOString();
  const patch = `*** Begin Patch\n*** Add File: ${studyPath}\n+<!doctype html>\n*** Add File: ${planPath}\n+# Rollout\n*** End Patch`;
  const records = [
    ["session_meta", { id: sessionId, cwd: repo }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Capture the hero and draft the study" }] }],
    ["response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "c1", input: patch }],
    ["response_item", { type: "custom_tool_call_output", call_id: "c1", output: "Success." }],
    ["response_item", { type: "function_call", name: "exec_command", call_id: "c2", arguments: JSON.stringify({ cmd: `scout browser screenshot "${shotPath}"` }) }],
    ["response_item", { type: "function_call_output", call_id: "c2", output: `Saved screenshot to ${shotPath}` }],
    ["response_item", { type: "function_call", name: "exec_command", call_id: "c3", arguments: JSON.stringify({ cmd: `scout browser screenshot "${outsideShot}" && scout browser screenshot "${symlinkEscape}"` }) }],
    ["response_item", { type: "function_call_output", call_id: "c3", output: "Done" }],
    ["event_msg", { type: "task_complete" }],
  ];
  fs.writeFileSync(
    path.join(codexDay, `rollout-test-${sessionId}.jsonl`),
    records.map(([type, payload]) => JSON.stringify({ type, payload, timestamp })).join("\n") + "\n",
  );

  // Wait for background transcript load to finish
  let data;
  for (let i = 0; i < 40; i++) {
    data = await call(base, "GET", "/api/canvas?hours=72");
    if (data.loading.done) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(data.loading.done, true);

  const project = data.projects.find((p) => p.name === "acme-web");
  assert.ok(project, "acme-web project should be discovered");

  const session = project.sessions.find((s) => s.id === sessionId);
  assert.ok(session, "Codex session should appear from file-backed screenshot + written docs");
  assert.equal(session.screens.length, 1, "only the contained screenshot should be ingested; outside and symlink-escape paths must be rejected");
  assert.equal(session.screens[0].file, fs.realpathSync(shotPath));

  const titles = session.shows.map((s) => s.caption);
  assert.ok(titles.includes("Board Study"), "HTML <title> should be discovered");
  assert.ok(titles.includes("Rollout Plan"), "Markdown frontmatter title should be discovered");

  // Verify sandboxed view endpoint renders both HTML and Markdown shows
  const htmlShow = session.shows.find((s) => s.view === "html");
  const htmlRes = await fetch(`${base}/api/shows/${htmlShow.id}/view`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-security-policy") || "", /sandbox allow-scripts/);
  assert.match(await htmlRes.text(), /Board Study/);

  const mdShow = session.shows.find((s) => s.view === "markdown");
  const mdRes = await fetch(`${base}/api/shows/${mdShow.id}/view`);
  assert.equal(mdRes.status, 200);
  assert.match(mdRes.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.match(await mdRes.text(), /Rollout Plan/);

  // Workspace study untouched by the session should appear under Workspace · acme-web
  const wsSession = project.sessions.find((s) => s.id === "workspace:acme-web");
  assert.ok(wsSession, "workspace studies card should surface unclaimed design/studio pages");
  assert.ok(wsSession.shows.some((s) => s.caption === "Cold Start Deck"));
});

test("discovers Antigravity brain transcripts, scratch screenshots, and markdown artifacts", async () => {
  const repo = path.join(root, "orbit-app");
  initGitRepo(repo);

  const agyId = randomUUID();
  const brainDir = path.join(process.env.SCOUT_STUDIO_ANTIGRAVITY_BRAIN, agyId);
  const logsDir = path.join(brainDir, ".system_generated", "logs");
  const scratchDir = path.join(brainDir, "scratch");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });

  fs.copyFileSync(samplePng, path.join(scratchDir, "mobile-check.png"));
  fs.writeFileSync(path.join(brainDir, "architecture_one_pager.md"), "# Orbit Architecture\n\n Clean local flow.\n");

  const nowIso = new Date().toISOString();
  const steps = [
    {
      step: {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        metadata: { createdAt: nowIso },
        content: `<USER_REQUEST>Audit Orbit mobile layout</USER_REQUEST>\nActive Workspaces:\n- ${repo}\n`,
      },
    },
    {
      step: {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        metadata: { createdAt: nowIso },
        plannerResponse: { response: "Captured mobile layout and wrote architecture brief." },
      },
    },
  ];
  fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");

  let data;
  for (let i = 0; i < 40; i++) {
    data = await call(base, "GET", "/api/canvas?hours=24");
    if (data.loading.done && data.projects.some((p) => p.name === "orbit-app")) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const project = data.projects.find((p) => p.name === "orbit-app");
  assert.ok(project, "Antigravity workspace should be mapped to orbit-app");
  const session = project.sessions.find((s) => s.id === agyId);
  assert.ok(session);
  assert.equal(session.harness, "antigravity");
  assert.equal(session.screens.length, 1);
  assert.ok(session.shows.some((sh) => sh.caption === "Orbit Architecture"));
});
