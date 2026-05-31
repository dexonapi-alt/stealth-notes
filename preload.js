const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // stealth / capture exclusion
  toggleStealth: () => ipcRenderer.invoke('stealth:toggle'),
  getStealth: () => ipcRenderer.invoke('stealth:get'),
  onStealthChanged: (cb) =>
    ipcRenderer.on('stealth:changed', (_e, on) => cb(on)),

  // folder/note tree
  getTree: () => ipcRenderer.invoke('tree:get'),
  saveTree: (data) => ipcRenderer.invoke('tree:save', data),

  // note contents (Quill Delta)
  getNote: (id) => ipcRenderer.invoke('note:get', id),
  saveNote: (id, delta) => ipcRenderer.invoke('note:save', { id, delta }),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', id),

  // profile / export
  getUser: () => ipcRenderer.invoke('app:getUser'),
  openDataFolder: () => ipcRenderer.invoke('app:openData'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  exportFile: (payload) => ipcRenderer.invoke('export:save', payload),

  // AI assistant
  ai: {
    send: (text, opts) => ipcRenderer.invoke('ai:send', { text, opts }),
    stop: () => ipcRenderer.invoke('ai:stop'),
    setContext: (ctx) => ipcRenderer.invoke('ai:context', ctx),
    clear: () => ipcRenderer.invoke('ai:clear'),
    getSettings: () => ipcRenderer.invoke('ai:getSettings'),
    setSettings: (s) => ipcRenderer.invoke('ai:setSettings', s),
    onUpdate: (cb) => ipcRenderer.on('ai:update', (_e, m) => cb(m)),
    getMemory: () => ipcRenderer.invoke('memory:get'),
    addMemory: (text) => ipcRenderer.invoke('memory:add', text),
    deleteMemory: (index) => ipcRenderer.invoke('memory:delete', index),
    clearMemory: () => ipcRenderer.invoke('memory:clear'),
    onMemoryChanged: (cb) => ipcRenderer.on('memory:changed', () => cb())
  },
  onWorkspaceChanged: (cb) => ipcRenderer.on('workspace:changed', () => cb()),

  // self-test (used only when SN_SELFTEST=1)
  selfTest: () => ipcRenderer.invoke('selftest:enabled'),
  report: (msg) => ipcRenderer.invoke('selftest:report', msg)
});
