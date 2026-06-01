/* global Quill, api */

// ---------------------------------------------------------------------------
// Editor formats
// ---------------------------------------------------------------------------
const Font = Quill.import('formats/font');
Font.whitelist = ['sans', 'serif', 'mono', 'georgia', 'tahoma', 'comic'];
Quill.register(Font, true);

const Size = Quill.import('attributors/style/size');
Size.whitelist = ['12px', '14px', '16px', '18px', '20px', '24px', '32px', '40px'];
Quill.register(Size, true);

// Block embed that renders raw HTML (used to keep imported tables intact) —
// Quill has no native table, so we preserve the table's HTML as one block.
const BlockEmbed = Quill.import('blots/block/embed');
class HtmlBlock extends BlockEmbed {
  static create(value) {
    const node = super.create();
    node.innerHTML = value || '';
    node.querySelectorAll('script').forEach((s) => s.remove());
    node.setAttribute('contenteditable', 'false');
    return node;
  }
  static value(node) { return node.innerHTML; }
}
HtmlBlock.blotName = 'htmlblock';
HtmlBlock.tagName = 'div';
HtmlBlock.className = 'ql-htmlblock';
Quill.register(HtmlBlock);

// Block-level highlight (colors the whole line/paragraph, Notion-style) via a class.
const Parchment = Quill.import('parchment');
const LineBackground = new Parchment.ClassAttributor('lineBackground', 'hlblock', {
  scope: Parchment.Scope.BLOCK,
  whitelist: ['yellow', 'green', 'blue', 'pink', 'gray']
});
Quill.register(LineBackground, true);

// Bubble theme = formatting hidden until text is selected, then a floating bar.
const quill = new Quill('#editor', {
  theme: 'bubble',
  placeholder: "Write something — or paste anything, formatting is kept. Select text to format.",
  modules: {
    history: { delay: 600, maxStack: 200, userOnly: true },
    toolbar: [
      [{ font: Font.whitelist }, { size: Size.whitelist }],
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ color: [] }, { background: [] }],
      [{ list: 'bullet' }, { list: 'ordered' }, { list: 'check' }],
      ['blockquote', 'code', 'code-block'],
      ['link', 'clean']
    ]
  }
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let data = { tree: [] };
let currentNoteId = null;
let noteSaveTimer = null;
let treeSaveTimer = null;
let suppressTextChange = false;
let uiTheme = 'notion';
let uiAutoPill = true;
let codeIndent = 4;

const $tree = document.getElementById('tree');
const $tabbar = document.getElementById('tabbar');
const $title = document.getElementById('noteTitle');
const $empty = document.getElementById('emptyState');
const $pop = document.getElementById('popMenu');
const $crumb = document.getElementById('crumb');

// crisp line icons (Notion-ish), drawn in currentColor
const ICONS = {
  page: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M4 2.2h4.6L12 5.6V13.8H4z"/><path d="M8.4 2.4v3.1h3.1"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M2 4.4h3.4l1.2 1.3H14v6.2H2z"/></svg>',
  folderOpen: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M2 4.4h3.4l1.2 1.3H14"/><path d="M2 4.6v7.5h12V6.7H6.6"/></svg>'
};

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------
function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    'id-' + Math.abs(Math.floor(performance.now() * 1000)).toString(36);
}
function locate(id, list = data.tree) {
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.id === id) return { node: n, list, index: i };
    if (n.type === 'folder' && n.children) {
      const found = locate(id, n.children);
      if (found) return found;
    }
  }
  return null;
}
function isDescendant(node, id) {
  if (!node || node.type !== 'folder' || !node.children) return false;
  for (const c of node.children) {
    if (c.id === id) return true;
    if (isDescendant(c, id)) return true;
  }
  return false;
}
function collectNoteIds(node, acc) {
  if (node.type === 'note') acc.push(node.id);
  else if (node.children) node.children.forEach((c) => collectNoteIds(c, acc));
  return acc;
}
function pathOf(id) {
  const rec = (list, trail) => {
    for (const n of list) {
      if (n.id === id) return [...trail, n.name];
      if (n.children) { const r = rec(n.children, [...trail, n.name]); if (r) return r; }
    }
    return null;
  };
  return rec(data.tree, []) || [];
}
function firstNote(list) {
  for (const n of list) {
    if (n.type === 'note') return n.id;
    if (n.children) { const f = firstNote(n.children); if (f) return f; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function scheduleTreeSave() {
  clearTimeout(treeSaveTimer);
  treeSaveTimer = setTimeout(() => api.saveTree(data), 250);
}
function scheduleNoteSave() {
  if (!currentNoteId) return;
  clearTimeout(noteSaveTimer);
  const id = currentNoteId;
  noteSaveTimer = setTimeout(() => api.saveNote(id, quill.getContents()), 400);
}
function flushNoteSave() {
  if (!currentNoteId) return;
  clearTimeout(noteSaveTimer);
  api.saveNote(currentNoteId, quill.getContents());
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------
function updateCrumb() {
  if (!currentNoteId) { $crumb.textContent = 'No note open'; return; }
  const parts = pathOf(currentNoteId);
  if (!parts.length) { $crumb.textContent = 'No note open'; return; }
  const last = parts.pop();
  $crumb.innerHTML = (parts.length ? parts.map(escapeHtml).join('  ›  ') + '  ›  ' : '') +
    '<b>' + escapeHtml(last) + '</b>';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------
function render() {
  $tree.innerHTML = '';
  data.tree.forEach((n) => $tree.appendChild(renderNode(n, 0)));
}
function actButton(svgPath, title) {
  const b = document.createElement('span');
  b.className = 'act';
  b.title = title;
  b.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15">${svgPath}</svg>`;
  return b;
}
function renderNode(node, depth) {
  const frag = document.createDocumentFragment();

  const row = document.createElement('div');
  row.className = 'row' + (node.id === currentNoteId ? ' selected' : '');
  row.dataset.id = node.id;
  row.style.paddingLeft = 6 + depth * 16 + 'px';
  row.draggable = true;

  const twisty = document.createElement('span');
  twisty.className = 'twisty' +
    (node.type === 'folder' ? (node.expanded ? ' open' : '') : ' leaf');
  twisty.textContent = node.type === 'folder' ? '▶' : '•';
  row.appendChild(twisty);

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = node.type === 'folder' ? (node.expanded ? ICONS.folderOpen : ICONS.folder) : ICONS.page;
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = node.name || (node.type === 'folder' ? 'Folder' : 'Untitled');
  row.appendChild(label);

  const actions = document.createElement('span');
  actions.className = 'actions';
  if (node.type === 'folder') {
    const plus = actButton('<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>', 'Add inside');
    plus.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = plus.getBoundingClientRect();
      openCreateMenu(node, r.left, r.bottom + 4);
    });
    actions.appendChild(plus);
  }
  const more = actButton('<circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/>', 'More');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    openRowMenu(node, r.left, r.bottom + 4);
  });
  actions.appendChild(more);
  row.appendChild(actions);

  // --- events ---
  twisty.addEventListener('click', (e) => {
    if (node.type !== 'folder') return;
    e.stopPropagation();
    node.expanded = !node.expanded;
    scheduleTreeSave();
    render();
  });
  // single click selects/toggles, but defer briefly so a double-click (rename)
  // can cancel it — otherwise the click's re-render destroys the row first.
  let clickTimer = null;
  row.addEventListener('click', () => {
    if (clickTimer) return;
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (node.type === 'folder') { node.expanded = !node.expanded; scheduleTreeSave(); render(); }
      else selectNote(node.id);
    }, 240);
  });
  row.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    beginRename(node, row, row.querySelector('.label'));
  });
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openRowMenu(node, e.clientX, e.clientY); });

  // --- drag & drop ---
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', node.id);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    $tree.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    $tree.classList.remove('dragging');
    $tree.querySelectorAll('.drop-target').forEach((r) => r.classList.remove('drop-target'));
  });
  row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('drop-target');
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      const paths = Array.from(e.dataTransfer.files).map((f) => api.getDroppedPath(f)).filter(Boolean);
      importPaths(paths, node.type === 'folder' ? node.id : null);
      return;
    }
    const dragId = e.dataTransfer.getData('text/plain');
    moveNode(dragId, node.id, node.type === 'folder' ? 'inside' : 'after');
  });

  frag.appendChild(row);

  if (node.type === 'folder' && node.expanded && node.children) {
    node.children.forEach((c) => frag.appendChild(renderNode(c, depth + 1)));
  }
  return frag;
}

