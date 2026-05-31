// Simple, token-efficient notes agent.
// - Anthropic SDK tool-use loop (Haiku by default)
// - prompt caching on the static system prompt + tools
// - compact workspace context (names + ids, no bodies); bodies read on demand
// - narrates reasoning as plain text + an action log

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const AnthropicPkg = require('@anthropic-ai/sdk');
const Anthropic = AnthropicPkg.default || AnthropicPkg;
const { mdToDelta, deltaToMarkdown } = require('./notes-md');

let cfg = null;          // { TREE_FILE, CONTENT_DIR, SETTINGS_FILE, MEMORY_FILE, getWin }
let conversation = [];   // running message history
let running = false;
let cancelRequested = false;
let aborter = null;
let uiContext = {};      // { openNoteId, openNoteName } — what the user is viewing

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_DEEP_MODEL = 'claude-sonnet-4-6';
const TRASH_ID = 'sys-trash';

const SYSTEM = `You are the built-in assistant for "Stealth Notes", a local notes app.
You help the user manage a workspace of folders and notes by calling tools.

Your capabilities (these tools are ALL you can do — never claim others):
- See/search: list_workspace, search_notes (full-text), read_note, read_notes (batch).
- Write: create_note, edit_note (replace|append).
- Structure: create_folder, move_item (into a folder or to root), rename_item, delete_item (moves to Trash).
- Memory: remember, forget.
You cannot run code, browse the web, or touch files outside this notes workspace.

How to work:
- Investigate first. For anything about existing content, use search_notes to find relevant notes, then read them — don't guess and don't read every note blindly.
- Plan briefly for multi-step jobs: state a 1-line plan, then execute with tools.
- Structuring requests ("organize", "group", "clean up"): inspect the tree, decide a folder scheme, create_folder as needed, then move_item existing notes in. Don't recreate notes that already exist — move them.
- After a structural change (moves/deletes/multi-create), verify with list_workspace before finishing.
- Note bodies are Markdown (#/##/### headings, **bold**, *italic*, lists, > quotes, \`code\`, [links](url)). Write clean Markdown.
- Prefer the fewest tool calls that work. Don't re-read what you just wrote.
- If a tool returns an error, adapt — fix the input or change approach; do NOT repeat the same failing call.
- If the request is genuinely ambiguous or destructive at scale, ask one short clarifying question instead of guessing. Otherwise proceed.
- Keep final replies to 1-3 sentences and name what you changed. Don't paste whole note bodies back unless asked.

Context: a "Currently viewing" note may be provided below — resolve words like "this note" / "here" to it.

Memory:
- You have LONG-TERM memory that persists across sessions (below). The current chat is this SESSION's memory.
- Use remember for durable, reusable facts (preferences, recurring projects, naming conventions, who they are) — one short sentence each.
- Do NOT remember trivia, one-off requests, or secrets. Use forget to remove outdated facts. Apply what you remember automatically.`;

const TOOLS = [
  { name: 'list_workspace', description: 'List every folder and note (type, name, id, nesting, folder child counts). No bodies.', input_schema: { type: 'object', properties: {} } },
  { name: 'search_notes', description: 'Full-text search note titles and bodies. Returns matching note ids + snippets. Use this to find relevant notes before reading.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_note', description: 'Read one note body as Markdown.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'note id' } }, required: ['id'] } },
  { name: 'read_notes', description: 'Read several note bodies at once (Markdown). More efficient than many read_note calls.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
  { name: 'create_note', description: 'Create a note. Optionally inside a folder (parent_folder_id).', input_schema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string', description: 'Markdown body (optional)' }, parent_folder_id: { type: 'string' } }, required: ['name'] } },
  { name: 'edit_note', description: 'Replace or append a note body (Markdown).', input_schema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'append'], description: 'default replace' } }, required: ['id', 'content'] } },
  { name: 'create_folder', description: 'Create a folder. Optionally inside another folder (parent_folder_id).', input_schema: { type: 'object', properties: { name: { type: 'string' }, parent_folder_id: { type: 'string' } }, required: ['name'] } },
  { name: 'move_item', description: 'Move an existing note or folder into a folder, or to the top level. Use this to reorganize — do not recreate items.', input_schema: { type: 'object', properties: { id: { type: 'string' }, parent_folder_id: { type: 'string', description: 'target folder id; omit or null = top level' } }, required: ['id'] } },
  { name: 'rename_item', description: 'Rename a note or folder by id.', input_schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } },
  { name: 'delete_item', description: 'Delete a note or folder. It is moved to a Trash folder (recoverable). Deleting something already in Trash removes it permanently.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'remember', description: 'Save one durable fact about the user/their work to long-term memory (persists across sessions). Use sparingly.', input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'forget', description: 'Remove long-term memory facts containing the given substring.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }
];

