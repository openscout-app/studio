# Scout Canvas

What your agents make, on Scout's canvas. Pin a note on a screen, and Scout takes it to the session that made the screen.

Each repository is a frame, each Claude Code session is an area, and the screens a session took are cards, newest first. Open a screen to see it full size. When the session took the same view earlier, a wipe lays the before over the after. Click or right-click anywhere on a screen to pin a note there. Scout delivers the note into that session, and the session's answer shows beside the note as a thread.

## Run it

```sh
npx github:openscout-app/scout-canvas
```

That's all. It fetches Scout Canvas from this repository, builds it, and opens http://localhost:4801. `bunx github:openscout-app/scout-canvas` works too. Add `--no-open` to skip the browser, or `--port <n>` for another port. If Scout Canvas is already running, the command opens it. If something else holds the port, it takes the next free one.

To send notes into your sessions, and to give agents the Scout Canvas tools, set up once:

```sh
npx github:openscout-app/scout-canvas setup
```

Scout Canvas depends on [Scout](https://github.com/openscout-app/scout) (`@openscout/scout`) and brings its CLI along. `setup` starts Scout's runtime if it isn't up (`scout setup`), then registers the tools with Claude Code (see [Let agents point you at a screen](#let-agents-point-you-at-a-screen)). Scout's runtime runs on [Bun](https://bun.sh) 1.4.4 or newer; if Bun is missing, `setup` says how to get it. A Scout you installed yourself is used first.

You need macOS, Node 20 or newer, and Claude Code. Without Scout's runtime, the canvas still shows every session and screen; notes are kept and wait until Scout is up.

From a clone:

```sh
git clone https://github.com/openscout-app/scout-canvas.git
cd scout-canvas
npm install
npm run build
npm start          # or `npm run dev` for hot reload
```

You need:

- Node 20 or later, on macOS. Card thumbnails are made with `sips`.
- Scout running on this Mac. The canvas reads session titles from Scout's runtime at `127.0.0.1:43110` (`SCOUT_RUNTIME_URL` changes it).
- The `scout` command on your PATH (`SCOUT_BIN` changes it). Notes go out with `scout session send`.

## Where screens come from

The canvas reads Claude Code transcripts in `~/.claude/projects` written in the chosen window (today, 3 days, or a week). A screen is any image of at least 320 by 200 that a tool returned: a browser screenshot, a window screenshot, or an image file the session read. Subagents' screens belong to the session that started them. The images are copied out of the transcripts into `~/.scout-canvas/img`, so they outlive temporary files.

## Before and after

A screen has a before only when it shows the same thing as an earlier screen in the same session:

| Screen | Same thing means |
| --- | --- |
| Browser screenshot | The same page address, without the query |
| Window screenshot | The same window |
| Image file | The same name in the same folder, less a trailing number or `before`/`after` |

The two must also have about the same shape. A screen with no address, window, or file name has no before.

## Notes

A note goes out at once when its session is open. A closed session's note waits, and Scout tries again every 20 seconds. **Hand to a new session** gives the note to a new Claude session in the same repository (`scout ask --project`). A send that Scout refuses is retried six times, then stops until **Retry**.

The message carries a marker (`[scout-canvas:n_…]`). The canvas finds the marker in the session's transcript, which shows that the note arrived, and it shows what the session said after it.

Notes are kept in `~/.scout-canvas/notes.json` (`SCOUT_CANVAS_HOME` moves the folder). The server listens on 127.0.0.1 only and refuses requests from other sites, so no web page can send notes into your sessions.

## Let agents point you at a screen

An agent can show you one spot or area on a screenshot it took, with what it wants you to know about it. You get a short link. It opens that screen with the spot marked and the agent's words beside it. Your reply goes back to the session with the words it answers.

Set it up once:

```sh
npx github:openscout-app/scout-canvas setup
```

This gives every new Claude Code session three tools. The session already knows which session it is (Claude Code passes `CLAUDE_CODE_SESSION_ID` to its tools), so the agent never names one.

| Tool | What the agent gets |
| --- | --- |
| `screens` | Its recent screenshots, newest first: an id, the size in pixels, the page or file, and what it said around each. |
| `point` | A link such as `http://localhost:4801/p/p_f5e3a858fe`. The agent gives a screen id (or `latest`), a point `x, y` in pixels of the screenshot, or an area `x, y, w, h`, and `say`. |
| `pointers` | What it pointed at, whether you opened each, and your replies. |

If Scout Canvas isn't running, the first tool call starts it in the background.

A pointer keeps its screen as it was. The link opens the same screen at the same spot, even after the session takes more screens or the canvas folds screens of the same page together. Pointers are kept in `~/.scout-canvas/pointers.json`.

From a shell instead of a tool, an agent can run:

```sh
npx github:openscout-app/scout-canvas link --box 70,82,1000,80 --say "This header is the session you were on"
npx github:openscout-app/scout-canvas link --screen 7d89a329b6abd2ce --at 640,380 --say "…"
```

Coordinates are pixels of the screenshot. Add `--fraction` to give them as 0 to 1. `setup --print` shows the registration command instead of running it.

Scout Canvas also remembers where you were. When you open it again, the session you were looking at sits where you left it.

## Checks

```sh
npm test           # pairing, image sizes, prompt cleanup
npx tsc --noEmit
```

## License

Apache-2.0, as Scout is. See [LICENSE](LICENSE).
