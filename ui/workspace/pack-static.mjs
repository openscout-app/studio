// Emit one portable asset bundle for HTML servers which run without npm install.
import { readFile, writeFile } from "node:fs/promises";
import { workspaceAsset, browserFiles } from "./assets.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: node pack-static.mjs <output.mjs>");
const { name, version } = JSON.parse(await readFile(new URL("./package.json", import.meta.url)));
const files = [];
for (const filename of browserFiles) {
  const path = "/scout-ui/" + filename;
  const asset = workspaceAsset(path, { feedback: true });
  files.push([path, { type: asset.type, body: await readFile(asset.url, "utf8") }]);
}
await writeFile(output, "// Generated from " + name + " v" + version + " (Apache-2.0).\n" +
  "const assets = new Map(" + JSON.stringify(files) + ");\n" +
  "export function workspaceAsset(pathname) { return assets.get(pathname); }\n");
if (output.endsWith(".mjs")) {
  await writeFile(output.slice(0, -4) + ".d.mts",
    "export function workspaceAsset(pathname: string): { type: string; body: string } | undefined;\n");
}
