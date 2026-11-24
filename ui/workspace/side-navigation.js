// Use role="complementary" when the rail contains filters instead of destinations.
if (globalThis.customElements && !customElements.get("scout-side-nav")) {
  customElements.define("scout-side-nav", class extends HTMLElement {
    connectedCallback() {
      if (!this.hasAttribute("role")) this.setAttribute("role", "navigation");
    }
  });
}
