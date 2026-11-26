import { useEffect, useMemo, useState } from "react";
import {
  ago,
  img,
  provenanceLabel,
  provenanceOfScreen,
  provenanceOfShow,
  revisionOf,
  showView,
  type CanvasData,
  type Screen,
  type Session,
  type Show,
  type SurfaceProvenance,
} from "./api";
import { docTitle, groupShows } from "./folio";

type LibraryItem =
  | {
      kind: "show";
      id: string;
      title: string;
      subtitle: string;
      project: string;
      branch: string;
      at: number;
      provenance: SurfaceProvenance;
      revision: number;
      subjectLabel?: string;
      folioId?: string;
      folioTitle?: string;
      folioIndex?: number;
      show: Show;
    }
  | {
      kind: "screen";
      id: string;
      title: string;
      subtitle: string;
      project: string;
      branch: string;
      at: number;
      provenance: SurfaceProvenance;
      revision: number;
      subjectLabel?: string;
      screen: Screen;
      session: Session;
    };

export type LibraryFilter = "all" | "docs" | "screens";

const PROVENANCE_ORDER: readonly SurfaceProvenance[] = ["shown", "written", "workspace", "captured"];

export function Library({
  data,
  query,
  filter: controlledFilter,
  onFilterChange,
  onOpenStage,
}: {
  data: CanvasData | null;
  query: string;
  filter?: LibraryFilter;
  onFilterChange?: (next: LibraryFilter) => void;
  onOpenStage: (sessionId: string, hash: string) => void;
}) {
  const [internalFilter, setInternalFilter] = useState<LibraryFilter>("all");
  const filter = controlledFilter ?? internalFilter;
  const setFilter = onFilterChange ?? setInternalFilter;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentTag, setAgentTag] = useState("");
  const [noteText, setNoteText] = useState("");
  const [copiedCmd, setCopiedCmd] = useState(false);

  const items = useMemo<LibraryItem[]>(() => {
    if (!data) return [];
    const list: LibraryItem[] = [];
    for (const p of data.projects) {
      for (const s of p.sessions) {
        const groups = groupShows(s.shows || []);
        for (const g of groups) {
          if (g.kind === "folio") {
            g.shows.forEach((show, idx) => {
              list.push({
                kind: "show",
                id: `show:${show.id}`,
                title: docTitle(show),
                subtitle: show.name,
                project: p.name,
                branch: show.branch || s.branch,
                at: show.at,
                provenance: provenanceOfShow(show),
                revision: revisionOf(show),
                subjectLabel: show.subject?.label,
                folioId: g.id,
                folioTitle: g.title,
                folioIndex: idx + 1,
                show,
              });
            });
          } else {
            const show = g.show;
            list.push({
              kind: "show",
              id: `show:${show.id}`,
              title: show.view === "markdown" ? docTitle(show) : (show.caption || show.name),
              subtitle: show.caption || show.name,
              project: p.name,
              branch: show.branch || s.branch,
              at: show.at,
              provenance: provenanceOfShow(show),
              revision: revisionOf(show),
              subjectLabel: show.subject?.label,
              show,
            });
          }
        }
        for (const sc of s.screens.slice().reverse()) {
          list.push({
            kind: "screen",
            id: `screen:${sc.id}`,
            title: sc.caption || sc.url || sc.file || s.title,
            subtitle: s.title,
            project: p.name,
            branch: s.branch,
            at: sc.at,
            provenance: provenanceOfScreen(sc),
            revision: revisionOf(sc),
            subjectLabel: sc.subject?.label,
            screen: sc,
            session: s,
          });
        }
      }
    }
    return list;
  }, [data]);

  const counts = useMemo(() => {
    let docs = 0;
    let screens = 0;
    for (const item of items) {
      if (item.kind === "show" && item.show.view !== "image" && item.show.view !== "video") docs++;
      else screens++;
    }
    return { all: items.length, docs, screens };
  }, [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "docs" && !(item.kind === "show" && item.show.view !== "image" && item.show.view !== "video")) return false;
      if (filter === "screens" && (item.kind === "show" && item.show.view !== "image" && item.show.view !== "video")) return false;
      if (!q) return true;
      const folio = item.kind === "show" ? item.folioTitle || "" : "";
      const hay = `${item.title} ${item.subtitle} ${item.project} ${item.branch} ${folio} ${item.subjectLabel || ""} ${provenanceLabel(item.provenance)} v${item.revision}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, filter, query]);

  // Group visible surfaces honestly by first-principles provenance (`Shown`, `Written`, `Workspace`, `Captured`)
  const sections = useMemo(() => {
    const buckets = new Map<SurfaceProvenance, LibraryItem[]>();
    for (const item of visible) {
      const list = buckets.get(item.provenance);
      if (list) list.push(item);
      else buckets.set(item.provenance, [item]);
    }
    return PROVENANCE_ORDER
      .filter((prov) => (buckets.get(prov)?.length ?? 0) > 0)
      .map((prov) => ({
        key: prov,
        provenance: prov,
        title: provenanceLabel(prov),
        items: buckets.get(prov)!.slice().sort((a, b) => b.at - a.at),
      }));
  }, [visible]);

  const orderedVisible = useMemo(() => sections.flatMap((sec) => sec.items), [sections]);

  const selected = useMemo(
    () => orderedVisible.find((i) => i.id === selectedId) ?? orderedVisible[0] ?? null,
    [orderedVisible, selectedId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || !orderedVisible.length) return;
      const idx = selected ? orderedVisible.findIndex((i) => i.id === selected.id) : 0;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedId(orderedVisible[(idx + 1) % orderedVisible.length].id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedId(orderedVisible[(idx - 1 + orderedVisible.length) % orderedVisible.length].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderedVisible, selected]);

  const copyAskCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !noteText.trim()) return;
    const target = agentTag.trim().replace(/^@/, "");
    const artifactPath = selected.kind === "show" ? selected.show.path : selected.screen.file || selected.screen.url || selected.title;
    const cmd = target
      ? `scout ask --to ${target} ${JSON.stringify(`Re: ${artifactPath} — ${noteText.trim()}`)}`
      : `scout ask ${JSON.stringify(`Re: ${artifactPath} — ${noteText.trim()}`)}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="library">
      <aside className="library-rail" aria-label="Library index">
        {controlledFilter === undefined ? (
          <div className="library-filters" role="tablist" aria-label="Artifact type">
            <button type="button" role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>
              All <span className="library-pill-count">{counts.all}</span>
            </button>
            <button type="button" role="tab" aria-selected={filter === "docs"} onClick={() => setFilter("docs")}>
              Docs <span className="library-pill-count">{counts.docs}</span>
            </button>
            <button type="button" role="tab" aria-selected={filter === "screens"} onClick={() => setFilter("screens")}>
              Screens <span className="library-pill-count">{counts.screens}</span>
            </button>
          </div>
        ) : null}

        <div className="library-list">
          {sections.length === 0 ? (
            <div className="library-empty-rail">
              {data ? "No surfaces match this filter." : "Loading library…"}
            </div>
          ) : (
            sections.map((sec) => (
              <section key={sec.key} className="library-group" data-provenance={sec.provenance}>
                <header className="library-group-head">
                  <span className="library-group-label">
                    <span className="library-prov-dot" data-provenance={sec.provenance} />
                    <span>{sec.title}</span>
                  </span>
                  <span className="library-group-count">{sec.items.length}</span>
                </header>
                {sec.items.map((item) => {
                  const active = selected?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`library-row${active ? " active" : ""}`}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <span className="library-kind-dot" data-kind={item.kind} data-provenance={item.provenance} />
                      <span className="library-row-main">
                        <span className="library-row-top">
                          <span className="library-row-title">{item.title}</span>
                          {item.revision > 1 ? (
                            <span className="library-rev-badge" title={`Revision ${item.revision}`}>
                              v{item.revision}
                            </span>
                          ) : null}
                        </span>
                        <span className="library-row-meta">
                          <span className="library-row-sub">
                            {item.project}
                            {item.kind === "show" && item.folioTitle ? ` · ${item.folioTitle}` : ""}
                          </span>
                          <span>{ago(item.at)}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </aside>

      <section className="library-stage" aria-label="Artifact preview">
        {!selected ? (
          <div className="library-empty-stage">
            <h2>Library</h2>
            <p>Shown, written, workspace, and captured surfaces from your agents appear here with revision history.</p>
          </div>
        ) : (
          <>
            <header className="library-head">
              <div className="library-head-copy">
                <h1>{selected.title}</h1>
                <span className="surface-prov-badge" data-provenance={selected.provenance}>
                  {provenanceLabel(selected.provenance)}
                </span>
                {selected.revision > 1 ? (
                  <span className="surface-rev-badge" title={`Revision ${selected.revision}`}>
                    v{selected.revision}
                  </span>
                ) : null}
                <span className="library-head-meta">
                  {selected.project}
                  {selected.branch ? ` · ${selected.branch}` : ""}
                  {` · ${ago(selected.at)}`}
                </span>
              </div>
              <div className="library-head-actions">
                {selected.kind === "show" ? (
                  <a
                    className="s-ds-btn s-ds-btn--secondary"
                    href={showView(selected.show)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in a tab
                  </a>
                ) : (
                  <button
                    type="button"
                    className="s-ds-btn s-ds-btn--secondary"
                    onClick={() => onOpenStage(selected.session.id, selected.screen.hash)}
                  >
                    Pin on Canvas
                  </button>
                )}
              </div>
            </header>

            <div className="library-viewer">
              {selected.kind === "screen" ? (
                <div className="library-media">
                  <img src={img(selected.screen)} alt={selected.title} />
                </div>
              ) : selected.show.view === "image" ? (
                <div className="library-media">
                  <img src={showView(selected.show)} alt={selected.title} />
                </div>
              ) : selected.show.view === "video" ? (
                <div className="library-media">
                  <video src={showView(selected.show)} controls />
                </div>
              ) : (
                <iframe
                  key={selected.show.id}
                  src={showView(selected.show)}
                  title={selected.title}
                  sandbox={
                    selected.show.view === "html"
                      ? "allow-scripts allow-popups"
                      : selected.show.view === "pdf"
                        ? undefined
                        : ""
                  }
                />
              )}
            </div>

            <form className="library-feedback" onSubmit={copyAskCommand}>
              <input
                className="library-agent-input"
                placeholder="@agent"
                aria-label="Tag agent"
                value={agentTag}
                onChange={(e) => setAgentTag(e.target.value)}
              />
              <input
                className="library-note-input"
                placeholder="Ask an agent to review, revise, or follow up on this artifact…"
                aria-label="Feedback note"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
              />
              <button
                type="submit"
                className="s-ds-btn s-ds-btn--secondary"
                disabled={!noteText.trim()}
              >
                {copiedCmd ? "Copied scout ask" : "Copy ask"}
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
