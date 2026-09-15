'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { runInstall, runUninstall } = require('./installer');

let win = null;

function createWindow() {
  win = new BrowserWindow({
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

// An install keeps running (and its log keeps being tailed) even if the user
// closes the window -- the elevated script is independent of us. So a stray
// progress line can arrive after the window is gone; sending to a destroyed
// window throws "Object has been destroyed" and crashes the main process. Always
// aim at the current, live window and drop the message if there isn't one.
function send(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  createWindow();

  const stream = {
    onLine: (line) => send('install:line', line),
    onDone: (result) => send('install:done', result),
  };

  ipcMain.handle('install:start', (_e, port) => {
    const r = runInstall({ port, ...stream });
    send('install:logpath', r && r.logFile);
    return true;
  });
  ipcMain.handle('uninstall:start', (_e, deleteData) => {
    const r = runUninstall({ deleteData: Boolean(deleteData), ...stream });
    send('install:logpath', r && r.logFile);
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
