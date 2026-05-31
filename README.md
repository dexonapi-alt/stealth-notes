<div align="center">

<img src="https://github.com/user-attachments/assets/d8caefba-e13e-4074-b455-28b06d8ca458" width="132" alt="Stealth Notes logo" />

# Stealth Notes

### The notebook that disappears when you share your screen.

A private, local-first notes app with a Notion-style editor and a built-in AI —
in a window the camera can't see.

[![Electron](https://img.shields.io/badge/Electron-2B2E3A?style=flat-square&logo=electron&logoColor=9FEAF9)](https://electronjs.org/)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Quill](https://img.shields.io/badge/Quill_Editor-1A1A1A?style=flat-square&logo=quilljs&logoColor=white)](https://quilljs.com/)
[![Claude](https://img.shields.io/badge/Claude-D97757?style=flat-square&logo=anthropic&logoColor=white)](https://www.anthropic.com/)
[![Windows](https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

</div>

---

## The problem

You take notes during the calls that matter most. The 1:1 where you jot what your
manager *actually* meant. The sales call where you track objections live. The
interview, the deal review, the standup where you keep your own running commentary.

Then someone says **"let me share my screen"** — and your private notes are one
`Alt-Tab` away from everyone's monitor. So you close them. And once they're closed,
you stop writing. The most useful notes you could take are the ones you're too
exposed to keep open.

Meanwhile the "AI notes" apps that promise to fix this want to upload everything you
write to do it.

## What it is

Stealth Notes keeps a real, rich notebook open **on top of your meeting** — fully
visible to you, **invisible to screen capture** (Zoom, Google Meet, Teams, OBS, even
`PrintScreen`). To everyone on the call, that region of your screen simply isn't
there. To you, it's just your notes.

It's built on Windows' own `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` —
the same OS-level capture exclusion that DRM video uses. Not an overlay trick: the
compositor renders it to your display and omits it from every capture path.

And because the best notebook is the one that organizes itself, an AI agent lives in
the right rail — it can read, write, edit, search, and restructure your notes on
command, runs on a cheap model by default, and keeps everything on your machine.

## Why it's different

- **Private by the laws of physics, not a privacy policy.** Capture exclusion happens
  in the OS compositor. No meeting host can override it.
- **Local-first, always.** Your notes live in a plain folder on your disk
  (`%APPDATA%/stealth-notes`). No account, no sync, no telemetry. Works offline. The
  only thing that ever leaves your machine is a request *you* send the AI — and only
  with your own API key.
- **The AI is a tool, not a tenant.** It acts through a small, auditable set of
  actions, shows every one, uses a compact index of your workspace (not your full
  content) to stay cheap, and reads bodies only when needed.
- **Fast to think in.** Formatting hides until you select text. Folders nest like
  Notion. Nothing between you and the page.

## Philosophy

> Your screen is yours. Your notes are yours. The tools that help you with them
> shouldn't require giving either one away.

1. **The user owns the surface.** What's on your screen — including what *isn't*
   shared — is your call. Software should make that easy, not negotiate it.
2. **Local until you say otherwise.** Defaults are offline. The cloud is an explicit,
   per-message act with your own key, never the price of entry.
3. **AI you can watch work.** Every action is named and logged, reasoning is shown,
   memory is a file you can open and edit. No black box editing your thoughts.

## Features

**The notebook**
- Notion-style sidebar: nested folders & notes, drag-to-reorganize, inline rename,
  editor **tabs** (drag to reorder), a frameless custom header with File / Edit / View
  menus, and a **theme selector**.
- A floating formatting bar that appears only on text selection — fonts, sizes, text
  & highlight colors, headings, lists, checklists, quotes, **code blocks**, links,
  plus **block-level highlights** and editable, colorable **tables**.
- **Export** to Markdown / HTML / plain text, and **import** PDF or Word (`.docx`) via
  drag-and-drop — Word keeps headings, lists, links, and table cell colors.

**The stealth**
- Toggle capture-invisibility from the header or `Ctrl+Shift+H` (works unfocused).
- **Compact pill** mode (`Ctrl+Shift+M`): shrink to a tiny draggable, always-on-top
  pill pinned over your call — still hidden from capture.
- **Invisible overlay theme** with an opacity slider — read your notes as a frosted
  HUD floating over the meeting.
- Runs **off the taskbar** with a system-tray icon, so it stays discreet.

**The AI assistant** (`Ctrl+/`)
- Reads, writes, edits, **moves, deletes (to a recoverable Trash), and searches** your
  notes through clear tools — turn a messy pile into filed folders.
- **Two-layer memory** like Claude Code: a session memory (the live chat) and a
  persistent long-term memory it maintains across restarts (a file you can edit).
- **Think-deeply mode (⚡):** opt in per message to escalate to a stronger model with
  extended reasoning; everything else stays cheap and fast.
- Formatted answers, streamed actions, a **Stop** button, and a per-turn token readout.

## Quickstart

```bash
git clone https://github.com/dexonapi-alt/stealth-notes.git
cd stealth-notes
npm install
npm start
```

Open the assistant (**✦ Assistant** / `Ctrl+/`), hit **Settings**, and paste an
Anthropic API key (encrypted at rest via Windows DPAPI), or set `ANTHROPIC_API_KEY`.
The notebook itself needs no key and no network.

**Build a standalone installer:**

```bash
npm run dist   # NSIS installer in dist/
```

## Tech

Electron · vanilla JavaScript · [Quill](https://quilljs.com/) (editor) ·
[Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) (Claude, Haiku
by default) · [pdf.js](https://mozilla.github.io/pdf.js/) (PDF import) ·
[mammoth](https://github.com/mwilliamson/mammoth.js) (`.docx` import). One main process
owns the files and the OS calls; a sandboxed renderer; a small IPC bridge between them.
No backend, because there's nowhere for your notes to go.

## Honest limits

Capture exclusion defeats *software* capture — it can't stop a phone camera pointed at
your screen or a hardware capture card on a mirrored output. Toggle the indicator and
confirm in a test call before relying on it live. The AI is as good as the model behind
your key; deep mode costs more by design, which is why it's opt-in. PDF import extracts
text & headings (PDFs don't carry semantic tables/colors); `.docx` is far higher
fidelity.

---

<div align="center">
<sub>Local-first. Private by default. Yours.</sub>
</div>
