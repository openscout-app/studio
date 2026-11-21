// The built app and its API, on one local port.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./api.mjs";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };

export function serve(port, host = "127.0.0.1") {
  const server = http.createServer(async (req, res) => {
    if (await handle(req, res)) return;
    const u = new URL(req.url, "http://local").pathname;
    let file = path.join(DIST, path.normalize(u).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok, no) => server.once("error", no).listen(port, host, () => ok(server)));
}
