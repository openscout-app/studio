// Static servers expose only the browser files their page uses.
const assets = new Map([
  ["frame.js", "text/javascript"], ["logo.js", "text/javascript"],
  ["side-navigation.js", "text/javascript"], ["frame.css", "text/css"], ["input.css", "text/css"], ["tokens.css", "text/css"],
  ["feedback.js", "text/javascript"], ["feedback.css", "text/css"],
]);

export const browserFiles = Object.freeze([...assets.keys()]);

export function workspaceAsset(pathname, { feedback = false } = {}) {
  if (!pathname.startsWith("/scout-ui/")) return;
  const name = pathname.slice("/scout-ui/".length);
  const type = assets.get(name);
  if (!type || (!feedback && name.startsWith("feedback."))) return;
  return { url: new URL(name, import.meta.url), type: type + "; charset=utf-8" };
}