$tree.addEventListener('dragover', (e) => e.preventDefault());
$tree.addEventListener('drop', (e) => {
  const dragId = e.dataTransfer.getData('text/plain');
  if (dragId) moveNode(dragId, null, 'root');
});

function moveNode(dragId, targetId, mode) {
  if (!dragId || dragId === targetId) return;
  const src = locate(dragId);
  if (!src) return;
  if (targetId && isDescendant(src.node, targetId)) return;

  src.list.splice(src.index, 1);

  if (mode === 'root' || !targetId) {
    data.tree.push(src.node);
  } else {
    const tgt = locate(targetId);
    if (!tgt) data.tree.push(src.node);
    else if (mode === 'inside' && tgt.node.type === 'folder') {
      tgt.node.children = tgt.node.children || [];
      tgt.node.children.push(src.node);
      tgt.node.expanded = true;
    } else {
      tgt.list.splice(tgt.index + 1, 0, src.node);
    }
  }
  scheduleTreeSave();
  render();
  updateCrumb();
}

// ---------------------------------------------------------------------------
// Editor tabs (open notes), Cursor/VS Code style
// ---------------------------------------------------------------------------
function renderTabs() {
  if (!data.openTabs) data.openTabs = [];
  data.openTabs = data.openTabs.filter((id) => { const f = locate(id); return f && f.node.type === 'note'; });
  $tabbar.innerHTML = '';
  if (!data.openTabs.length) { $tabbar.classList.add('empty'); return; }
  $tabbar.classList.remove('empty');
  data.openTabs.forEach((id) => {
    const f = locate(id);
    const tab = document.createElement('div');
    tab.className = 'tab' + (id === currentNoteId ? ' active' : '');
    tab.draggable = true;
    tab.dataset.id = id;
    const ic = document.createElement('span'); ic.className = 'tab-icon'; ic.innerHTML = ICONS.page;
    const nm = document.createElement('span'); nm.className = 'tab-name'; nm.textContent = f.node.name || 'Untitled';
    const cl = document.createElement('span'); cl.className = 'tab-close'; cl.textContent = '✕'; cl.title = 'Close';
    tab.append(ic, nm, cl);
    tab.addEventListener('click', () => selectNote(id));
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(id); } });
    cl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
    tab.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/tab', id); tab.classList.add('dragging'); });
    tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
    tab.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/tab')) e.preventDefault(); });
    tab.addEventListener('drop', (e) => { e.preventDefault(); reorderTab(e.dataTransfer.getData('text/tab'), id); });
    $tabbar.appendChild(tab);
  });
  const act = $tabbar.querySelector('.tab.active');
  if (act) act.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}
function openTab(id) {
  if (!data.openTabs) data.openTabs = [];
  if (!data.openTabs.includes(id)) { data.openTabs.push(id); scheduleTreeSave(); }
}
function closeTab(id) {
  const i = data.openTabs.indexOf(id);
  if (i < 0) return;
  data.openTabs.splice(i, 1);
  scheduleTreeSave();
  if (id === currentNoteId) {
    const next = data.openTabs[i] || data.openTabs[i - 1] || null;
    if (next) selectNote(next); else clearSelection();
  } else {
    renderTabs();
  }
}
function reorderTab(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const arr = data.openTabs;
  const fi = arr.indexOf(fromId), ti = arr.indexOf(toId);
  if (fi < 0 || ti < 0) return;
  arr.splice(fi, 1);
  arr.splice(ti, 0, fromId);
  scheduleTreeSave();
  renderTabs();
}

// ---------------------------------------------------------------------------
// Selecting / loading notes
// ---------------------------------------------------------------------------
async function selectNote(id) {
  if (id === currentNoteId) return;
  flushNoteSave();

  const found = locate(id);
  if (!found || found.node.type !== 'note') return;

  currentNoteId = id;
  data.lastOpened = id;
  openTab(id);
  scheduleTreeSave();
  $empty.classList.add('hidden');
  $title.disabled = false;
  $title.value = found.node.name === 'Untitled' ? '' : (found.node.name || '');

  const delta = await api.getNote(id);
  suppressTextChange = true;
  if (delta && delta.ops) quill.setContents(delta, 'silent');
  else quill.setContents([{ insert: '\n' }], 'silent');
  quill.history.clear();
  suppressTextChange = false;

  render();
  renderTabs();
  updateCrumb();

  const cont = document.getElementById('editor');
  cont.classList.remove('enter');
  void cont.offsetWidth; // reflow → replay animation
  cont.classList.add('enter');

  quill.focus();
  if (typeof aiSyncContext === 'function') aiSyncContext();
}

function clearSelection() {
  flushNoteSave();
  currentNoteId = null;
  $title.value = '';
  $title.disabled = true;
  suppressTextChange = true;
  quill.setContents([{ insert: '\n' }], 'silent');
  suppressTextChange = false;
  $empty.classList.remove('hidden');
  render();
  renderTabs();
  updateCrumb();
  if (typeof aiSyncContext === 'function') aiSyncContext();
}

