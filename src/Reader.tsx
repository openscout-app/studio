// The reader: one surface or shown file, or a master-detail reading room for a turn's N markdowns.
// Pictures and video sit on the stage; documents and pages are framed from Studio's server,
// which serves each one sandboxed, so nothing in an agent's file can reach Studio or send a note.
import { useEffect, useState } from "react";
import {
  ago,
  provenanceLabel,
  provenanceOfShow,
  provenanceVerb,
  revisionOf,
  showView,
  type Show,
} from "./api";
import { docTitle } from "./folio";

export function Reader({
  show,
  shows,
  onSelect,
  onClose,
}: {
  show: Show;
  shows?: Show[];
  onSelect?: (next: Show) => void;
  onClose: () => void;
}) {
  const list = shows && shows.length > 1 ? shows : [show];
  const index = Math.max(0, list.findIndex((s) => s.id === show.id));
  const multi = list.length > 1 && !!onSelect;
  const [visited, setVisited] = useState<Set<string>>(() => new Set([show.id]));

  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(show.id)) return prev;
      const next = new Set(prev);
      next.add(show.id);
      return next;
    });
  }, [show.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (!multi || !onSelect) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight" || e.key === "j") {
        e.preventDefault();
        onSelect(list[(index + 1) % list.length]);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "k") {
        e.preventDefault();
        onSelect(list[(index - 1 + list.length) % list.length]);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [index, list, multi, onClose, onSelect]);

  const src = showView(show);
  const prov = provenanceOfShow(show);
  const rev = revisionOf(show);
  const where = [show.worktree.replace(/^\/Users\/[^/]+/, "~"), show.branch].filter(Boolean).join(" · ");

  return (
    <div className={`reader${multi ? " has-rail" : ""}`} role="dialog" aria-label={docTitle(show)}>
      <div className="reader-bar">
        <button className="s-ds-btn s-ds-btn--secondary" onClick={onClose}>Close</button>
        {multi && onSelect && (
          <div className="reader-step">
            <button
              type="button"
              className="s-ds-btn s-ds-btn--secondary"
              title="Previous document (k / ←)"
              onClick={() => onSelect(list[(index - 1 + list.length) % list.length])}
            >
              ←
            </button>
            <span className="reader-count">{index + 1} / {list.length}</span>
            <button
              type="button"
              className="s-ds-btn s-ds-btn--secondary"
              title="Next document (j / →)"
              onClick={() => onSelect(list[(index + 1) % list.length])}
            >
              →
            </button>
          </div>
        )}
        <span className="title">{docTitle(show)}</span>
        <span className="surface-prov-badge" data-provenance={prov}>{provenanceLabel(prov)}</span>
        {rev > 1 && <span className="surface-rev-badge">v{rev}</span>}
        <span className="where">
          {where ? `${where} · ` : ""}
          {provenanceVerb(prov)} {ago(show.at)}
          {rev > 1 ? ` · ${rev} revisions` : ""}
        </span>
        <a className="s-ds-btn s-ds-btn--secondary" href={src} target="_blank" rel="noreferrer">Open in a tab</a>
      </div>

      <div className="reader-body">
        {multi && onSelect && (
          <aside className="reader-rail" aria-label="Documents in this set">
            <div className="reader-rail-head">
              <span>{list.length} documents</span>
              <span className="reader-rail-hint">j / k</span>
            </div>
            <div className="reader-rail-list">
              {list.map((item, i) => {
                const active = item.id === show.id;
                const seen = visited.has(item.id);
                const itemRev = revisionOf(item);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`reader-rail-item${active ? " active" : ""}${seen ? " seen" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onSelect(item)}
                  >
                    <span className="reader-rail-num">{String(i + 1).padStart(2, "0")}</span>
                    <span className="reader-rail-title">{docTitle(item)}</span>
                    {itemRev > 1 ? (
                      <span className="library-rev-badge">v{itemRev}</span>
                    ) : !seen ? (
                      <span className="reader-rail-dot" aria-label="Unread" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        {show.view === "image" ? (
          <div className="reader-main media"><img src={src} alt={show.caption || show.name} /></div>
        ) : show.view === "video" ? (
          <div className="reader-main media"><video src={src} controls /></div>
        ) : show.view === "file" ? (
          <div className="reader-main media"><a className="s-ds-btn s-ds-btn--secondary" href={src} download={show.name}>Save {show.name}</a></div>
        ) : (
          <div className="reader-main"><iframe key={show.id} src={src} title={docTitle(show)} sandbox={show.view === "html" ? "allow-scripts allow-popups" : show.view === "pdf" ? undefined : ""} /></div>
        )}
      </div>

      {show.caption && <div className="reader-cap">{show.caption}</div>}
    </div>
  );
}