// ---- tiny fs helpers (operate on the same files the renderer uses) ----
function readTree() {
  try { return JSON.parse(fs.readFileSync(cfg.TREE_FILE, 'utf8')); } catch { return { tree: [] }; }
}
function writeTree(d) { fs.writeFileSync(cfg.TREE_FILE, JSON.stringify(d, null, 2)); }
function noteFile(id) { return path.join(cfg.CONTENT_DIR, String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.json'); }
function readNote(id) { try { return JSON.parse(fs.readFileSync(noteFile(id), 'utf8')); } catch { return null; } }
function writeNote(id, delta) { fs.writeFileSync(noteFile(id), JSON.stringify(delta)); }
function uid() { return 'a-' + Math.abs(Math.floor(Date.now() + Math.random() * 1e6)).toString(36); }

function locate(id, list) {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.id === id) return { node: n, list, index: i };
    if (n.children) { const f = locate(id, n.children); if (f) return f; }
  }
  return null;
}
function compactTree() {
  const t = readTree().tree || [];
  const lines = [];
  const walk = (list, depth) => {
    for (const n of list) {
      const meta = n.type === 'folder' ? ` [${(n.children || []).length} items]` : '';
      lines.push('  '.repeat(depth) + (n.type === 'folder' ? '📁' : '📄') + ` "${n.name}" {id:${n.id}}${meta}`);
      if (n.children) walk(n.children, depth + 1);
    }
  };
  walk(t, 0);
  return lines.join('\n') || '(empty — no notes yet)';
}
function isDescendant(node, id) {
  if (!node || !node.children) return false;
  for (const c of node.children) { if (c.id === id) return true; if (isDescendant(c, id)) return true; }
  return false;
}
function collectNoteIds(node, acc) {
  if (node.type === 'note') acc.push(node.id);
  else if (node.children) node.children.forEach((c) => collectNoteIds(c, acc));
  return acc;
}
function ensureTrash(data) {
  let t = data.tree.find((n) => n.id === TRASH_ID);
  if (!t) { t = { id: TRASH_ID, type: 'folder', name: '🗑 Trash', expanded: false, children: [] }; data.tree.push(t); }
  return t;
}
function inTrash(id, data) {
  const t = data.tree.find((n) => n.id === TRASH_ID);
  return !!t && (id === TRASH_ID || isDescendant(t, id));
}
function noteText(id) {
  const md = deltaToMarkdown(readNote(id) || { ops: [] });
  return (md || '').trim();
}
function allNotes(list, acc) {
  for (const n of list) {
    if (n.type === 'note') acc.push(n);
    else if (n.children) allNotes(n.children, acc);
  }
  return acc;
}

// ---- long-term memory ----
function loadMemory() {
  try { const m = JSON.parse(fs.readFileSync(cfg.MEMORY_FILE, 'utf8')); return Array.isArray(m.facts) ? m.facts : []; }
  catch { return []; }
}
function saveMemory(facts) { fs.writeFileSync(cfg.MEMORY_FILE, JSON.stringify({ facts }, null, 2)); }
function memoryText() {
  const f = loadMemory();
  return f.length ? f.map((x) => '- ' + x.text).join('\n') : '(nothing remembered yet)';
}
function memChanged() { const w = cfg.getWin && cfg.getWin(); if (w && !w.isDestroyed()) w.webContents.send('memory:changed'); }