// ---------------------------------------------------------------------------
// Create / rename / delete
// ---------------------------------------------------------------------------
function addItem(type, parentFolderNode) {
  const node = type === 'folder'
    ? { id: uid(), type: 'folder', name: 'New folder', expanded: true, children: [] }
    : { id: uid(), type: 'note', name: 'Untitled' };

  if (parentFolderNode) {
    parentFolderNode.children = parentFolderNode.children || [];
    parentFolderNode.children.push(node);
    parentFolderNode.expanded = true;
  } else {
    data.tree.push(node);
  }
  scheduleTreeSave();

  if (type === 'note') {
    api.saveNote(node.id, { ops: [{ insert: '\n' }] });
    render();
    selectNote(node.id);
  } else {
    render();
  }
  requestAnimationFrame(() => {
    const row = $tree.querySelector(`.row[data-id="${node.id}"]`);
    if (row) beginRename(node, row, row.querySelector('.label'));
  });
}

function beginRename(node, row, label) {
  if (!label) return;
  const input = document.createElement('input');
  input.className = 'label-input';
  input.value = node.name || '';
  label.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    node.name = input.value.trim() || (node.type === 'folder' ? 'Folder' : 'Untitled');
    scheduleTreeSave();
    if (node.id === currentNoteId) {
      $title.value = node.name === 'Untitled' ? '' : node.name;
      updateCrumb();
    }
    render();
    renderTabs();
  };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = node.name || ''; input.blur(); }
  });
}

const TRASH_ID = 'sys-trash';
function ensureTrash() {
  let t = data.tree.find((n) => n.id === TRASH_ID);
  if (!t) { t = { id: TRASH_ID, type: 'folder', name: '🗑 Trash', expanded: false, children: [] }; data.tree.push(t); }
  t.children = t.children || [];
  return t;
}
function inTrash(id) {
  const t = data.tree.find((n) => n.id === TRASH_ID);
  return !!t && (id === TRASH_ID || isDescendant(t, id));
}

function deleteItem(node) {
  // Already in Trash (or the Trash folder itself) → permanent delete (confirm).
  if (inTrash(node.id)) {
    const msg = node.id === TRASH_ID
      ? 'Empty the Trash permanently? This cannot be undone.'
      : `Permanently delete "${node.name}"? This cannot be undone.`;
    if (!confirm(msg)) return;
    const ids = collectNoteIds(node, []);
    const found = locate(node.id);
    if (found) found.list.splice(found.index, 1);
    ids.forEach((id) => api.deleteNote(id));
    if (ids.includes(currentNoteId)) clearSelection();
    scheduleTreeSave();
    render();
    renderTabs();
    return;
  }
  // Otherwise → soft delete: move to Trash (recoverable, no scary prompt).
  const found = locate(node.id);
  if (!found) return;
  found.list.splice(found.index, 1);
  ensureTrash().children.push(node);
  scheduleTreeSave();
  render();
  renderTabs();
  toast(`Moved “${node.name}” to Trash`);
}

// ---------------------------------------------------------------------------
// Popup menus  (item & opener clicks stop propagation so the outside-close
// handler never fires on the same click that opened the menu)
// ---------------------------------------------------------------------------
function openPopup(items, x, y) {
  $pop.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; $pop.appendChild(s); return; }
    const el = document.createElement('div');
    el.className = 'item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    el.innerHTML = `<span class="mi">${it.icon || ''}</span><span>${it.label}</span>`;
    if (!it.disabled) {
      el.addEventListener('click', (ev) => { ev.stopPropagation(); closePopup(); it.action(); });
    }
    $pop.appendChild(el);
  });
  $pop.classList.remove('hidden');
  const w = $pop.offsetWidth, h = $pop.offsetHeight;
  $pop.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  $pop.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
}
function closePopup() { $pop.classList.add('hidden'); document.querySelectorAll('.menu-btn.active').forEach((b) => b.classList.remove('active')); }
document.addEventListener('click', (e) => { if (!$pop.contains(e.target)) closePopup(); });
document.addEventListener('scroll', closePopup, true);
window.addEventListener('blur', closePopup);

function openCreateMenu(parentFolder, x, y) {
  openPopup([
    { icon: '📄', label: 'New note', action: () => addItem('note', parentFolder) },
    { icon: '📁', label: 'New folder', action: () => addItem('folder', parentFolder) }
  ], x, y);
}
function openRowMenu(node, x, y) {
  const items = [];
  if (node.type === 'folder') {
    items.push({ icon: '📄', label: 'New note', action: () => addItem('note', node) });
    items.push({ icon: '📁', label: 'New folder', action: () => addItem('folder', node) });
    items.push({ sep: true });
  }
  items.push({
    icon: '✎', label: 'Rename', action: () => {
      const row = $tree.querySelector(`.row[data-id="${node.id}"]`);
      if (row) beginRename(node, row, row.querySelector('.label'));
    }
  });
  if (node.id !== TRASH_ID && inTrash(node.id)) {
    items.push({ icon: '↩', label: 'Restore from Trash', action: () => restoreFromTrash(node) });
  }
  items.push({ sep: true });
  const delLabel = inTrash(node.id) ? (node.id === TRASH_ID ? 'Empty Trash' : 'Delete permanently') : 'Move to Trash';
  items.push({ icon: '🗑', label: delLabel, danger: true, action: () => deleteItem(node) });
  openPopup(items, x, y);
}

function restoreFromTrash(node) {
  const found = locate(node.id);
  if (!found) return;
  found.list.splice(found.index, 1);
  data.tree.push(node); // restore to top level
  scheduleTreeSave();
  render();
  renderTabs();
  toast(`Restored “${node.name}”`);
}

