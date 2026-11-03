const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', Object.freeze({
  status: () => ipcRenderer.invoke('bridge:status'),
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('bridge:setMinimizeToTray', enabled),
  showToken: () => ipcRenderer.invoke('bridge:showToken'),
  copyToken: () => ipcRenderer.invoke('bridge:copyToken'),
  copyUrl: () => ipcRenderer.invoke('bridge:copyUrl'),
  configureNgrok: (domain, ngrokAuthtoken) => ipcRenderer.invoke('bridge:configureNgrok', domain, ngrokAuthtoken),
  importToken: () => ipcRenderer.invoke('bridge:importToken'),
  start: () => ipcRenderer.invoke('bridge:start'),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('bridge:state', listener);
    return () => ipcRenderer.removeListener('bridge:state', listener);
  },
}));
