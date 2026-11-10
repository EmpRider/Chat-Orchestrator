const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', Object.freeze({
  extensionAction: (action, tabId, nonce) => ipcRenderer.invoke('bridge:extensionAction', action, tabId, nonce),
  getAgentSettings: () => ipcRenderer.invoke('bridge:getAgentSettings'),
  previewPrompt: (input) => ipcRenderer.invoke('bridge:previewPrompt', input),
  getDefaultAgentSettings: () => ipcRenderer.invoke('bridge:getDefaultAgentSettings'),
  saveAgentSettings: (settings) => ipcRenderer.invoke('bridge:saveAgentSettings', settings),
  status: () => ipcRenderer.invoke('bridge:status'),
  configurePort: (port) => ipcRenderer.invoke('bridge:configurePort', port),
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('bridge:setMinimizeToTray', enabled),
  configurePrivateCoordination: (enabled) => ipcRenderer.invoke('bridge:configurePrivateCoordination', enabled),
  copyUrl: () => ipcRenderer.invoke('bridge:copyUrl'),
  configureNgrok: (domain, ngrokAuthtoken) => ipcRenderer.invoke('bridge:configureNgrok', domain, ngrokAuthtoken),
  start: () => ipcRenderer.invoke('bridge:start'),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('bridge:state', listener);
    return () => ipcRenderer.removeListener('bridge:state', listener);
  },
}));