const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const agent = require('./agent');

// ---------------------------------------------------------------------------
// Storage: everything lives under the per-user app data folder so notes are
// private to the OS account and never sit in a synced/shared location.
//   <userData>/data.json          -> the folder/note tree
//   <userData>/contents/<id>.json -> each note's Quill Delta
// ---------------------------------------------------------------------------
const DATA_DIR = app.getPath('userData');
const TREE_FILE = path.join(DATA_DIR, 'data.json');
const CONTENT_DIR = path.join(DATA_DIR, 'contents');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

function ensureStorage() {
  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
  if (!fs.existsSync(TREE_FILE)) {
    fs.writeFileSync(TREE_FILE, JSON.stringify({ tree: [] }, null, 2));
  }
}

function readTree() {
  try {
    return JSON.parse(fs.readFileSync(TREE_FILE, 'utf8'));
  } catch {
    return { tree: [] };
  }
}

function writeTree(data) {
  fs.writeFileSync(TREE_FILE, JSON.stringify(data, null, 2));
}

function noteFile(id) {
  // guard against path traversal in ids
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(CONTENT_DIR, safe + '.json');
}

let mainWindow = null;
let tray = null;
let dialogOpen = false;   // suppress auto-pill while our own file dialogs are open
let autoPill = true;      // shrink to the floating pill when focus leaves the app
let trayAutoPillItem = null;

function setAutoPill(v) {
  autoPill = !!v;
  if (trayAutoPillItem) trayAutoPillItem.checked = autoPill;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('autopill:changed', autoPill);
}

