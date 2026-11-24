// Workspace feedback. Dynamic page content and saved notes are always inserted as text.
const icons = {
  browse: '<path d="m3 2 10 5-5 1.5L6 14Z"/>',
  feedback: '<path d="M2 2.5h12v9H6l-4 3z"/>',
  saved: '<path d="M4 2.5h8v11H4zM2 5h3m-3 3h3m-3 3h3m2-5h3m-3 2.5h3"/>',
  close: '<path d="m4 4 8 8m0-8-8 8"/>',
};
const icon = name => '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' + icons[name] + '</svg>';

export function isPoint(p) {
  return !!p && typeof p.id === "string" && typeof p.label === "string" && Number.isFinite(p.x) && Number.isFinite(p.y)
    && (p.space === "canvas" || (p.space === "fraction" && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
}
function position(p) {
  if (p.space === "general") return "Whole workspace";
  if (p.space === "canvas") return `x ${Math.round(p.x)}, y ${Math.round(p.y)}`;
  return `${Math.round(p.x * 100)}% across, ${Math.round(p.y * 100)}% down`;
}
function readSaved(prefix) {
  const notes = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const note = JSON.parse(localStorage.getItem(key));
      const p = note?.point;
      const general = p?.space === "general" && typeof p.label === "string" && typeof p.id === "string";
      if ((general || isPoint(p)) && typeof note.text === "string" && Number.isFinite(note.at)) notes.push(note);
    } catch { /* An unreadable record does not prevent reading the others. */ }
  }
  return notes.sort((a, b) => b.at - a.at);
}
const interactive = 'scout-app-frame,scout-side-nav,a,button,input,textarea,select,label,summary,form,nav,dialog,[role="button"],[role="tab"],[role="dialog"],[role="menu"],[contenteditable]:not([contenteditable="false"]),[draggable="true"],video,audio';

