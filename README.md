# Stealth Notes

A private, Notion-style notes app that stays **invisible during screen sharing**
(Zoom, Google Meet, Microsoft Teams, OBS, even PrintScreen) while remaining fully
visible on your own monitor.

## How the "invisible during screen share" works

The app calls Electron's `win.setContentProtection(true)`, which on Windows 10
version 2004+ maps directly to the Win32 call you asked for:

```
SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
```

The window keeps rendering on your physical display, but the compositor excludes
it from any capture API — so meeting/recording software sees a blank region where
the window is. No native addon is required; Electron performs the call for us.

> Verified support: this machine is Windows 11 build 26200, well past the 2004
> minimum, so capture exclusion is active.

## Design

The UI follows the **Notion** design language (tokens sourced from
[awesome-design-md](https://github.com/VoltAgent/awesome-design-md)): a true-white
canvas (`#ffffff`), warm-gray sidebar (`#f7f7f5`), warm-charcoal text (`#37352f`),
hairline dividers, 8px buttons / 12px popups, and 150–200ms easing. The only
"glassy" surfaces are the floating popups (formatting bar, menus), which use a
frosted blur for depth.

## Features

- **Floating formatting bar** — nothing clutters the page; **select any text** and a
  Notion-style bar floats up with fonts, sizes, text/highlight colors, headings,
  bold/italic/underline/strike, lists & checklist, quote, code, and links.
- **Notion-style sidebar** — nested folders & notes; create via the **`+` button →
  popup**, or the per-row **`+` / `⋯`** hover actions; drag-and-drop to reorganize,
  collapsible folders, double-click to rename.
- **Fonts** (Sans, Serif, Mono, Georgia, Tahoma, Comic), **sizes** 12 → 40px,
  **text & highlight color** pickers.
- **Smart paste** — pasting from a webpage / Word keeps structure and lays out cleanly.
- **Reopens your last note** on launch; **autosaves** notes and structure.
- **Micro-interactions** — spring-y popups, animated disclosure arrows, fade-up on
  note switch, pulsing capture indicator, tactile button presses.
- **Local & private** — stored under `%APPDATA%/stealth-notes`; notes never leave the machine.

## AI assistant (right panel)

A built-in agent (Cursor/Notion-style) that can **read, write, edit, and organize your
notes** by calling tools — and narrates its reasoning + an action log as it works.

- **Tools:** `list_workspace`, `read_note`, `create_note`, `edit_note`, `create_folder`,
  `rename_item` — all scoped to your notes (never the OS filesystem). Bodies are written/read
  as Markdown and converted to/from the rich editor format.
- **Token-efficient by design:** defaults to **Claude Haiku 4.5** (cheapest), uses **prompt
  caching** on the system prompt + tool definitions, sends only a **compact tree** (names + ids,
  no bodies) and reads note contents on demand, caps `max_tokens`, and keeps replies short.
  Each turn reports `tokens in / out (+ cached)` so you can see the cost.
- **Formatted replies:** the assistant's answers render Markdown (headings, **bold**, lists,
  `code`, quotes, links that open in your browser); HTML is escaped for safety.
- **Live sync:** when the agent creates/edits, the sidebar and open note update instantly.

### Memory (two layers, like Claude Code)
- **Session memory** — the running chat. The agent remembers everything within the session and
  can compare/reference earlier turns. **Clear chat** resets only this.
- **Long-term memory** — durable facts about you and your work, stored in
  `%APPDATA%/stealth-notes/memory.json` and injected into the agent every turn (so it persists
  across restarts). The agent writes to it with the `remember` / `forget` tools (e.g. it learns
  your naming conventions or recurring projects). Manage it yourself via the **🧠 button** in the
  panel header — view, add, delete, or clear all facts. Capped at 60 facts to stay cheap on tokens.

### Setup
Open the panel (**✦ Assistant**, or `Ctrl+/`), click the **gear**, paste your
**Anthropic API key**, and Save. The key is encrypted at rest via Windows DPAPI
(`safeStorage`). Alternatively set the `ANTHROPIC_API_KEY` environment variable.
Change the model in the same settings box.

Examples: *“Make a folder ‘Trips’ with a packing-list note.”* ·
*“Summarize my Welcome note into 3 bullets at the top.”* · *“Create a daily-standup template.”*

## Controls

| Action | Shortcut |
|---|---|
| Toggle capture invisibility | `Ctrl+Shift+H` (works even when unfocused) |
| New note | `Ctrl+N` |
| Toggle AI assistant | `Ctrl+/` |
| Format text | Select text → floating bar appears |
| Create note/folder | `+` in the sidebar header → popup |
| Rename item | Double-click the row (or `⋯` → Rename) |
| Reorganize | Drag a row onto a folder (drops inside) or onto a note (drops after) |

The indicator at the bottom-left shows the current state:
🟢 **Hidden from capture** / 🔴 **Visible to capture**.

## Run

```powershell
cd C:\Users\DevAPI\stealth-notes
npm install
npm start
```

## Build a standalone installer (optional)

```powershell
npm run dist
```

Produces an NSIS installer under `dist/`.

## Notes & caveats

- Capture exclusion relies on the OS compositor. Hardware-level capture (a phone
  camera pointed at the screen, or a capture card on a mirrored output) is outside
  any software's control.
- If a participant uses very old capture software that ignores display affinity,
  toggle the indicator to confirm behavior before relying on it in a live meeting.
