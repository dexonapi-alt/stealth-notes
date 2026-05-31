const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell } = require('electron');
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
    backgroundColor: '#eef1fb',
    title: 'Stealth Notes',
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
}

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

  // Global hotkey to flip stealth even when the window isn't focused.
  globalShortcut.register('CommandOrControl+Shift+H', () => toggleStealth());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