// ---- settings ----
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(cfg.SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(s) { fs.writeFileSync(cfg.SETTINGS_FILE, JSON.stringify(s, null, 2)); }
function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const s = loadSettings();
  if (s.apiKeyEnc) {
    try { return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')); } catch { return null; }
  }
  return s.apiKeyPlain || null; // fallback if OS encryption unavailable
}
function getModel() { return loadSettings().model || DEFAULT_MODEL; }
function getDeepModel() { return loadSettings().deepModel || DEFAULT_DEEP_MODEL; }

// ---- tool execution ----
function execTool(name, input) {
  input = input || {};
  try {
    if (name === 'list_workspace') return { content: compactTree() };

    if (name === 'search_notes') {
      const q = String(input.query || '').toLowerCase().trim();
      if (!q) return { content: 'Error: empty query' };
      const notes = allNotes(readTree().tree, []);
      const hits = [];
      for (const n of notes) {
        const name = (n.name || '').toLowerCase();
        const text = noteText(n.id);
        const lc = text.toLowerCase();
        const inName = name.includes(q);
        const idx = lc.indexOf(q);
        if (!inName && idx < 0) continue;
        let snippet = '';
        if (idx >= 0) { const s = Math.max(0, idx - 40); snippet = (s > 0 ? '…' : '') + text.slice(s, idx + q.length + 40).replace(/\n/g, ' ') + '…'; }
        hits.push(`{id:${n.id}} "${n.name}"${snippet ? ' — ' + snippet : ' (title match)'}`);
        if (hits.length >= 12) break;
      }
      return { content: hits.length ? hits.join('\n') : 'No matches.', summary: `Searched “${input.query}” (${hits.length} hit${hits.length === 1 ? '' : 's'})` };
    }

    if (name === 'read_note') {
      const f = locate(input.id, readTree().tree);
      if (!f || f.node.type !== 'note') return { content: 'Error: note not found' };
      return { content: deltaToMarkdown(readNote(input.id) || { ops: [] }) || '(empty)', summary: `Read “${f.node.name}”` };
    }

    if (name === 'read_notes') {
      const ids = Array.isArray(input.ids) ? input.ids.slice(0, 20) : [];
      const tree = readTree().tree;
      const parts = ids.map((id) => {
        const f = locate(id, tree);
        if (!f || f.node.type !== 'note') return `### (id:${id}) — not found`;
        return `### ${f.node.name} {id:${id}}\n${noteText(id) || '(empty)'}`;
      });
      return { content: parts.join('\n\n---\n\n') || 'No notes.', summary: `Read ${ids.length} note(s)` };
    }

    if (name === 'create_note') {
      const data = readTree();
      const node = { id: uid(), type: 'note', name: input.name || 'Untitled' };
      const parent = input.parent_folder_id ? locate(input.parent_folder_id, data.tree) : null;
      if (parent && parent.node.type === 'folder') { parent.node.children = parent.node.children || []; parent.node.children.push(node); parent.node.expanded = true; }
      else data.tree.push(node);
      writeTree(data);
      writeNote(node.id, mdToDelta(input.content || ''));
      return { content: `Created note "${node.name}" (id:${node.id})`, summary: `Created note “${node.name}”`, changed: true };
    }

    if (name === 'edit_note') {
      const data = readTree();
      const f = locate(input.id, data.tree);
      if (!f || f.node.type !== 'note') return { content: 'Error: note not found' };
      let delta = mdToDelta(input.content || '');
      if (input.mode === 'append') {
        const cur = readNote(input.id) || { ops: [{ insert: '\n' }] };
        delta = { ops: [...(cur.ops || []), ...delta.ops] };
      }
      writeNote(input.id, delta);
      return { content: `Updated note "${f.node.name}" (${input.mode === 'append' ? 'appended' : 'replaced'})`, summary: `Edited “${f.node.name}”`, changed: true };
    }

    if (name === 'create_folder') {
      const data = readTree();
      const node = { id: uid(), type: 'folder', name: input.name || 'Folder', expanded: true, children: [] };
      const parent = input.parent_folder_id ? locate(input.parent_folder_id, data.tree) : null;
      if (parent && parent.node.type === 'folder') { parent.node.children = parent.node.children || []; parent.node.children.push(node); parent.node.expanded = true; }
      else data.tree.push(node);
      writeTree(data);
      return { content: `Created folder "${node.name}" (id:${node.id})`, summary: `Created folder “${node.name}”`, changed: true };
    }

    if (name === 'move_item') {
      const data = readTree();
      const f = locate(input.id, data.tree);
      if (!f) return { content: 'Error: item not found' };
      const targetId = input.parent_folder_id || null;
      if (targetId === input.id) return { content: 'Error: cannot move an item into itself' };
      if (targetId && isDescendant(f.node, targetId)) return { content: 'Error: cannot move a folder into its own descendant' };
      let target = null;
      if (targetId) {
        target = locate(targetId, data.tree);
        if (!target || target.node.type !== 'folder') return { content: 'Error: target folder not found' };
      }
      f.list.splice(f.index, 1);
      if (target) { target.node.children = target.node.children || []; target.node.children.push(f.node); target.node.expanded = true; }
      else data.tree.push(f.node);
      writeTree(data);
      return { content: `Moved "${f.node.name}" to ${target ? '"' + target.node.name + '"' : 'top level'}`, summary: `Moved “${f.node.name}” → ${target ? target.node.name : 'top level'}`, changed: true };
    }

    if (name === 'rename_item') {
      const data = readTree();
      const f = locate(input.id, data.tree);
      if (!f) return { content: 'Error: item not found' };
      const old = f.node.name; f.node.name = input.name || old;
      writeTree(data);
      return { content: `Renamed "${old}" → "${f.node.name}"`, summary: `Renamed to “${f.node.name}”`, changed: true };
    }

    if (name === 'delete_item') {
      const data = readTree();
      const f = locate(input.id, data.tree);
      if (!f) return { content: 'Error: item not found' };
      if (input.id === TRASH_ID) return { content: 'Error: cannot delete the Trash folder' };
      const name2 = f.node.name;
      if (inTrash(input.id, data)) {
        // permanent delete
        f.list.splice(f.index, 1);
        collectNoteIds(f.node, []).forEach((nid) => { try { fs.unlinkSync(noteFile(nid)); } catch {} });
        writeTree(data);
        return { content: `Permanently deleted "${name2}"`, summary: `Deleted “${name2}” permanently`, changed: true };
      }
      const trash = ensureTrash(data);
      const fresh = locate(input.id, data.tree); // re-locate (ensureTrash may have mutated tree)
      fresh.list.splice(fresh.index, 1);
      trash.children.push(fresh.node);
      writeTree(data);
      return { content: `Moved "${name2}" to Trash (recoverable)`, summary: `Deleted “${name2}” → Trash`, changed: true };
    }

    if (name === 'remember') {
      const text = String(input.fact || '').trim();
      if (!text) return { content: 'Error: empty fact' };
      const facts = loadMemory();
      if (facts.some((x) => x.text.toLowerCase() === text.toLowerCase())) return { content: 'Already remembered.' };
      facts.push({ text, ts: Date.now() });
      while (facts.length > 60) facts.shift();
      saveMemory(facts);
      return { content: 'Saved to long-term memory: ' + text, summary: '🧠 Remembered: ' + (text.length > 48 ? text.slice(0, 48) + '…' : text), memChanged: true };
    }

    if (name === 'forget') {
      const q = String(input.query || '').toLowerCase();
      let facts = loadMemory();
      const before = facts.length;
      facts = facts.filter((x) => !x.text.toLowerCase().includes(q));
      saveMemory(facts);
      const n = before - facts.length;
      return { content: `Removed ${n} fact(s).`, summary: `🧠 Forgot ${n} fact(s)`, memChanged: n > 0 };
    }
  } catch (err) {
    return { content: 'Error: ' + String(err && err.message || err) };
  }
  return { content: 'Error: unknown tool ' + name };
}

// ---- the loop ----
function emit(msg) { const w = cfg.getWin && cfg.getWin(); if (w && !w.isDestroyed()) w.webContents.send('ai:update', msg); }

async function run(userText, opts) {
  if (running) return;
  opts = opts || {};
  const apiKey = getApiKey();
  if (!apiKey) { emit({ type: 'error', text: 'No API key set. Open the assistant settings (gear) and paste your Anthropic API key.' }); return; }

  running = true;
  cancelRequested = false;
  aborter = new AbortController();
  const deep = !!opts.deep;
  emit({ type: 'thinking', deep });

  const client = new Anthropic({ apiKey });
  const model = deep ? getDeepModel() : getModel();
  const maxTokens = deep ? 4096 : 1024;

  conversation.push({ role: 'user', content: userText });

  let usageIn = 0, usageOut = 0, cacheRead = 0, changedAny = false;
  try {
    for (let step = 0; step < 16; step++) {
      if (cancelRequested) { emit({ type: 'action', text: '■ Stopped' }); break; }

      const ctxLine = uiContext && uiContext.openNoteId
        ? `Currently viewing note: "${uiContext.openNoteName}" {id:${uiContext.openNoteId}}\n\n` : '';

      const params = {
        model,
        max_tokens: maxTokens,
        system: [
          { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: ctxLine + 'Long-term memory (persists across sessions):\n' + memoryText() + '\n\nCurrent workspace:\n' + compactTree() }
        ],
        tools: TOOLS.map((t, i) => i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t),
        messages: conversation
      };
      if (deep) params.thinking = { type: 'enabled', budget_tokens: 2048 };

      const resp = await client.messages.create(params, { signal: aborter.signal });

      const u = resp.usage || {};
      usageIn += u.input_tokens || 0;
      usageOut += u.output_tokens || 0;
      cacheRead += u.cache_read_input_tokens || 0;

      const texts = [];
      const toolResults = [];
      let hadTool = false;
      for (const block of resp.content) {
        if (block.type === 'thinking' && block.thinking && block.thinking.trim()) emit({ type: 'thinking-text', text: block.thinking.trim() });
        else if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim());
        else if (block.type === 'tool_use') {
          hadTool = true;
          const r = execTool(block.name, block.input);
          if (r.changed) changedAny = true;
          if (r.memChanged) memChanged();
          emit({ type: 'action', text: r.summary || (block.name + ' done') });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: r.content });
        }
      }

      conversation.push({ role: 'assistant', content: resp.content });
      texts.forEach((t) => emit({ type: hadTool ? 'reasoning' : 'answer', text: t }));

      if (changedAny) { const w = cfg.getWin && cfg.getWin(); if (w && !w.isDestroyed()) w.webContents.send('workspace:changed'); }

      if (!hadTool) break;
      conversation.push({ role: 'user', content: toolResults });
    }
    emit({ type: 'done', usage: { input: usageIn, output: usageOut, cached: cacheRead } });
  } catch (err) {
    const m = (err && err.message) ? err.message : String(err);
    if (cancelRequested || (err && (err.name === 'APIUserAbortError' || /abort/i.test(m)))) {
      emit({ type: 'action', text: '■ Stopped' });
      emit({ type: 'done', usage: { input: usageIn, output: usageOut, cached: cacheRead } });
    } else {
      emit({ type: 'error', text: m });
    }
  } finally {
    running = false;
    aborter = null;
  }
}

