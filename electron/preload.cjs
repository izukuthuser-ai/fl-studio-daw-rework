// Exposes a narrow, safe API to the renderer.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  platform: process.platform,
  version: ipcRenderer.sendSync('app:version'),
  openFile: (opts) => ipcRenderer.invoke('dlg:open', opts),
  saveFile: (opts) => ipcRenderer.invoke('dlg:save', opts),
  writeFile: (p, data) => ipcRenderer.invoke('fs:write', p, data),
  readFile: (p) => ipcRenderer.invoke('fs:read', p),
  pickFolder: () => ipcRenderer.invoke('dlg:folder'),
  listAudio: (dir) => ipcRenderer.invoke('fs:listAudio', dir),
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path || ''),
  onRequestClose: (cb) => ipcRenderer.on('app:request-close', () => cb()),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),
  getLaunchFile: () => ipcRenderer.invoke('app:launch-file'),
  onOpenFile: (cb) => ipcRenderer.on('app:open-file', (_e, p) => cb(p)),
  setTitle: (t) => ipcRenderer.send('app:title', t),
  autosaveWrite: (data) => ipcRenderer.invoke('app:autosave-write', data),
  autosaveRead: () => ipcRenderer.invoke('app:autosave-read'),
});
