import type { Show } from "./api";

export type ShowGroup =
  | { kind: "single"; show: Show }
  | { kind: "folio"; id: string; title: string; shows: Show[] };

const BURST_MS = 10 * 60_000;

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

/** Human-readable title for a shown markdown file. */
export function docTitle(show: Show): string {
  const cap = (show.caption || "").trim();
  if (cap && cap.length <= 72 && !cap.includes("\n")) return cap;
  const stem = show.name.replace(/\.[^.]+$/, "").replace(/^\d+[-_\s]+/, "");
  const clean = stem.replace(/[-_]+/g, " ").trim();
  if (!clean) return show.name;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function folioTitle(shows: Show[]): string {
  const dir = dirOf(shows[0].path);
  const folder = dir.split("/").filter(Boolean).pop();
  if (folder && !/^(research|docs|notes|plans|drafts)$/i.test(folder)) {
    const clean = folder.replace(/[-_]+/g, " ").trim();
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return `${shows.length} documents`;
}

/**
 * Group multiple markdown shows from one turn (same folder or within a short burst)
 * into a single Folio card by default, unless the user explicitly fanned it out.
 */
export function groupShows(shows: Show[], fanned: ReadonlySet<string> = new Set()): ShowGroup[] {
  const out: ShowGroup[] = [];
  let bucket: Show[] = [];

  const flush = () => {
    if (!bucket.length) return;
    if (bucket.length === 1) {
      out.push({ kind: "single", show: bucket[0] });
    } else {
      // Keep natural filename order inside a multi-doc folio (e.g. 01-, 02-, ..., 10-)
      const ordered = bucket.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const id = `folio:${ordered[0].id}`;
      if (fanned.has(id)) {
        for (const s of ordered) out.push({ kind: "single", show: s });
      } else {
        out.push({ kind: "folio", id, title: folioTitle(ordered), shows: ordered });
      }
    }
    bucket = [];
  };

  for (const show of shows) {
    if (show.view !== "markdown") {
      flush();
      out.push({ kind: "single", show });
      continue;
    }
    if (!bucket.length) {
      bucket.push(show);
      continue;
    }
    const prev = bucket[bucket.length - 1];
    const sameDir = dirOf(prev.path) === dirOf(show.path);
    const closeInTime = Math.abs(prev.at - show.at) <= BURST_MS;
    if (sameDir || closeInTime) {
      bucket.push(show);
    } else {
      flush();
      bucket.push(show);
    }
  }
  flush();
  return out;
}