// ---------------------------------------------------------------------------
// Header menu bar (File / Edit / View)
// ---------------------------------------------------------------------------
function fmtToggle(name) {
  const cur = quill.getFormat();
  quill.format(name, !cur[name]);
}
function highlightLine(value) {
  const sel = quill.getSelection(true);
  if (!sel) { quill.focus(); return; }
  quill.formatLine(sel.index, sel.length || 1, 'lineBackground', value || false, 'user');
}
const MENUS = {
  file: () => ([
    { icon: '📄', label: 'New note', action: () => addItem('note', null) },
    { icon: '📁', label: 'New folder', action: () => addItem('folder', null) },
    { sep: true },
    { icon: '⤓', label: 'Export as Markdown', action: () => exportNote('md'), disabled: !currentNoteId },
    { icon: '⤓', label: 'Export as HTML', action: () => exportNote('html'), disabled: !currentNoteId },
    { icon: '⤓', label: 'Export as Plain text', action: () => exportNote('txt'), disabled: !currentNoteId },
    { sep: true },
    { icon: '⎙', label: 'Import file (PDF / Word)…', action: openImportModal }
  ]),
  edit: () => ([
    { icon: '↶', label: 'Undo', action: () => quill.history.undo() },
    { icon: '↷', label: 'Redo', action: () => quill.history.redo() },
    { sep: true },
    { icon: 'A', label: 'Select all', action: () => quill.setSelection(0, quill.getLength()) },
    { sep: true },
    { icon: 'B', label: 'Bold', action: () => fmtToggle('bold') },
    { icon: 'I', label: 'Italic', action: () => fmtToggle('italic') },
    { icon: 'U', label: 'Underline', action: () => fmtToggle('underline') },
    { sep: true },
    { icon: '🟨', label: 'Highlight block · Yellow', action: () => highlightLine('yellow') },
    { icon: '🟩', label: 'Highlight block · Green', action: () => highlightLine('green') },
    { icon: '🟦', label: 'Highlight block · Blue', action: () => highlightLine('blue') },
    { icon: '🟥', label: 'Highlight block · Pink', action: () => highlightLine('pink') },
    { icon: '⬜', label: 'Highlight block · None', action: () => highlightLine(false) }
  ]),
  view: () => ([
    { icon: '◧', label: 'Toggle sidebar', action: () => document.getElementById('app').classList.toggle('sidebar-hidden') },
    { icon: '✦', label: 'Toggle assistant panel', action: toggleAssistant },
    { icon: '🧠', label: 'Long-term memory', action: openMemoryPanel },
    { icon: uiAutoPill ? '✓' : '', label: 'Pill when I switch away', action: () => api.win.setAutoPill(!uiAutoPill) },
    { sep: true },
    { icon: uiTheme === 'notion' ? '✓' : '', label: 'Theme · Notion', action: () => applyTheme('notion') },
    { icon: uiTheme === 'invisible' ? '✓' : '', label: 'Theme · Invisible overlay', action: () => applyTheme('invisible') },
    { sep: true },
    { icon: codeIndent === 2 ? '✓' : '', label: 'Code indent · 2', action: () => setCodeIndent(2) },
    { icon: codeIndent === 4 ? '✓' : '', label: 'Code indent · 4', action: () => setCodeIndent(4) },
    { icon: codeIndent === 8 ? '✓' : '', label: 'Code indent · 8', action: () => setCodeIndent(8) },
    { sep: true },
    {
      icon: '👁', label: 'Toggle capture invisibility',
      action: async () => paintStealth(await api.toggleStealth())
    },
    { icon: '📂', label: 'Reveal notes folder', action: () => api.openDataFolder() }
  ])
};
document.querySelectorAll('.menu-btn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = btn.classList.contains('active');
    closePopup();
    if (wasActive) return;
    btn.classList.add('active');
    const r = btn.getBoundingClientRect();
    openPopup(MENUS[btn.dataset.menu](), r.left, r.bottom + 4);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function applyInlineMd(text, attr) {
  attr = attr || {};
  if (attr.code) text = '`' + text + '`';
  if (attr.bold) text = '**' + text + '**';
  if (attr.italic) text = '*' + text + '*';
  if (attr.strike) text = '~~' + text + '~~';
  if (attr.underline) text = '<u>' + text + '</u>';
  if (attr.link) text = '[' + text + '](' + attr.link + ')';
  return text;
}
function deltaToMarkdown(delta) {
  let md = '';
  let buf = '';
  const flush = (a) => {
    a = a || {};
    if (a['code-block']) { md += '    ' + buf + '\n'; buf = ''; return; }
    let prefix = '';
    if (a.header === 1) prefix = '# ';
    else if (a.header === 2) prefix = '## ';
    else if (a.header === 3) prefix = '### ';
    if (a.list === 'bullet') prefix = '- ' + prefix;
    else if (a.list === 'ordered') prefix = '1. ' + prefix;
    else if (a.list === 'checked') prefix = '- [x] ';
    else if (a.list === 'unchecked') prefix = '- [ ] ';
    if (a.blockquote) prefix = '> ' + prefix;
    md += prefix + buf + '\n';
    buf = '';
  };
  (delta.ops || []).forEach((op) => {
    if (typeof op.insert !== 'string') { return; }
    const parts = op.insert.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) buf += applyInlineMd(parts[i], op.attributes);
      if (i < parts.length - 1) flush(op.attributes);
    }
  });
  if (buf) md += buf + '\n';
  return md.trim() + '\n';
}
function htmlDoc(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: Inter, -apple-system, "Segoe UI", Arial, sans-serif; color: #37352f; max-width: 740px; margin: 48px auto; padding: 0 24px; line-height: 1.65; }
  h1 { letter-spacing: -.4px; }
  blockquote { border-left: 3px solid #37352f; margin: 8px 0; padding-left: 14px; color: #5d5b54; }
  pre { background: #f7f7f5; border: 1px solid #ebeae7; border-radius: 8px; padding: 14px; overflow:auto; }
  code { background: rgba(135,131,120,.15); border-radius: 4px; padding: 1px 5px; }
  a { color: #0075de; }
  .ql-font-serif { font-family: Georgia, serif; } .ql-font-mono { font-family: Consolas, monospace; }
  .ql-font-georgia { font-family: Georgia, serif; } .ql-font-tahoma { font-family: Tahoma, sans-serif; }
  .ql-font-comic { font-family: "Comic Sans MS", cursive; }
  .ql-align-center{text-align:center}.ql-align-right{text-align:right}.ql-align-justify{text-align:justify}
</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
async function exportNote(fmt) {
  if (!currentNoteId) return;
  const found = locate(currentNoteId);
  const title = (found && found.node.name) || 'Untitled';
  let content, ext, filterName;
  if (fmt === 'md') { content = '# ' + title + '\n\n' + deltaToMarkdown(quill.getContents()); ext = 'md'; filterName = 'Markdown'; }
  else if (fmt === 'html') { content = htmlDoc(title, quill.root.innerHTML); ext = 'html'; filterName = 'HTML'; }
  else { content = title + '\n\n' + quill.getText(); ext = 'txt'; filterName = 'Plain text'; }
  const safe = (title.replace(/[^\w\- ]+/g, '').trim() || 'note').slice(0, 80);
  const saved = await api.exportFile({ defaultName: safe + '.' + ext, content, ext, filterName });
  if (saved) toast('Exported to ' + saved);
}

// ---------------------------------------------------------------------------
// Import (PDF / Word) — drag-and-drop modal with a loading indicator
// ---------------------------------------------------------------------------
const $importModal = document.getElementById('importModal');
const $dropzone = document.getElementById('dropzone');

function openImportModal() { setImportBusy(false); $importModal.classList.remove('hidden'); }
function closeImportModal() { $importModal.classList.add('hidden'); }
function setImportBusy(b, label) {
  $dropzone.classList.toggle('busy', b);
  $dropzone.querySelector('.dz-idle').classList.toggle('hidden', b);
  $dropzone.querySelector('.dz-busy').classList.toggle('hidden', !b);
  if (label) document.getElementById('dzBusyLabel').textContent = label;
}

function applyFills(tableEl, fills) {
  if (!fills) return;
  tableEl.querySelectorAll('tr').forEach((row, r) => {
    const cells = row.children;
    for (let c = 0; c < cells.length; c++) {
      const fill = fills[r] && fills[r][c];
      if (fill) cells[c].style.backgroundColor = fill;
    }
  });
}

// HTML -> Delta, keeping <table> as a rendered block so it isn't flattened.
// tableFills (from the .docx) re-applies cell background colors per table.
function htmlToDelta(html, tableFills) {
  const tpl = document.createElement('div');
  tpl.innerHTML = html || '';
  const ops = [];
  let buf = '';
  let tIdx = 0;
  const flush = () => {
    if (buf.trim()) { const d = quill.clipboard.convert({ html: buf }); ops.push(...d.ops); }
    buf = '';
  };
  tpl.childNodes.forEach((node) => {
    if (node.nodeType === 1 && node.tagName === 'TABLE') {
      flush();
      applyFills(node, tableFills && tableFills[tIdx]); tIdx++;
      ops.push({ insert: { htmlblock: node.outerHTML } });
      ops.push({ insert: '\n' });
    } else {
      buf += node.nodeType === 1 ? node.outerHTML : (node.textContent || '');
    }
  });
  flush();
  if (!ops.length) ops.push({ insert: '\n' });
  return { ops };
}

// code/text file -> Quill code-block delta (one block, line-numbered via CSS)
function codeToDelta(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n'); // keep tabs so the indent config (tab-size) applies
  const ops = [];
  lines.forEach((line) => {
    if (line) ops.push({ insert: line });
    ops.push({ insert: '\n', attributes: { 'code-block': true } });
  });
  if (!ops.length) ops.push({ insert: '\n' });
  return { ops };
}

// import one file into the tree (optionally inside a folder); returns {id,name}|null
async function importFile(filePath, parentId) {
  let res;
  try { res = await api.importPath(filePath); } catch (e) { res = { error: String(e) }; }
  if (!res || res.error) { toast('Import failed: ' + ((res && res.error) || 'unknown')); return null; }
  let delta;
  if (res.kind === 'docx') delta = htmlToDelta(res.html, res.tableFills);
  else if (res.kind === 'code') delta = codeToDelta(res.text);
  else delta = res.delta || { ops: [{ insert: '\n' }] };
  const id = uid();
  const node = { id, type: 'note', name: res.name };
  const parent = parentId ? locate(parentId) : null;
  if (parent && parent.node.type === 'folder') { parent.node.children = parent.node.children || []; parent.node.children.push(node); parent.node.expanded = true; }
  else data.tree.push(node);
  await api.saveTree(data);
  await api.saveNote(id, { ops: delta.ops });
  render();
  renderTabs();
  return { id, name: res.name };
}

// import many files (from the dialog or a drag-drop), into an optional folder
async function importPaths(paths, parentId) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  setImportBusy(true, 'Importing…');
  let last = null;
  for (const p of list) { const r = await importFile(p, parentId); if (r) last = r; }
  setImportBusy(false);
  if (last) {
    selectNote(last.id);
    closeImportModal();
    toast(list.length > 1 ? `Imported ${list.length} files` : `Imported “${last.name}”`);
  }
}

function setupImport() {
  document.getElementById('importClose').addEventListener('click', closeImportModal);
  $importModal.addEventListener('click', (e) => { if (e.target === $importModal) closeImportModal(); });
  document.getElementById('browseBtn').addEventListener('click', async () => {
    const paths = await api.importBrowse();
    if (paths && paths.length) importPaths(paths, null);
  });
  ['dragenter', 'dragover'].forEach((ev) => $dropzone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); $dropzone.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((ev) => $dropzone.addEventListener(ev, (e) => { e.preventDefault(); $dropzone.classList.remove('over'); }));
  $dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    $dropzone.classList.remove('over');
    const paths = Array.from(e.dataTransfer.files || []).map((f) => api.getDroppedPath(f)).filter(Boolean);
    if (!paths.length) { toast('Could not read the dropped file path.'); return; }
    importPaths(paths, null);
  });
}
setupImport();

// ---------------------------------------------------------------------------
// Table cell background color — right-click a cell in an imported table
// ---------------------------------------------------------------------------
function applyCellColor(cell, color) {
  if (color) cell.style.backgroundColor = color;
  else cell.style.removeProperty('background-color');
  // the htmlblock's value is its live innerHTML, so getContents captures the change
  if (currentNoteId) { clearTimeout(noteSaveTimer); api.saveNote(currentNoteId, quill.getContents()); }
}
function openCellColorMenu(cell, x, y) {
  const sw = (c) => `<span style="display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid rgba(0,0,0,.15);background:${c}"></span>`;
  const colors = [['#fff3a3', 'Yellow'], ['#cdebc5', 'Green'], ['#cfe4fb', 'Blue'], ['#fbd5e2', 'Pink'], ['#ffd8b0', 'Orange'], ['#ececec', 'Gray']];
  const items = colors.map(([c, name]) => ({ icon: sw(c), label: name, action: () => applyCellColor(cell, c) }));
  items.push({ sep: true });
  items.push({ icon: '⌫', label: 'Clear color', action: () => applyCellColor(cell, null) });
  openPopup(items, x, y);
}
quill.root.addEventListener('contextmenu', (e) => {
  const cell = e.target.closest && e.target.closest('.ql-htmlblock td, .ql-htmlblock th');
  if (!cell) return;
  e.preventDefault();
  e.stopPropagation();
  openCellColorMenu(cell, e.clientX, e.clientY);
});

// tiny transient toast
let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t);
    t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:rgba(40,38,34,.94);color:#fff;font-size:12.5px;padding:9px 14px;border-radius:9px;z-index:2000;box-shadow:0 8px 30px rgba(0,0,0,.3);transition:opacity .2s;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2600);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
