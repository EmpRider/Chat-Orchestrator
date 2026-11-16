import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDesktopTray, installWindowCloseBehavior, minimizeToTrayPreference } from '../desktop/tray-lifecycle.mjs';

test('tray setting restores saved enable/disable preference', () => {
  assert.equal(minimizeToTrayPreference(undefined), true);
  assert.equal(minimizeToTrayPreference(null), true);
  assert.equal(minimizeToTrayPreference('false'), true);
  assert.equal(minimizeToTrayPreference(false), false);
  assert.equal(minimizeToTrayPreference(true), true);
  const persisted = JSON.parse(JSON.stringify({ domain: 'https://example.ngrok.app', minimizeToTray: false }));
  assert.equal(minimizeToTrayPreference(persisted.minimizeToTray), false);
});

test('X uses tray setting; disabling it requests confirmation instead of silently quitting', () => {
  let handler;
  let hidden = 0;
  let stopped = 0;
  let enabled = true;
  let available = true;
  let exiting = false;
  let warningCount = 0;
  let exitRequests = 0;
  const win = { on(name, fn) { assert.equal(name, 'close'); handler = fn; }, hide() { hidden++; } };
  installWindowCloseBehavior(win, {
    shouldMinimize: () => enabled,
    trayAvailable: () => available,
    isExiting: () => exiting,
    onTrayUnavailable: () => warningCount++,
    requestExit: () => exitRequests++,
  });
  const close = () => {
    let prevented = false;
    handler({ preventDefault() { prevented = true; } });
    if (!prevented) stopped++;
    return prevented;
  };
  assert.equal(close(), true);
  assert.equal(hidden, 1);
  assert.equal(stopped, 0);
  enabled = false;
  assert.equal(close(), true, 'exit confirmation must occur before shutdown');
  assert.equal(exitRequests, 1);
  assert.equal(stopped, 0);
  assert.equal(hidden, 1, 'disabled preference must not hide the window');
  enabled = true;
  available = false;
  assert.equal(close(), true, 'unavailable tray must not trigger implicit Exit');
  assert.equal(warningCount, 1);
  assert.equal(stopped, 0);
  available = true;
  exiting = true;
  assert.equal(close(), false, 'application quit must never be intercepted');
});

test('tray Open/click/double-click restores; tray Exit invokes full app exit', () => {
  let events = {};
  let restored = 0;
  let exited = 0;
  let menu;
  class FakeTray {
    constructor(icon) { assert.equal(icon, 'valid-icons8-app-icon'); }
    setToolTip(value) { assert.match(value, /Chat Orchestrator/); }
    setContextMenu(value) { menu = value; }
    on(name, callback) { events[name] = callback; }
  }
  const tray = createDesktopTray({
    Tray: FakeTray,
    Menu: { buildFromTemplate: (items) => items },
    icon: 'valid-icons8-app-icon',
    restore: () => restored++,
    exit: () => exited++,
  });
  assert.ok(tray);
  assert.deepEqual(menu.map(({ label, type }) => label || type), ['Open', 'separator', 'Exit']);
  events.click();
  events['double-click']();
  menu[0].click();
  assert.equal(restored, 3);
  menu[2].click();
  assert.equal(exited, 1);
});
