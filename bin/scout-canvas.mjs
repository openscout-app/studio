#!/usr/bin/env node
// scout-canvas [--port 4801] [--no-open]
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../server/serve.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--port");
const port = Number(at >= 0 ? args[at + 1] : process.env.PORT) || 4801;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.html");
if (!fs.existsSync(dist)) { console.error("scout-canvas: the app isn't built. Run `npm run build` first."); process.exit(1); }

serve(port).then(() => {
  const url = `http://localhost:${port}`;
  console.log(`Scout Canvas is at ${url}`);
  if (!args.includes("--no-open")) execFile("open", [url], () => {});
}, (e) => {
  console.error(e.code === "EADDRINUSE" ? `scout-canvas: port ${port} is taken. Try --port <n>.` : `scout-canvas: ${e.message}`);
  process.exit(1);
});