quill.on('text-change', () => {
  if (suppressTextChange || !currentNoteId) return;
  scheduleNoteSave();
});

$title.addEventListener('input', () => {
  if (!currentNoteId) return;
  const found = locate(currentNoteId);
  if (!found) return;
  found.node.name = $title.value.trim() || 'Untitled';
  scheduleTreeSave();
  const lbl = $tree.querySelector(`.row[data-id="${currentNoteId}"] .label`);
  if (lbl) lbl.textContent = found.node.name;
  updateCrumb();
  renderTabs();
});
$title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quill.focus(); } });

document.getElementById('newBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  openCreateMenu(null, r.left, r.bottom + 6);
});

document.getElementById('exportBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  closePopup();
  const r = e.currentTarget.getBoundingClientRect();
  openPopup([
    { icon: '⤓', label: 'Export as Markdown', action: () => exportNote('md'), disabled: !currentNoteId },
    { icon: '⤓', label: 'Export as HTML', action: () => exportNote('html'), disabled: !currentNoteId },
    { icon: '⤓', label: 'Export as Plain text', action: () => exportNote('txt'), disabled: !currentNoteId }
  ], r.right - 188, r.bottom + 6);
});

// ---------------------------------------------------------------------------
// Stealth toggle (now in the top bar)
// ---------------------------------------------------------------------------
const $stealthBtn = document.getElementById('stealthBtn');
const $stealthLabel = document.getElementById('stealthLabel');
function paintStealth(on) {
  $stealthBtn.classList.toggle('off', !on);
  $stealthLabel.textContent = on ? 'Hidden' : 'Visible';
  $stealthBtn.title = (on ? 'Hidden from capture' : 'Visible to capture') + ' — click to toggle (Ctrl+Shift+H)';
}
$stealthBtn.addEventListener('click', async () => paintStealth(await api.toggleStealth()));
api.onStealthChanged(paintStealth);

