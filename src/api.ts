// What the server sends, and the calls the page makes.
export type SurfaceProvenance = "shown" | "captured" | "written" | "workspace";

export type SurfaceSubject = {
  key: string;
  kind: "page" | "window" | "file";
  label: string;
};

export type Screen = {
  id: string; hash: string; ext: string; w: number; h: number; at: number;
  tool: string; url: string | null; file: string | null; caption: string;
  before: { hash: string; ext: string; at: number } | null; open: boolean;
  provenance?: SurfaceProvenance;
  revision?: number;
  supersedes?: string;
  subject?: SurfaceSubject;
  surfaceId?: string;
};

export type Session = {
  id: string; harness?: string; cwd: string; branch: string; title: string; prompt: string;
  firstAt: number; lastAt: number; open: boolean; working: boolean; attention: unknown;
  /** what it did last, in a few words */
  now: string | null;
  screens: Screen[];
  /** shown, written, or workspace documents and visual studies associated with this session */
  shows: Show[];
};

/** A document or visual surface: shown via `scout show`, written in a turn, or observed in workspace. */
export type Show = {
  id: string; itemId: string; sessionId: string | null; agentId: string; harness: string | null;
  projectRoot: string; worktree: string; branch: string; path: string; name: string;
  view: "image" | "video" | "markdown" | "html" | "pdf" | "text" | "file";
  mediaType: string; size: number; caption: string; at: number; versions: number;
  provenance?: SurfaceProvenance;
  revision?: number;
  supersedes?: string;
  subject?: SurfaceSubject;
};

export const showView = (s: Show) => `/api/shows/${encodeURIComponent(s.id)}/view?root=${encodeURIComponent(s.projectRoot)}`;

export function provenanceOfShow(show: Pick<Show, "provenance">): SurfaceProvenance {
  return show.provenance ?? "shown";
}

export function provenanceOfScreen(screen: Pick<Screen, "provenance" | "tool">): SurfaceProvenance {
  if (screen.provenance) return screen.provenance;
  return screen.tool === "workspace" ? "workspace" : "captured";
}

export function provenanceLabel(p: SurfaceProvenance): "Shown" | "Captured" | "Written" | "Workspace" {
  if (p === "shown") return "Shown";
  if (p === "written") return "Written";
  if (p === "workspace") return "Workspace";
  return "Captured";
}

export function provenanceVerb(p: SurfaceProvenance): "shown" | "captured" | "written" | "observed" {
  if (p === "shown") return "shown";
  if (p === "written") return "written";
  if (p === "workspace") return "observed";
  return "captured";
}

export function revisionOf(item: { revision?: number; versions?: number; before?: unknown }): number {
  return Math.max(item.revision ?? 1, item.versions ?? 1, item.before ? 2 : 1);
}

export type Project = { name: string; root: string; sessions: Session[] };
export type Loading = { done: boolean; first: boolean; read: number; total: number; sessions: number };
export type SurfaceCounts = { items: number; subjects: number; shown: number; captured: number; written: number; workspace: number };
export type CanvasData = {
  at: number;
  hours: number;
  scout: { up: boolean; observedSurfaces?: boolean; url?: string; shows?: number; counts?: SurfaceCounts };
  projects: Project[];
  loading: Loading;
};

export type Step = { what: "available" | "waiting" | "failed" | "sent" | "handed"; at: number; why?: string; how?: string | null; task?: string | null };
export type Note = {
  id: string; session: string; project: string; cwd: string;
  screen: { hash: string; ext: string; w: number; h: number; url: string | null; file: string | null };
  x: number; y: number; text: string; at: number; trail: Step[]; kept?: boolean; tries?: number;
  arrivedAt: number | null; answers: { at: number; text: string }[];
};

/** A spot or area a session pointed the person at, with its screen kept as it was. */
export type Pointer = {
  id: string; session: string; cwd: string; say: string; at: number; seenAt: number | null;
  screen: { hash: string; ext: string; w: number; h: number; at: number; url: string | null; file: string | null; tool: string; caption: string };
  box: { x: number; y: number; w: number; h: number };
  replies: { at: number; text: string; note: string }[];
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
  add: (n: { session: string; harness?: string; project: string; cwd: string; screen: Screen; x: number; y: number; text: string; re?: string; reSay?: string }) => call<{ note: Note }>("POST", "/api/notes", n),
  pointer: (id: string) => call<{ pointer: Pointer }>("GET", `/api/pointers/${id}`),
  seen: (id: string) => call("POST", `/api/pointers/${id}/seen`),
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

/** "1 session", "3 sessions". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