// The host lives outside the part of the page that changes. Studio supplies its own canvas hit testing.
export function mountWorkspaceTools(host, { product, project = "local", destination = "workspace", label, onModeChange, captureContent = true }) {
  const events = new AbortController();
  const drafts = new Map();
  let enabled = true, showingList = false, timer = 0;
  const key = () => `scout-${product}:feedback:${project}:${destination}:`;
  host.classList.add("scout-tools");
  host.innerHTML = `
    <div class="scout-note-panel" role="dialog" aria-label="Leave feedback" hidden>
      <div class="scout-note-head"><strong></strong><button type="button" data-action="close" aria-label="Cancel feedback">${icon("close")}</button></div>
      <form><textarea aria-label="Feedback" placeholder="What would you change here?"></textarea>
        <div class="scout-note-foot"><small>Only in this browser</small><button type="submit">Save feedback</button></div>
      </form><ul hidden></ul><p class="scout-no-notes" hidden>No saved feedback here yet.</p>
    </div>
    <div class="scout-tools-status" role="status" hidden></div>
    <div class="scout-tools-row" role="group" aria-label="Workspace feedback">
      <button type="button" data-action="browse" title="Browse" aria-label="Browse" aria-pressed="false">${icon("browse")}</button>
      <button type="button" data-action="feedback" aria-pressed="true">${icon("feedback")}<span>Click anywhere to leave feedback</span></button>
      <button type="button" data-action="saved" title="Saved feedback" aria-label="Saved feedback" aria-expanded="false">${icon("saved")}</button>
    </div>`;
  const find = selector => host.querySelector(selector);
  const panel = find(".scout-note-panel"), form = find("form"), field = find("textarea"), list = find("ul");
  const submit = find('[type="submit"]'), prompt = find('[data-action="feedback"]'), saved = find('[data-action="saved"]');
  const status = find('[role="status"]');

  function announce(value) {
    clearTimeout(timer);
    status.textContent = value;
    status.hidden = !value;
    if (value === "Saved in this browser") timer = setTimeout(() => announce(""), 2200);
  }
  function render() {
    const draft = drafts.get(destination);
    panel.hidden = !draft && !showingList;
    panel.setAttribute("aria-label", draft ? "Leave feedback" : "Saved feedback");
    find(".scout-note-head strong").textContent = draft?.point.label || "Saved feedback";
    find('[data-action="close"]').setAttribute("aria-label", draft ? "Cancel feedback" : "Close saved feedback");
    form.hidden = !draft;
    field.value = draft?.text || "";
    submit.disabled = !project || !field.value.trim();
    saved.disabled = !!draft || !project;
    saved.setAttribute("aria-expanded", String(showingList));
    list.hidden = !showingList;
    find(".scout-no-notes").hidden = !showingList || list.childElementCount > 0;
    if (draft) field.focus({ preventScroll: true });
  }
  function start(point) {
    if (!drafts.get(destination)?.text.trim()) drafts.set(destination, { point, text: "" });
    showingList = false;
    announce("");
    render();
  }
  function close() {
    drafts.delete(destination);
    showingList = false;
    announce("");
    render();
    prompt.focus({ preventScroll: true });
  }
  function setMode(next) {
    enabled = next;
    find('[data-action="browse"]').setAttribute("aria-pressed", String(!next));
    prompt.setAttribute("aria-pressed", String(next));
    prompt.querySelector("span").textContent = next ? "Click anywhere to leave feedback" : "Leave feedback";
    onModeChange?.(next);
    showingList = false;
    announce("");
    render();
  }
  function toggleList() {
    showingList = !showingList;
    list.replaceChildren();
    announce("");
    if (showingList) {
      try {
        for (const { point, text } of readSaved(key())) {
          const item = document.createElement("li");
          for (const [tag, value] of [["strong", point.label], ["small", position(point)], ["p", text]]) {
            const child = document.createElement(tag);
            child.textContent = value;
            item.append(child);
          }
          list.append(item);
        }
      } catch { showingList = false; announce("Couldn’t read feedback in this browser."); }
    }
    render();
    if (showingList) find('[data-action="close"]').focus({ preventScroll: true });
  }

  const listen = (node, type, fn) => node.addEventListener(type, fn, { signal: events.signal });
  listen(host, "click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "close") close();
    if (action === "browse") setMode(false);
    if (action === "saved") toggleList();
    if (action === "feedback") {
      if (enabled) start({ id: destination, label, space: "general" });
      else setMode(true);
    }
  });
  listen(host, "keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape" && !panel.hidden) close();
  });
  listen(field, "input", () => {
    drafts.get(destination).text = field.value;
    submit.disabled = !project || !field.value.trim();
  });
  listen(form, "submit", event => {
    event.preventDefault();
    const draft = drafts.get(destination);
    if (!project || !draft?.text.trim()) return;
    try {
      localStorage.setItem(key() + crypto.randomUUID(), JSON.stringify({ point: draft.point, text: draft.text.trim(), at: Date.now() }));
      close();
      announce("Saved in this browser");
    } catch { announce("Couldn’t save in this browser. Your draft is still here."); }
  });

  if (captureContent) {
    let down;
    listen(document, "pointerdown", event => { down = { x: event.clientX, y: event.clientY }; });
    listen(document, "click", event => {
      if (!enabled || event.defaultPrevented || !(event.target instanceof Element) || event.target.closest(interactive)) return;
      if (event.detail && down && Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 4) return;
      if (!window.getSelection()?.isCollapsed || host.contains(event.target)) return;
      const content = event.target.closest("[data-scout-content]");
      if (!content) return;
      const target = event.target.closest("[data-scout-point]") ?? content;
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const hasPosition = event.detail > 0 || event.clientX !== 0 || event.clientY !== 0;
      start({ id: target.dataset.scoutPoint || destination, label: target.dataset.scoutLabel || label, space: "fraction",
        x: hasPosition ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0.5,
        y: hasPosition ? Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) : 0.5 });
    });
  }
  render();
  return {
    start,
    setContext(next) {
      if (project === next.project && destination === next.destination && label === next.label) return;
      if (project && project !== next.project) drafts.clear();
      ({ project, destination, label } = next);
      showingList = false;
      announce("");
      render();
    },
    destroy() { events.abort(); clearTimeout(timer); host.replaceChildren(); },
  };
}

// Plain HTML and bundled apps use the same entry. React Studio mounts a controlled instance above its preview portal.
for (const host of globalThis.document?.querySelectorAll("[data-scout-tools]") || []) {
  mountWorkspaceTools(host, { product: host.dataset.scoutTools, label: host.dataset.scoutLabel });
}
