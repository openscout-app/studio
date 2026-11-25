import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { browserFiles, workspaceAsset } from "../ui/workspace/assets.js";

test("static servers expose the frame and explicitly enable feedback", () => {
  assert.match(workspaceAsset("/scout-ui/frame.js").type, /javascript/);
  assert.equal(workspaceAsset("/scout-ui/feedback.js"), undefined);
  assert.equal(workspaceAsset("/scout-ui/package.json", { feedback: true }), undefined);
  assert.equal(workspaceAsset("/scout-ui/../frame.js"), undefined);
});

test("zero-install servers deliver the same UI package assets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-ui-"));
  try {
    const output = join(dir, "browser.mjs");
    const compiler = fileURLToPath(new URL("../ui/workspace/pack-static.mjs", import.meta.url));
    execFileSync(process.execPath, [compiler, output]);
    const portable = await import(pathToFileURL(output).href);
    for (const file of browserFiles) {
      const path = "/scout-ui/" + file;
      const { url, type } = workspaceAsset(path, { feedback: true });
      assert.deepEqual(portable.workspaceAsset(path), { type, body: await readFile(url, "utf8") });
    }
    assert.equal(portable.workspaceAsset("/scout-ui/package.json"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Studio ships a visible canvas shell before the app module", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const boot = html.match(/<div id="root">([\s\S]*?)<\/body>/)?.[1];
  assert.ok(boot, "boot markup must be inside the React root");
  assert.match(boot, /data-scout-boot="canvas"/);
  assert.match(boot, /Scout Studio/);
  assert.match(boot, /role="status"/);
  assert.match(html, /id="scout-boot-css"/);
});