// ---------------------------------------------------------------------------
// Frameless window controls
// ---------------------------------------------------------------------------
document.getElementById('winMin').addEventListener('click', () => api.win.shrink());
document.getElementById('winClose').addEventListener('click', () => api.win.close());
const $winMax = document.getElementById('winMax');
$winMax.addEventListener('click', () => api.win.maximize());
function paintMaxIcon(max) {
  $winMax.innerHTML = max
    ? '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.4" y="3.6" width="6" height="6" rx="1"/><path d="M4.4 3.6V2.4h5.2v5.2H8.4"/></svg>'
    : '<svg viewBox="0 0 12 12" width="11" height="11"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  $winMax.title = max ? 'Restore' : 'Maximize';
}
api.win.onState(paintMaxIcon);
api.win.isMaximized().then(paintMaxIcon);

// compact floating-pill mode
document.getElementById('pillExpand').addEventListener('click', (e) => { e.stopPropagation(); api.win.expand(); });
let savedScroll = 0;
api.win.onCompact((c) => {
  const ed = document.getElementById('editor');
  if (c) {
    if (ed) savedScroll = ed.scrollTop;       // remember scroll before collapsing
    document.body.classList.add('compact');
  } else {
    document.body.classList.remove('compact'); // restore scroll after re-showing
    requestAnimationFrame(() => { const e = document.getElementById('editor'); if (e) e.scrollTop = savedScroll; });
  }
});
api.win.getAutoPill().then((v) => { uiAutoPill = v; }).catch(() => {});
api.win.onAutoPillChanged((v) => { uiAutoPill = v; });

// theme selector (default Notion; invisible = transparent overlay)
function applyTheme(t) {
  uiTheme = t === 'invisible' ? 'invisible' : 'notion';
  document.body.classList.toggle('theme-invisible', uiTheme === 'invisible');
  try { localStorage.setItem('sn-theme', uiTheme); } catch {}
}
try { applyTheme(localStorage.getItem('sn-theme') || 'notion'); } catch { applyTheme('notion'); }

// code indentation (tab width) config
function setCodeIndent(n) {
  codeIndent = Number(n) || 4;
  document.body.style.setProperty('--code-tab', String(codeIndent));
  try { localStorage.setItem('sn-code-tab', String(codeIndent)); } catch {}
}
(() => { let v = 4; try { v = Number(localStorage.getItem('sn-code-tab')) || 4; } catch {} setCodeIndent(v); })();

// overlay opacity slider (only visible in invisible theme)
const $ovl = document.getElementById('ovlOpacity');
function applyOverlayOpacity(v) { document.body.style.setProperty('--ovl', (Number(v) / 100).toFixed(2)); }
$ovl.addEventListener('input', () => { applyOverlayOpacity($ovl.value); try { localStorage.setItem('sn-ovl', $ovl.value); } catch {} });
(() => {
  let v = '45'; try { v = localStorage.getItem('sn-ovl') || '45'; } catch {}
  $ovl.value = v; applyOverlayOpacity(v);
})();

// ---------------------------------------------------------------------------
// Profile (footer)
// ---------------------------------------------------------------------------
document.getElementById('profileBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  openPopup([
    { icon: '📂', label: 'Reveal notes folder', action: () => api.openDataFolder() },
    {
      icon: '👁', label: 'Toggle capture invisibility',
      action: async () => paintStealth(await api.toggleStealth())
    }
  ], r.left, r.top - 96);
});

// ---------------------------------------------------------------------------
// Sidebar resizer
// ---------------------------------------------------------------------------
const $sidebar = document.getElementById('sidebar');
let resizing = false;
document.getElementById('resizer').addEventListener('mousedown', () => { resizing = true; document.body.style.cursor = 'col-resize'; });
window.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  $sidebar.style.width = Math.max(200, Math.min(460, e.clientX)) + 'px';
});
window.addEventListener('mouseup', () => { resizing = false; document.body.style.cursor = ''; });

// drop external files anywhere on the sidebar to import them (root level)
$sidebar.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); $sidebar.classList.add('file-drop'); }
});
$sidebar.addEventListener('dragleave', (e) => { if (e.target === $sidebar) $sidebar.classList.remove('file-drop'); });
$sidebar.addEventListener('drop', (e) => {
  $sidebar.classList.remove('file-drop');
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    e.preventDefault();
    const paths = Array.from(e.dataTransfer.files).map((f) => api.getDroppedPath(f)).filter(Boolean);
    importPaths(paths, null);
  }
});

// ---------------------------------------------------------------------------
// Shortcuts + lifecycle
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    addItem('note', null);
  }
});
window.addEventListener('beforeunload', flushNoteSave);

// toggle assistant panel
function toggleAssistant() { document.getElementById('app').classList.toggle('ai-hidden'); }
function toggleSidebar() { document.getElementById('app').classList.toggle('sidebar-hidden'); }
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); toggleAssistant(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
  if (e.key === 'F2' && currentNoteId) {
    const found = locate(currentNoteId);
    const row = $tree.querySelector(`.row[data-id="${currentNoteId}"]`);
    if (found && row) { e.preventDefault(); beginRename(found.node, row, row.querySelector('.label')); }
  }
});
document.getElementById('aiToggle').addEventListener('click', toggleAssistant);
document.getElementById('aiCloseBtn').addEventListener('click', toggleAssistant);
document.getElementById('sidebarToggle').addEventListener('click', toggleSidebar);
document.getElementById('resizer').addEventListener('dblclick', toggleSidebar);

