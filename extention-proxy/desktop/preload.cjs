const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', Object.freeze({
  extensionAction: (action, tabId, nonce, browserSessionId) =>
    ipcRenderer.invoke('bridge:extensionAction', action, tabId, nonce, browserSessionId),
  getAgentSettings: () => ipcRenderer.invoke('bridge:getAgentSettings'),
  previewPrompt: (input) => ipcRenderer.invoke('bridge:previewPrompt', input),
  getDefaultAgentSettings: () => ipcRenderer.invoke('bridge:getDefaultAgentSettings'),
  saveAgentSettings: (settings) => ipcRenderer.invoke('bridge:saveAgentSettings', settings),
  status: () => ipcRenderer.invoke('bridge:status'),
  openJournalFolder:()=>ipcRenderer.invoke('bridge:openJournalFolder'),
  recoverEmptyJournalLock:(snapshot)=>ipcRenderer.invoke('bridge:recoverEmptyJournalLock',snapshot),
  listAgentClosures:()=>ipcRenderer.invoke('bridge:listAgentClosures'),
  resolveAgentClosure:(id,choice)=>ipcRenderer.invoke('bridge:resolveAgentClosure',id,choice),
  setCompletionStatus:(taskId,status,browserSessionId)=>
    ipcRenderer.invoke('bridge:setCompletionStatus',taskId,status,browserSessionId),
  recoverQueueBatch:(tabId,browserSessionId,batchId,action,reason)=>
    ipcRenderer.invoke('bridge:recoverQueueBatch',tabId,browserSessionId,batchId,action,reason),
  focusQueueManager:(tabId,browserSessionId)=>
    ipcRenderer.invoke('bridge:focusQueueManager',tabId,browserSessionId),
  configureManagedBrowser:(browser,executablePath)=>
    ipcRenderer.invoke('bridge:configureManagedBrowser',browser,executablePath),
  chooseChromiumExecutable:()=>ipcRenderer.invoke('bridge:chooseChromiumExecutable'),
  verifyManagedBrowser:()=>ipcRenderer.invoke('bridge:verifyManagedBrowser'),
  finishOnboarding:()=>ipcRenderer.invoke('bridge:finishOnboarding'),
  checkUpdates:()=>ipcRenderer.invoke('bridge:checkUpdates'),
  requestUpdate:()=>ipcRenderer.invoke('bridge:requestUpdate'),
  cancelUpdate:()=>ipcRenderer.invoke('bridge:cancelUpdate'),
  openManagedBrowserExtensions:()=>ipcRenderer.invoke('bridge:openManagedBrowserExtensions'),
  copyExtensionPath:()=>ipcRenderer.invoke('bridge:copyExtensionPath'),
  copyProfileToken:()=>ipcRenderer.invoke('bridge:copyProfileToken'),
  copyPublicMcpToken:()=>ipcRenderer.invoke('bridge:copyPublicMcpToken'),
  setAutoStartWindows:(enabled)=>ipcRenderer.invoke('bridge:setAutoStartWindows',enabled),
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
  onOpenConnectionSetup: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('bridge:openConnectionSetup',listener);
    return () => ipcRenderer.removeListener('bridge:openConnectionSetup',listener);
  },
}));