// What the cursor tag says an agent is doing.
import test from "node:test";
import assert from "node:assert/strict";
import { describe, said } from "./doing.mjs";

test("a tool call reads as a few words, as on Scout's canvas", () => {
  assert.equal(describe("Edit", { file_path: "/a/src/Canvas.tsx" }), "Edited Canvas.tsx");
  assert.equal(describe("Read", { file_path: "/a/src/styles.css" }), "Read styles.css");
  assert.equal(describe("Grep", { pattern: "agent-cursor" }), "Searched agent-cursor");
  assert.equal(describe("Bash", { command: "cd /x && npm test", description: "Run the tests" }), "Run the tests");
  assert.equal(describe("Bash", { command: "cd /x && npm test" }), "npm test");
  assert.equal(describe("mcp__lattices__browser_screenshot", {}), "Browser screenshot");
  assert.equal(describe("mcp__lattices__browser_open", { url: "http://localhost:4801/" }), "Browser open localhost:4801/");
  assert.equal(describe("Agent", { description: "Find the cursor" }), "Started an agent: Find the cursor");
  assert.equal(describe("mcp__scout__ask", {}), "Messaged an agent");
  assert.equal(describe("mcp__scout__where", {}), "where");
});

test("long words are clipped, and what it wrote reads as its first line", () => {
  assert.equal(describe("Bash", { command: "x".repeat(100) }).length, 64);
  assert.equal(said("**Next**, checking the dock.\n\nMore detail"), "Next, checking the dock.");
  assert.equal(said("\n\n## A heading\nbody"), "A heading");
});
