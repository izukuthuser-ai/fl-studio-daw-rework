// LoopForge Studio — Electron main process
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let win = null;
let allowClose = false;
let pendingOpen = null;

function projectArg(argv) {
  return argv.slice(1).find((a) => /\.lfproj$/i.test(a) && fs.existsSync(a)) || null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = projectArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) win.webContents.send('app:open-file', f);
    }
  });
}

app.on('open-file', (e, p) => {
  e.preventDefault();
  if (win) win.webContents.send('app:open-file', p);
  else pendingOpen = p;
});

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#171b1f',
    title: 'LoopForge Studio',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // DevTools on Ctrl+Shift+Alt+I (F12 is reserved for "close all windows")
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.alt && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('app:request-close');
  });
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  pendingOpen = pendingOpen || projectArg(process.argv);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------- IPC ----------------
const AUDIO_EXT = /\.(wav|mp3|ogg|flac|aif|aiff|m4a|opus|webm)$/i;
// The renderer may only touch the kinds of files LoopForge actually uses.
const READABLE = /\.(wav|mp3|ogg|flac|aif|aiff|m4a|opus|webm|lfproj|mid|midi|json)$/i;
const WRITABLE = /\.(lfproj|wav|mid|midi)$/i;

ipcMain.handle('dlg:open', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title,
    filters: opts.filters,
    properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) }));
});

ipcMain.handle('dlg:save', async (_e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, typeof opts.data === 'string' ? opts.data : Buffer.from(opts.data));
  return r.filePath;
});

ipcMain.handle('fs:write', async (_e, p, data) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !WRITABLE.test(p)) return false;
  try {
    fs.writeFileSync(p, typeof data === 'string' ? data : Buffer.from(data));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:read', async (_e, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !READABLE.test(p)) throw new Error('Access denied');
  return new Uint8Array(fs.readFileSync(p));
});

ipcMain.handle('dlg:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('fs:listAudio', async (_e, dir) => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return [];
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6 || out.length > 5000) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (AUDIO_EXT.test(ent.name)) out.push({ path: full, name: ent.name, rel: path.relative(dir, full) });
    }
  };
  walk(dir, 0);
  return out;
});

ipcMain.handle('app:launch-file', async () => {
  const f = pendingOpen;
  pendingOpen = null;
  return f;
});

ipcMain.on('app:confirm-close', () => {
  allowClose = true;
  if (win) win.close();
});

ipcMain.on('app:version', (e) => {
  e.returnValue = app.getVersion();
});

ipcMain.on('app:title', (_e, t) => {
  if (win) win.setTitle(t);
});

const autosavePath = () => path.join(app.getPath('userData'), 'autosave.lfproj.json');
ipcMain.handle('app:autosave-write', async (_e, data) => {
  try {
    fs.writeFileSync(autosavePath(), data);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('app:autosave-read', async () => {
  try {
    return fs.readFileSync(autosavePath(), 'utf8');
  } catch {
    return null;
  }
});
