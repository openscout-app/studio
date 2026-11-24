# Scout workspace UI

Standalone Scout pages share the application frame, official wordmark and navigation. Use `<scout-app-shell>` (or `ScoutShell`) to lay out a stable header and a content region. The content can contain a navigation rail, a document or a canvas. Components can also be used independently.

| Import | Use |
| --- | --- |
| `/tokens.css` | Scout’s shared spacing, radii, type scale and mixed voice. Body and metadata use the system sans and mono at weight 300. Labels preserve their written case and the regular pane-title weight is 400. |
| `/frame` and `/frame.css` | Register `<scout-app-frame product="Studio">`. Put native controls or navigation in its default slot. Use `slot="center"` for a centered search field that wraps on small screens. |
| `/logo` and `/frame.css` | Use `<scout-logo>` on its own, optionally with a product name. |
| `/side-navigation` and `/frame.css` | Use `<scout-side-nav aria-label="Rooms">` for a scrollable rail. Use `scout-nav-item` on native links, buttons or radio labels for shared hover, focus and selection styles. Filters use `role="complementary"`. |
| `/react` | React bindings for the frame, logo and side navigation. |
| `/input` | `ScoutInput` exposes HudsonKit’s input, including its ref and native input props. Load HudsonKit’s theme and styles in the app. Import `/input.css` for the shared native field style, available to plain HTML inputs via `class="scout-input"`. |
| `/tabs` and `/tabs.css` | `renderNavCenter` renders links or buttons for the product’s destinations. |
| `/feedback` and `/feedback.css` | Mount workspace feedback explicitly or add a host with `data-scout-tools="product"` and mark the content with `data-scout-content`. Notes stay in the browser. |
| `/assets` | `workspaceAsset(pathname, { feedback })` resolves allowlisted files for servers that deliver HTML without a bundler. |

Import subpaths from `@openscout/workspace-ui`. Plain HTML pages can serve the browser modules from `/scout-ui/` and use native links and form controls without React. The frame has no feedback dependency.

This directory owns the components. To update standalone apps, bump the kit version, run `npm pack` in this directory and install that same package archive in each consuming repository. Apps can build using the archive offline.

For a server that must run without installing packages, run `node pack-static.mjs <output.mjs>`. The generated module serves the same browser files by path and has no runtime dependencies.
