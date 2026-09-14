'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only surface the page gets. No Node, no arbitrary IPC.
contextBridge.exposeInMainWorld('kqs', {
  startInstall: () => ipcRenderer.invoke('install:start'),
  startUninstall: (deleteData) => ipcRenderer.invoke('uninstall:start', deleteData),
  openPanel: (url) => ipcRenderer.invoke('panel:open', url),
  onLine: (cb) => ipcRenderer.on('install:line', (_e, line) => cb(line)),
  onDone: (cb) => ipcRenderer.on('install:done', (_e, result) => cb(result)),
  onLogPath: (cb) => ipcRenderer.on('install:logpath', (_e, p) => cb(p)),
});
