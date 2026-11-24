---
name: scout-studio
description: Show the person a precise spot on a screenshot you took, instead of describing where to look. Use after you take a screenshot of a page or window and want the person to look at one control, row or area, or when they ask what you saw or which screens you took.
---

# Scout Studio

Scout Studio keeps the screenshots this session took. Its tools let you show them to the person.

- `screens` lists this session's screens, newest first, each with an id. In a host that draws MCP Apps (T3 Code, Claude, ChatGPT, VS Code) the person sees them as cards under the call.
- `point` marks one spot or area on a screen, with one or two sentences about it, and returns a link. Give x and y in pixels of the screenshot as you saw it, or fractions with `unit: "fraction"`; add w and h to mark an area. In a host that draws MCP Apps, the person sees the screen with the spot marked and can reply in the thread.
- `pointers` says whether the person opened each link, and what they replied.

## When to point

- You changed something visible and want it checked: point at the changed area and say what changed.
- You found a problem on a page: point at it and say what is wrong.
- The person asks where something is: point at it instead of describing its position.

Always give the person the link `point` returns, even when the host shows the view; the link opens the same spot in Scout Studio, where the reply goes back to this session.

## Notes

- On macOS, Studio finds screenshots in Claude Code and Codex transcripts. Other local agents can share a screenshot file.
- `point` needs a screenshot first. With none, take one, then point.

For a local screenshot from another host, call `share_screen` with its file path. Keep the returned handle in this conversation and pass it as `session` to later calls. Call `feedback` to read pins or answer one by note ID.
