const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', Object.freeze({
  status: () => ipcRenderer.invoke('bridge:status'),
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('bridge:setMinimizeToTray', enabled),
  configurePrivateCoordination: (enabled) => ipcRenderer.invoke('bridge:configurePrivateCoordination', enabled),
  showToken: () => ipcRenderer.invoke('bridge:showToken'),
  copyToken: () => ipcRenderer.invoke('bridge:copyToken'),
  copyExtensionToken: () => ipcRenderer.invoke('bridge:copyExtensionToken'),
  copyUrl: () => ipcRenderer.invoke('bridge:copyUrl'),
  configureNgrok: (domain, ngrokAuthtoken) => ipcRenderer.invoke('bridge:configureNgrok', domain, ngrokAuthtoken),
  importToken: () => ipcRenderer.invoke('bridge:importToken'),
  enrollPrincipal: (input) => ipcRenderer.invoke('bridge:enrollPrincipal', input),
  listPrincipals: () => ipcRenderer.invoke('bridge:listPrincipals'),
  revokePrincipal: (id) => ipcRenderer.invoke('bridge:revokePrincipal', id),
  copyScopedUrl: (token) => ipcRenderer.invoke('bridge:copyScopedUrl', token),
  start: () => ipcRenderer.invoke('bridge:start'),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('bridge:state', listener);
    return () => ipcRenderer.removeListener('bridge:state', listener);
  },
}));