// ---------------------------------------------------------------------------
// AI assistant panel
// ---------------------------------------------------------------------------
const $aiMessages = document.getElementById('aiMessages');
const $aiInput = document.getElementById('aiInput');
const $aiSend = document.getElementById('aiSendBtn');
let aiBusy = false;
let thinkingEl = null;

// --- safe Markdown -> HTML for assistant answers (escape first, then format) ---
function mdInlineHtml(s) {
  return s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="ai-link" href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
function mdToHtml(md) {
  const lines = escapeHtml(String(md)).replace(/\r\n/g, '\n').split('\n');
  let html = '', list = null, inCode = false, code = [];
  const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      if (inCode) { html += '<pre><code>' + code.join('\n') + '</code></pre>'; code = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(raw); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(raw))) { closeList(); html += `<div class="aih h${m[1].length}">${mdInlineHtml(m[2])}</div>`; continue; }
    if ((m = /^&gt;\s?(.*)$/.exec(raw))) { closeList(); html += '<blockquote>' + mdInlineHtml(m[1]) + '</blockquote>'; continue; }
    if ((m = /^\s*[-*]\s+(.*)$/.exec(raw))) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += '<li>' + mdInlineHtml(m[1]) + '</li>'; continue; }
    if ((m = /^\s*\d+\.\s+(.*)$/.exec(raw))) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += '<li>' + mdInlineHtml(m[1]) + '</li>'; continue; }
    if (raw.trim() === '') { closeList(); continue; }
    closeList(); html += '<p>' + mdInlineHtml(raw) + '</p>';
  }
  closeList();
  if (inCode) html += '<pre><code>' + code.join('\n') + '</code></pre>';
  return html;
}

function aiScroll() { $aiMessages.scrollTop = $aiMessages.scrollHeight; }
function aiEmptyHint() {
  if ($aiMessages.children.length) return;
  const d = document.createElement('div');
  d.className = 'ai-empty';
  d.textContent = 'Ask me to create, edit, organize or summarize your notes. e.g. “Make a folder ‘Trips’ with a packing-list note.”';
  $aiMessages.appendChild(d);
}
function aiClearEmptyHint() { const h = $aiMessages.querySelector('.ai-empty'); if (h) h.remove(); }

function aiAdd(type, text) {
  aiClearEmptyHint();
  const el = document.createElement('div');
  if (type === 'action') {
    el.className = 'ai-action';
    el.innerHTML = '<span class="tick">✓</span><span></span>';
    el.lastChild.textContent = text;
  } else if (type === 'usage') {
    el.className = 'ai-usage'; el.textContent = text;
  } else if (type === 'error') {
    el.className = 'ai-error'; el.textContent = text;
  } else if (type === 'answer') {
    el.className = 'ai-msg answer md';
    el.innerHTML = mdToHtml(text);
    el.querySelectorAll('a.ai-link').forEach((a) => {
      a.addEventListener('click', (ev) => { ev.preventDefault(); api.openExternal(a.getAttribute('href')); });
    });
  } else {
    el.className = 'ai-msg ' + type; el.textContent = text;
  }
  $aiMessages.appendChild(el);
  if (thinkingEl) $aiMessages.appendChild(thinkingEl); // keep dots last
  aiScroll();
  return el;
}
function setThinking(on) {
  if (on && !thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'ai-thinking';
    thinkingEl.innerHTML = '<span></span><span></span><span></span>';
    $aiMessages.appendChild(thinkingEl); aiScroll();
  } else if (!on && thinkingEl) {
    thinkingEl.remove(); thinkingEl = null;
  }
}
function aiAddThink(text) {
  aiClearEmptyHint();
  const d = document.createElement('details');
  d.className = 'ai-think';
  const s = document.createElement('summary'); s.textContent = 'Thought process';
  const b = document.createElement('div'); b.className = 'think-body'; b.textContent = text;
  d.appendChild(s); d.appendChild(b);
  $aiMessages.appendChild(d);
  if (thinkingEl) $aiMessages.appendChild(thinkingEl);
  aiScroll();
}
function aiSetBusy(b) {
  aiBusy = b;
  $aiSend.classList.toggle('stop', b);
  $aiSend.title = b ? 'Stop' : 'Send (Enter)';
}

let deepMode = false;
const $aiDeep = document.getElementById('aiDeepBtn');
$aiDeep.addEventListener('click', () => { deepMode = !deepMode; $aiDeep.classList.toggle('on', deepMode); });

async function aiSend() {
  const text = $aiInput.value.trim();
  if (!text || aiBusy) return;
  flushNoteSave(); // make sure the agent reads the latest on-disk content
  aiSyncContext();
  aiAdd('user', text);
  $aiInput.value = ''; $aiInput.style.height = 'auto';
  aiSetBusy(true);
  setThinking(true);
  await api.ai.send(text, { deep: deepMode });
}

api.ai.onUpdate((m) => {
  if (m.type === 'thinking') { setThinking(true); return; }
  if (m.type === 'thinking-text') { aiAddThink(m.text); return; }
  if (m.type === 'reasoning') { aiAdd('reasoning', m.text); return; }
  if (m.type === 'action') { aiAdd('action', m.text); return; }
  if (m.type === 'answer') { setThinking(false); aiAdd('answer', m.text); return; }
  if (m.type === 'error') { setThinking(false); aiSetBusy(false); aiAdd('error', m.text); return; }
  if (m.type === 'done') {
    setThinking(false); aiSetBusy(false);
    if (m.usage && (m.usage.input || m.usage.output)) {
      const cached = m.usage.cached ? `, ${m.usage.cached} cached` : '';
      aiAdd('usage', `${m.usage.input} in / ${m.usage.output} out tokens${cached}`);
    }
  }
});

$aiSend.addEventListener('click', () => { if (aiBusy) api.ai.stop(); else aiSend(); });

function aiSyncContext() {
  const f = currentNoteId ? locate(currentNoteId) : null;
  api.ai.setContext({ openNoteId: currentNoteId, openNoteName: f ? f.node.name : null });
}
$aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); }
});
$aiInput.addEventListener('input', () => {
  $aiInput.style.height = 'auto';
  const sh = $aiInput.scrollHeight;
  $aiInput.style.height = Math.min(140, sh) + 'px';
  $aiInput.style.overflowY = sh > 140 ? 'auto' : 'hidden'; // scrollbar only when truly tall
});

document.getElementById('aiClearBtn').addEventListener('click', async () => {
  await api.ai.clear();
  $aiMessages.innerHTML = '';
  aiEmptyHint();
});

