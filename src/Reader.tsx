// The reader: one shown file, full size. Pictures and video sit on the stage; documents and pages
// are framed from Studio's server, which serves each one sandboxed, so nothing in an agent's file
// can reach Studio or send a note.
import { useEffect } from "react";
import { ago, showView, type Show } from "./api";

export function Reader({ show, onClose }: { show: Show; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  const src = showView(show);
  const where = [show.worktree.replace(/^\/Users\/[^/]+/, "~"), show.branch].filter(Boolean).join(" · ");
  return (
    <div className="reader" role="dialog" aria-label={show.name}>
      <div className="reader-bar">
        <button className="ghost" onClick={onClose}>Close</button>
        <span className="title">{show.name}</span>
        <span className="where">{where} · shown {ago(show.at)}{show.versions > 1 ? ` · ${show.versions} versions` : ""}</span>
        <a className="ghost" href={src} target="_blank" rel="noreferrer">Open in a tab</a>
      </div>
      {show.view === "image" ? (
        <div className="reader-main media"><img src={src} alt={show.caption || show.name} /></div>
      ) : show.view === "video" ? (
        <div className="reader-main media"><video src={src} controls /></div>
      ) : show.view === "file" ? (
        <div className="reader-main media"><a className="ghost" href={src} download={show.name}>Save {show.name}</a></div>
      ) : (
        <div className="reader-main"><iframe src={src} title={show.name} sandbox={show.view === "html" ? "allow-scripts allow-popups" : show.view === "pdf" ? undefined : ""} /></div>
      )}
      {show.caption && <div className="reader-cap">{show.caption}</div>}
    </div>
  );
}
