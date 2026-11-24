import "./logo.js";

// The slot keeps product navigation and actions in the page's native tab order.
if (globalThis.customElements && !customElements.get("scout-app-frame")) {
  customElements.define("scout-app-frame", class extends HTMLElement {
    static observedAttributes = ["product"];
    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      this.brand = document.createElement("scout-logo");
      this.brand.setAttribute("part", "brand");
      const center = document.createElement("slot");
      center.name = "center";
      root.append(this.brand, document.createElement("slot"), center);
    }
    connectedCallback() {
      if (!this.hasAttribute("role")) this.setAttribute("role", "banner");
    }
    attributeChangedCallback(_name, _old, product) {
      this.brand.setAttribute("product", product || "");
    }
  });
}
