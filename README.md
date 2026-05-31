<div align="center">

# Stealth Notes

**The notebook that disappears when you share your screen.**

A private, local-first notes app with a Notion-style editor and a built-in AI that
organizes your notes for you — and a window the camera can't see.

</div>

---

## The problem

You take notes during the calls that matter most. The 1:1 where you jot what your
manager *actually* meant. The sales call where you track objections in real time. The
interview, the deal review, the standup where you keep your own running commentary.

Then someone says **"let me share my screen"** — and your private notes are one
`Alt-Tab` away from being on everyone's monitor. So you close them. And once they're
closed, you stop writing. The most useful notes you could take are the ones you're
too exposed to keep open.

Meanwhile the "AI notes" apps that promise to fix this want to upload everything you
write to their servers to do it.

## What this is

Stealth Notes keeps a real, rich notebook open **on top of your meeting**, fully
visible to you, and **invisible to screen capture** — Zoom, Google Meet, Teams, OBS,
even `PrintScreen`. To everyone on the call, that region of your screen is simply not
there. To you, it's just your notes.

It's built on Windows' own `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` —
the same OS-level capture exclusion that DRM video uses. Not a hack, not an overlay
trick. The compositor renders it to your display and omits it from every capture path.

And because the best note app is the one that organizes itself, there's an AI agent
living in the right rail that can read, write, restructure, and search your notebook
on command — running on the cheapest capable model, with everything stored on your
own machine.

## Why it's different

- **Private by the laws of physics, not a privacy policy.** Capture exclusion happens
  in the OS compositor. There's no setting for a meeting host to override.
- **Local-first, always.** Your notes live in a plain folder on your disk
  (`%APPDATA%/stealth-notes`). No account, no sync, no telemetry. The app works with
  the network unplugged. The only thing that ever leaves your machine is the specific
  request *you* send to the AI — and only if you've added your own API key.
- **The AI is a tool, not a tenant.** It edits your notes through a small, auditable
  set of actions and shows you every one. It uses a compact index of your workspace
  (not your full content) to stay cheap, and reads bodies only when it needs them.
- **Fast to think in.** Formatting hides until you select text. Folders nest like
  Notion. Nothing between you and the page.

## Philosophy

> Your screen is yours. Your notes are yours. The tools that help you with them
> shouldn't require giving either one away.

Three rules the app is built around:

1. **The user owns the surface.** What's on your screen is your decision, including
   what *isn't* shared. Software should make that easy, not negotiate it with a SaaS.
2. **Local until you say otherwise.** Defaults are offline. Going to the cloud is an
   explicit, per-message act with your own key — never the price of entry.
3. **AI you can watch work.** Every action is named and logged, reasoning is shown,
   memory is a file you can open and edit. No black box editing your thoughts.

## Features

**The notebook**
- Notion-style sidebar: nested folders & notes, drag-to-reorganize, inline rename,
  right-click and `+` menus.
- A floating formatting bar that appears only when you select text — fonts, sizes,
  text & highlight colors, headings, lists, checklists, quotes, code, links.
- Paste from anywhere and keep the structure. Autosave. Reopens your last note.
- A real app header with File / Edit / View menus, a breadcrumb, and one-click
  **Export** to Markdown, HTML, or plain text.

**The stealth**
- Toggle capture-invisibility from the header or with `Ctrl+Shift+H` — works even
  when the window isn't focused. A live green/red dot tells you the current state.

**The AI assistant** (`Ctrl+/`)
- Reads, writes, edits, **moves, deletes (to a recoverable Trash), and searches**
  your notes through clear tools — it can take a messy pile and file it into folders.
- **Full-text search** and batch reads so it investigates instead of guessing, and it
  knows which note you're currently viewing ("summarize this").
- **Two-layer memory, like Claude Code:** a *session* memory (the live chat) and a
  *long-term* memory it writes to across restarts — your preferences, conventions,
  recurring projects. It's a plain file you can view, edit, and clear.
- **Think-deeply mode (⚡):** opt in per message to escalate to a stronger model with
  extended reasoning for hard jobs; everything else stays on a cheap, fast model.
- Renders formatted answers, streams its actions, and has a **Stop** button.
- **Token-aware on purpose:** prompt caching, a compact workspace index, capped
  output, and a per-turn token readout so cost is never a surprise.

## Quickstart

```powershell
cd stealth-notes
npm install
npm start
```

Then open the assistant (**✦ Assistant** or `Ctrl+/`), hit **Settings**, and paste an
Anthropic API key (encrypted at rest via Windows DPAPI), or set `ANTHROPIC_API_KEY`.
The notebook itself needs no key and no network.

**Build a standalone installer:**

```powershell
npm run dist   # NSIS installer in dist/
```

## Stack

Electron · Quill (editor) · Anthropic SDK (agent, Haiku by default). One main process
that owns the files and the OS calls; a sandboxed renderer; a small IPC bridge between
them. No backend, because there's nowhere for your notes to go.

## Honest limits

Capture exclusion defeats *software* capture — it cannot stop a phone camera pointed
at your screen, or a hardware capture card on a mirrored output. Toggle the indicator
and confirm in a test call before you rely on it live. The AI is as good as the model
behind your key; deep mode costs more by design, which is why it's opt-in.

---

<div align="center">
<sub>Local-first. Private by default. Yours.</sub>
</div>
