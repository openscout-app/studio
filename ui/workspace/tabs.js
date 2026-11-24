import { createElement } from "react";

export function renderNavCenter({ items, activeKey, navigate, label = "Main navigation", className = "scout-nav-tabs", brandTag, breadcrumb }) {
  return createElement("nav", { className, "aria-label": label },
    brandTag && createElement("span", { className: "scout-nav-scope-tag" }, brandTag),
    items.map(({ key, label, route, href }) => {
      const selected = activeKey === key;
      const props = {
        key,
        className: selected ? "scout-nav-tab active" : "scout-nav-tab",
        "aria-current": selected ? "page" : undefined,
      };
      if (href === undefined) {
        return createElement("button", { ...props, type: "button", onClick: () => navigate(route) }, label);
      }
      return createElement("a", { ...props, href, onClick(event) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(route);
      } }, label);
    }),
    breadcrumb && createElement("span", { className: "scout-nav-slash", "aria-hidden": "true" }, "/"),
    breadcrumb && createElement("span", { className: "scout-nav-crumb" }, breadcrumb),
  );
}
