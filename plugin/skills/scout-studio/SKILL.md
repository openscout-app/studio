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

- Scout Studio reads Claude Code transcripts on this host, so the tools work in sessions that Claude Code runs (in a terminal, in T3 Code, or in another app that runs Claude Code). They run on macOS.
- `point` needs a screenshot first. With none, take one, then point.