function createTray() {
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo.png'));
    if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Stealth Notes');
    const menu = Menu.buildFromTemplate([
      { label: 'Show / Hide', click: () => { if (!mainWindow) return; mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); } },
      { label: 'Compact pill', click: () => toggleCompact() },
      { id: 'autopill', label: 'Pill when I switch away (Alt+Tab)', type: 'checkbox', checked: autoPill, click: (item) => setAutoPill(item.checked) },
      { label: 'Toggle capture invisibility', click: () => toggleStealth() },
      { type: 'separator' },
      { label: 'Quit Stealth Notes', click: () => { app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    trayAutoPillItem = menu.getMenuItemById('autopill');
    tray.on('click', () => { if (!mainWindow) return; if (mainWindow.isVisible()) mainWindow.focus(); else mainWindow.show(); });
  } catch {}
}
// Hidden from capture by default. SN_NO_STEALTH=1 starts visible (used only for
// local UI screenshots, since capture protection makes screenshots come out black).
let stealthOn = process.env.SN_NO_STEALTH !== '1';

function applyStealth(win, on) {
  // On Windows 10 2004+ Electron maps setContentProtection(true) to
  // SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE): the window keeps
  // rendering normally on your screen but is excluded from Zoom / Google Meet /
  // OBS / PrintScreen captures (it shows up as a black/empty region to them).
  win.setContentProtection(on);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#00000000', // transparent base; CSS paints the solid theme
    transparent: true,            // enables the "invisible overlay" theme
    skipTaskbar: true,            // run discreetly — no taskbar button (use tray/pill)
    title: 'Stealth Notes',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    frame: false,           // Notion-style: no OS title bar, we draw our own header
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  applyStealth(mainWindow, stealthOn);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('stealth:changed', stealthOn);
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('win:state', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:state', false));

  // Keep the compact pill floating on top when focus moves elsewhere (Alt+Tab):
  // Windows can demote a topmost window when another app takes the foreground.
  mainWindow.on('blur', () => {
    if (!mainWindow || mainWindow.isDestroyed() || dialogOpen) return;
    if (compact) {
      // already a pill — re-assert topmost (Windows can demote it on focus change)
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.moveTop();
    } else if (autoPill) {
      // switching away (Alt+Tab) → collapse to the floating pill so notes stay visible
      enterCompact();
    }
  });
}

// ---- IPC: custom window controls (frameless) ----
ipcMain.handle('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('win:maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('win:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('win:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()));

// ---- Compact "floating pill" mode (discreet during calls) ----
let savedState = null;
let compact = false;
function enterCompact() {
  if (!mainWindow || compact) return;
  savedState = { bounds: mainWindow.getBounds(), max: mainWindow.isMaximized() };
  if (savedState.max) mainWindow.unmaximize();
  const W = 176, H = 48;
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = disp.workArea;
  mainWindow.setMinimumSize(W, H);
  mainWindow.setResizable(false);
  mainWindow.setBounds({ x: Math.round(area.x + (area.width - W) / 2), y: area.y + 8, width: W, height: H });
  mainWindow.setAlwaysOnTop(true, 'screen-saver'); // float above call windows
  compact = true;
  mainWindow.webContents.send('compact:changed', true);
}
function exitCompact() {
  if (!mainWindow || !compact) return;
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setMinimumSize(720, 480);
  mainWindow.setResizable(true);
  if (savedState) { if (savedState.max) mainWindow.maximize(); else mainWindow.setBounds(savedState.bounds); }
  compact = false;
  mainWindow.webContents.send('compact:changed', false);
  mainWindow.focus();
}
function toggleCompact() { if (compact) exitCompact(); else enterCompact(); }
ipcMain.handle('win:shrink', enterCompact);
ipcMain.handle('win:expand', exitCompact);
ipcMain.handle('win:getAutoPill', () => autoPill);
ipcMain.handle('win:setAutoPill', (_e, v) => { setAutoPill(v); return autoPill; });

// ---- IPC: stealth toggle ----
function toggleStealth() {
  stealthOn = !stealthOn;
  if (mainWindow) {
    applyStealth(mainWindow, stealthOn);
    mainWindow.webContents.send('stealth:changed', stealthOn);
  }
  return stealthOn;
}
ipcMain.handle('stealth:toggle', () => toggleStealth());
ipcMain.handle('stealth:get', () => stealthOn);

// ---- IPC: tree ----
ipcMain.handle('tree:get', () => readTree());
ipcMain.handle('tree:save', (_e, data) => {
  writeTree(data);
  return true;
});

// ---- IPC: note contents ----
ipcMain.handle('note:get', (_e, id) => {
  try {
    return JSON.parse(fs.readFileSync(noteFile(id), 'utf8'));
  } catch {
    return null; // new / empty note
  }
});
ipcMain.handle('note:save', (_e, { id, delta }) => {
  fs.writeFileSync(noteFile(id), JSON.stringify(delta));
  return true;
});
ipcMain.handle('note:delete', (_e, id) => {
  try { fs.unlinkSync(noteFile(id)); } catch {}
  return true;
});

// ---- IPC: user profile ----
ipcMain.handle('app:getUser', () => {
  let name = 'Local user';
  try { name = os.userInfo().username || name; } catch {}
  return { name };
});

// ---- IPC: reveal the notes storage folder ----
ipcMain.handle('app:openData', () => shell.openPath(DATA_DIR));

// ---- IPC: open a link in the user's default browser ----
ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});

// ---- IPC: export current note to a file (native save dialog) ----
ipcMain.handle('export:save', async (_e, { defaultName, content, ext, filterName }) => {
  dialogOpen = true;
  try {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export note',
      defaultPath: defaultName,
      filters: [
        { name: filterName, extensions: [ext] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, content, 'utf8');
    return res.filePath;
  } finally { dialogOpen = false; }
});

// ---- PDF import: extract text into a note (best-effort headings/paragraphs) ----
async function parsePdfToDelta(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true }).promise;
  const ops = [];
  const pushLine = (text, type) => {
    if (!text) return;
    ops.push({ insert: text });
    if (type === 'h1') ops.push({ insert: '\n', attributes: { header: 1 } });
    else if (type === 'h2') ops.push({ insert: '\n', attributes: { header: 2 } });
    else ops.push({ insert: '\n' });
  };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map(); // group text items into lines by y
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const y = Math.round(it.transform[5]);
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      let r = rows.get(y);
      if (!r) { r = { items: [], size: 0 }; rows.set(y, r); }
      r.items.push(it);
      if (size > r.size) r.size = size;
    }
    const ys = [...rows.keys()].sort((a, b) => b - a); // top -> bottom
    const sizes = ys.map((y) => rows.get(y).size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)] || 10;
    let prevY = null;
    for (const y of ys) {
      const r = rows.get(y);
      const text = r.items.sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join('').replace(/\s+/g, ' ').trim();
      if (!text) { prevY = y; continue; }
      if (prevY !== null && (prevY - y) > median * 1.9) ops.push({ insert: '\n' }); // paragraph gap
      let type = 'p';
      if (r.size > median * 1.55) type = 'h1';
      else if (r.size > median * 1.22) type = 'h2';
      pushLine(text, type);
      prevY = y;
    }
    if (p < doc.numPages) ops.push({ insert: '\n' });
  }
  if (!ops.length) ops.push({ insert: '\n' });
  return { ops };
}

