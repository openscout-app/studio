// Finding the Scout Studio that runs on this Mac, and starting one when none does.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIRST_PORT = Number(process.env.SCOUT_STUDIO_PORT) || 4801;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "scout-studio.mjs");

/** Is Scout Studio answering on this port? */
export async function ours(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/notes`, { signal: AbortSignal.timeout(1500) });
    return res.ok && Array.isArray((await res.json()).notes);
  } catch { return false; }
}

/** The port Scout Studio answers on, or 0. */
export async function running(first = FIRST_PORT) {
  for (let p = first; p < first + 10; p++) if (await ours(p)) return p;
  return 0;
}

/** The base URL of a running Scout Studio, starting one in the background if it must. */
export async function ensure() {
  let port = await running();
  if (port) return `http://localhost:${port}`;
  const child = spawn(process.execPath, [BIN, "--no-open", "--no-setup"], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40 && !port; i++) { await new Promise((r) => setTimeout(r, 250)); port = await running(); }
  if (!port) throw new Error("Scout Studio didn't start. Run `npx github:openscout-app/studio` to see why.");
  return `http://localhost:${port}`;
}

/** Call the running Scout Studio's API. Throws with the server's reason. */
export async function call(base, method, p, body) {
  const res = await fetch(base + p, {
    method, headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60e3),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}
