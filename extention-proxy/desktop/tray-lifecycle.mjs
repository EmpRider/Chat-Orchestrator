// Pure Electron window/tray policy, injectable for deterministic lifecycle tests.
export const DEFAULT_MINIMIZE_TO_TRAY = true;

export function minimizeToTrayPreference(value) {
  return typeof value === 'boolean' ? value : DEFAULT_MINIMIZE_TO_TRAY;
}

export function installWindowCloseBehavior(window, { shouldMinimize, trayAvailable, isExiting }) {
  window.on('close', (event) => {
    if (!isExiting() && trayAvailable() && shouldMinimize()) {
      event.preventDefault();
      window.hide();
    }
  });
}

export function createDesktopTray({ Tray, Menu, icon, restore, exit }) {
  const tray = new Tray(icon);
  tray.setToolTip('Chat Orchestrator — local proxy');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: restore },
    { type: 'separator' },
    { label: 'Exit', click: exit },
  ]));
  tray.on('click', restore);
  tray.on('double-click', restore);
  return tray;
}
