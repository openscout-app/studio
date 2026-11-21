# Scout Canvas

What your agents make, on Scout's canvas. Pin a note on a screen, and Scout takes it to the session that made the screen.

Each repository is a frame, each Claude Code session is an area, and the screens a session took are cards, newest first. Open a screen to see it full size. When the session took the same view earlier, a wipe lays the before over the after. Click or right-click anywhere on a screen to pin a note there. Scout delivers the note into that session, and the session's answer shows beside the note as a thread.

## Run it

```sh
npm install
npm run build
npm start          # http://localhost:4801; add -- --no-open to skip the browser
```

For development, `npm run dev` serves the app with hot reload on the same port.

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

## Checks

```sh
npm test           # pairing, image sizes, prompt cleanup
npx tsc --noEmit
```
