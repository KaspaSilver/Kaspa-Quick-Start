'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { runInstall, runUninstall } = require('./installer');

function createWindow() {
  const win = new BrowserWindow({
    width: 620,
    height: 640,
    resizable: false,
    title: 'Kaspa Quick Start',
    backgroundColor: '#0b0f0e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  const win = createWindow();

  const stream = {
    onLine: (line) => win.webContents.send('install:line', line),
    onDone: (result) => win.webContents.send('install:done', result),
  };

  ipcMain.handle('install:start', (_e, port) => {
    const r = runInstall({ port, ...stream });
    win.webContents.send('install:logpath', r && r.logFile);
    return true;
  });
  ipcMain.handle('uninstall:start', (_e, deleteData) => {
    const r = runUninstall({ deleteData: Boolean(deleteData), ...stream });
    win.webContents.send('install:logpath', r && r.logFile);
    return true;
  });

  ipcMain.handle('panel:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\/localhost:\d+/.test(url)) shell.openExternal(url);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