// ---- IPC registration ----
function init(config, ipcMain) {
  cfg = config;
  ipcMain.handle('ai:send', (_e, payload) => {
    const text = typeof payload === 'string' ? payload : (payload && payload.text);
    const opts = (payload && payload.opts) || {};
    run(String(text || '').trim(), opts);
    return true;
  });
  ipcMain.handle('ai:stop', () => { cancelRequested = true; if (aborter) { try { aborter.abort(); } catch {} } return true; });
  ipcMain.handle('ai:context', (_e, ctx) => { uiContext = ctx || {}; return true; });
  ipcMain.handle('ai:clear', () => { conversation = []; return true; });
  ipcMain.handle('memory:get', () => loadMemory());
  ipcMain.handle('memory:add', (_e, text) => {
    const t = String(text || '').trim(); if (!t) return loadMemory();
    const facts = loadMemory();
    if (!facts.some((x) => x.text.toLowerCase() === t.toLowerCase())) facts.push({ text: t, ts: Date.now() });
    while (facts.length > 60) facts.shift();
    saveMemory(facts); return facts;
  });
  ipcMain.handle('memory:delete', (_e, index) => {
    const facts = loadMemory();
    if (index >= 0 && index < facts.length) facts.splice(index, 1);
    saveMemory(facts); return facts;
  });
  ipcMain.handle('memory:clear', () => { saveMemory([]); return []; });
  ipcMain.handle('ai:getSettings', () => {
    const s = loadSettings();
    return { hasKey: !!getApiKey(), fromEnv: !!process.env.ANTHROPIC_API_KEY, model: s.model || DEFAULT_MODEL, deepModel: s.deepModel || DEFAULT_DEEP_MODEL };
  });
  ipcMain.handle('ai:setSettings', (_e, { apiKey, model, deepModel }) => {
    const s = loadSettings();
    if (typeof model === 'string' && model.trim()) s.model = model.trim();
    if (typeof deepModel === 'string' && deepModel.trim()) s.deepModel = deepModel.trim();
    if (typeof apiKey === 'string' && apiKey.trim()) {
      delete s.apiKeyPlain;
      try { s.apiKeyEnc = safeStorage.encryptString(apiKey.trim()).toString('base64'); }
      catch { s.apiKeyPlain = apiKey.trim(); } // OS encryption unavailable
    }
    saveSettings(s);
    return { hasKey: !!getApiKey(), model: s.model || DEFAULT_MODEL, deepModel: s.deepModel || DEFAULT_DEEP_MODEL };
  });
}

module.exports = { init, _test: { setCfg: (c) => { cfg = c; }, execTool } };