// settings
const $aiSettings = document.getElementById('aiSettings');
const $aiMemory = document.getElementById('aiMemory');
document.getElementById('aiSettingsBtn').addEventListener('click', () => {
  $aiMemory.classList.add('hidden');
  $aiSettings.classList.toggle('hidden');
});
document.getElementById('aiSaveSettings').addEventListener('click', async () => {
  const apiKey = document.getElementById('aiKey').value;
  const model = document.getElementById('aiModelInput').value;
  const deepModel = document.getElementById('aiDeepModelInput').value;
  const res = await api.ai.setSettings({ apiKey, model, deepModel });
  document.getElementById('aiKey').value = '';
  document.getElementById('aiModel').textContent = shortModel(res.model);
  $aiSettings.classList.add('hidden');
  aiAdd('action', 'Settings saved' + (res.hasKey ? '' : ' (no key yet)'));
});
function shortModel(m) { return (m || '').replace('claude-', '').replace(/-\d{8}$/, ''); }

// memory viewer
const $aiMemList = document.getElementById('aiMemList');
async function renderMemory(facts) {
  facts = facts || await api.ai.getMemory();
  $aiMemList.innerHTML = '';
  if (!facts.length) {
    const e = document.createElement('div'); e.className = 'ai-mem-empty';
    e.textContent = 'Nothing remembered yet. The assistant will add facts as you work, or add your own.';
    $aiMemList.appendChild(e);
    return;
  }
  facts.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'ai-mem-item';
    const txt = document.createElement('span'); txt.textContent = f.text;
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Forget';
    del.addEventListener('click', async () => renderMemory(await api.ai.deleteMemory(i)));
    item.appendChild(txt); item.appendChild(del);
    $aiMemList.appendChild(item);
  });
}
function openMemoryPanel() {
  document.getElementById('app').classList.remove('ai-hidden'); // ensure the panel is visible
  $aiSettings.classList.add('hidden');
  $aiMemory.classList.remove('hidden');
  renderMemory();
}
document.getElementById('aiMemClear').addEventListener('click', async () => {
  if (confirm('Clear all long-term memory? This cannot be undone.')) renderMemory(await api.ai.clearMemory());
});
document.getElementById('aiMemAdd').addEventListener('click', addMemoryFromInput);
document.getElementById('aiMemInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemoryFromInput(); });
async function addMemoryFromInput() {
  const inp = document.getElementById('aiMemInput');
  const t = inp.value.trim(); if (!t) return;
  inp.value = '';
  renderMemory(await api.ai.addMemory(t));
}
api.ai.onMemoryChanged(() => { if (!$aiMemory.classList.contains('hidden')) renderMemory(); });

// live reload when the agent changes the workspace
api.onWorkspaceChanged(async () => {
  const keep = currentNoteId;
  data = (await api.getTree()) || { tree: [] };
  if (!data.tree) data.tree = [];
  render();
  renderTabs();
  if (keep && locate(keep) && locate(keep).node.type === 'note') {
    const f = locate(keep);
    $title.value = f.node.name === 'Untitled' ? '' : f.node.name;
    const delta = await api.getNote(keep);
    suppressTextChange = true;
    quill.setContents(delta && delta.ops ? delta : [{ insert: '\n' }], 'silent');
    suppressTextChange = false;
  }
  updateCrumb();
});

async function aiInit() {
  try {
    const s = await api.ai.getSettings();
    document.getElementById('aiModel').textContent = shortModel(s.model);
    document.getElementById('aiModelInput').placeholder = s.model || '';
    document.getElementById('aiDeepModelInput').placeholder = s.deepModel || '';
    if (!s.hasKey) {
      $aiSettings.classList.remove('hidden');
    }
  } catch {}
  aiEmptyHint();
}
aiInit();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
  data = (await api.getTree()) || { tree: [] };
  if (!data.tree) data.tree = [];
  paintStealth(await api.getStealth());

  try {
    const u = await api.getUser();
    if (u && u.name) {
      document.getElementById('profileName').textContent = u.name;
      document.getElementById('avatar').textContent = u.name.trim().charAt(0) || '·';
    }
  } catch {}

  render();
  renderTabs();

  let toOpen = null;
  if (data.lastOpened && locate(data.lastOpened) && locate(data.lastOpened).node.type === 'note') toOpen = data.lastOpened;
  else toOpen = firstNote(data.tree);
  if (toOpen) selectNote(toOpen);
  else updateCrumb();

  if (await api.selfTest()) runSelfTest();
})();

// Programmatic check that the formatting pipeline applies (SN_SELFTEST=1).
async function runSelfTest() {
  try {
    currentNoteId = null; // detach so the shutdown flush can't overwrite a real note
    suppressTextChange = true;
    quill.setContents([{ insert: 'Hello world\n' }], 'silent');
    quill.setSelection(0, 5, 'silent');
    quill.format('bold', true, 'silent');
    quill.format('color', '#ff0000', 'silent');
    quill.format('size', '24px', 'silent');
    quill.format('font', 'serif', 'silent');
    const f = quill.getFormat(0, 5);
    const ok = f.bold === true && f.color === '#ff0000' && f.size === '24px' && f.font === 'serif';
    const mdOk = deltaToMarkdown({ ops: [{ insert: 'hi' }, { insert: '\n', attributes: { header: 1 } }] }).startsWith('# hi');
    const htmlOk = /<strong>3<\/strong>/.test(mdToHtml('**3**'));
    let convOk = false;
    try { const c = quill.clipboard.convert({ html: '<h1>Hi</h1><p>x</p>' }); convOk = Array.isArray(c.ops) && c.ops.length > 0; } catch { convOk = false; }

    // background highlight + code-block + block highlight
    quill.setContents([{ insert: 'hi\ncode\n' }], 'silent');
    quill.formatText(0, 2, 'background', '#ffeb3b', 'silent');
    const bgOk = quill.getFormat(0, 2).background === '#ffeb3b';
    quill.formatLine(3, 1, 'code-block', true, 'silent');
    const codeOk = /ql-code-block/.test(quill.root.innerHTML);
    quill.formatLine(0, 1, 'lineBackground', 'yellow', 'silent');
    const lineBgOk = /hlblock-yellow/.test(quill.root.innerHTML);

    // memory round-trip (add -> read -> delete, leaving no residue)
    let memOk = false;
    try {
      const tag = 'selftest-fact-' + Math.floor(performance.now());
      const added = await api.ai.addMemory(tag);
      const idx = added.findIndex((x) => x.text === tag);
      const present = idx >= 0;
      const afterDel = await api.ai.deleteMemory(idx);
      memOk = present && !afterDel.some((x) => x.text === tag);
    } catch (e) { memOk = 'err:' + String(e); }

    api.report(JSON.stringify({ ok, mdOk, htmlOk, convOk, memOk, bgOk, codeOk, lineBgOk }));
  } catch (err) {
    api.report(JSON.stringify({ ok: false, error: String(err) }));
  } finally {
    suppressTextChange = false;
  }
}
