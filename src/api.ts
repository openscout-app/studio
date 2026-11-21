// What the server sends, and the calls the page makes.
export type Screen = {
  id: string; hash: string; ext: string; w: number; h: number; at: number;
  tool: string; url: string | null; file: string | null; caption: string;
  before: { hash: string; ext: string; at: number } | null; open: boolean;
};
export type Session = {
  id: string; cwd: string; branch: string; title: string; prompt: string;
  firstAt: number; lastAt: number; open: boolean; working: boolean; attention: unknown;
  screens: Screen[];
};
export type Project = { name: string; root: string; sessions: Session[] };
export type Loading = { done: boolean; first: boolean; read: number; total: number; sessions: number };
export type CanvasData = { at: number; hours: number; scout: { up: boolean }; projects: Project[]; loading: Loading };

export type Step = { what: "waiting" | "failed" | "sent" | "handed"; at: number; why?: string; how?: string | null; task?: string | null };
export type Note = {
  id: string; session: string; project: string; cwd: string;
  screen: { hash: string; ext: string; w: number; h: number; url: string | null; file: string | null };
  x: number; y: number; text: string; at: number; trail: Step[]; kept?: boolean; tries?: number;
  arrivedAt: number | null; answers: { at: number; text: string }[];
};

export const img = (s: { hash: string; ext: string }) => `/img/${s.hash}.${s.ext}`;
export const thumb = (s: { hash: string; ext: string }) => `/img/t/${s.hash}.${s.ext}`;

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || res.statusText);
  return res.json();
}
export const api = {
  canvas: (hours: number) => call<CanvasData>("GET", `/api/canvas?hours=${hours}`),
  notes: () => call<{ notes: Note[] }>("GET", "/api/notes").then((r) => r.notes),
  add: (n: { session: string; project: string; cwd: string; screen: Screen; x: number; y: number; text: string }) => call<{ note: Note }>("POST", "/api/notes", n),
  handOff: (id: string) => call("POST", `/api/notes/${id}/handoff`),
  retry: (id: string) => call("POST", `/api/notes/${id}/retry`),
  keep: (id: string, kept: boolean) => call("POST", `/api/notes/${id}/keep`, { kept }),
  remove: (id: string) => call("DELETE", `/api/notes/${id}`),
};

export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
