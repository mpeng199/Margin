// Bridge between the web app and the native shell. Kept tiny on purpose.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('margin', {
  accent: ipcRenderer.sendSync('margin:accent'),
  onNavigate: (cb) => ipcRenderer.on('margin:navigate', (_e, path) => cb(path)),
  onCapture: (cb) => ipcRenderer.on('margin:capture', () => cb()),
  closeCapture: () => ipcRenderer.send('margin:close-capture'),
  openExternal: (url) => ipcRenderer.send('margin:open-external', url),
});