// Best-effort: pull table cell background fills (w:shd w:fill) out of the docx
// XML so imported tables keep their colors. Returns tables[t][row][col] = '#hex'|null.
function extractTableFills(xml) {
  const tables = [];
  const tblRe = /<w:tbl[\s>][\s\S]*?<\/w:tbl>/g;
  let mt;
  while ((mt = tblRe.exec(xml))) {
    const rows = [];
    const trRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
    let mr;
    while ((mr = trRe.exec(mt[0]))) {
      const cells = [];
      const tcRe = /<w:tc[\s>][\s\S]*?<\/w:tc>/g;
      let mc;
      while ((mc = tcRe.exec(mr[0]))) {
        const shd = /<w:shd[^>]*w:fill="([0-9A-Fa-f]{6})"/.exec(mc[0]);
        let fill = shd ? shd[1] : null;
        if (fill && /^[fF]{6}$/.test(fill)) fill = null; // white == no fill
        cells.push(fill ? '#' + fill : null);
      }
      rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

// Text/code file extensions we import as a line-numbered code block.
const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'swift', 'scala', 'dart', 'lua', 'r', 'pl', 'sh', 'bash',
  'zsh', 'ps1', 'sql', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'md', 'markdown', 'txt', 'log', 'csv', 'env'
]);

// Convert a file at a path into note data (renderer builds the final note).
async function importFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  const extKey = ext.replace(/^\./, '');
  const base = path.basename(p);
  if (ext === '.pdf') {
    const delta = await parsePdfToDelta(fs.readFileSync(p));
    return { kind: 'pdf', name: base.replace(/\.pdf$/i, ''), delta };
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.convertToHtml({ path: p });
    let tableFills = [];
    try {
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(fs.readFileSync(p));
      const xmlFile = zip.file('word/document.xml');
      if (xmlFile) tableFills = extractTableFills(await xmlFile.async('string'));
    } catch {}
    return { kind: 'docx', name: base.replace(/\.docx$/i, ''), html: result.value || '', tableFills };
  }
  if (CODE_EXTS.has(extKey) || !ext) {
    try {
      if (fs.statSync(p).size > 5 * 1024 * 1024) return { error: 'File too large (max 5 MB)' };
    } catch {}
    const text = fs.readFileSync(p, 'utf8');
    return { kind: 'code', name: base, text }; // keep the extension in the note name
  }
  return { error: 'Unsupported file type' };
}
ipcMain.handle('import:path', async (_e, p) => {
  try { return await importFromPath(p); }
  catch (e) { return { error: String((e && e.message) || e) }; }
});
ipcMain.handle('import:browse', async () => {
  dialogOpen = true;
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a file',
      filters: [
        { name: 'Notes & code', extensions: ['pdf', 'docx', 'txt', 'md', 'js', 'ts', 'jsx', 'tsx', 'py', 'json', 'html', 'css', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'yml', 'yaml', 'sql', 'xml'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths;
  } finally { dialogOpen = false; }
});

// ---- IPC: self-test (only meaningful when SN_SELFTEST=1) ----
ipcMain.handle('selftest:enabled', () => process.env.SN_SELFTEST === '1');
ipcMain.handle('selftest:report', (_e, msg) => {
  console.log('SELFTEST ' + msg);
  setTimeout(() => app.quit(), 200);
  return true;
});

app.whenReady().then(() => {
  ensureStorage();
  agent.init({ TREE_FILE, CONTENT_DIR, SETTINGS_FILE, MEMORY_FILE, getWin: () => mainWindow }, ipcMain);
  createWindow();
  createTray();

  // Global hotkey to flip stealth even when the window isn't focused.
  globalShortcut.register('CommandOrControl+Shift+H', () => toggleStealth());
  globalShortcut.register('CommandOrControl+Shift+M', () => toggleCompact());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
