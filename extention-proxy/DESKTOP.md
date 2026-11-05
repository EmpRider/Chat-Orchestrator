# Chat Orchestrator desktop app (Windows)

The desktop app runs the MCP server locally and starts a dedicated ngrok tunnel. It does not change the existing AgentBridge tunnel or its ngrok configuration.

## Install from a GitHub release

Download both files from [Chat Orchestrator Releases](https://github.com/EmpRider/Chat-Orchestrator/releases):

- `Chat-Orchestrator-0.1.2-windows-x64-portable.exe`: portable Windows desktop app.
- `Chat-Orchestrator-0.1.2-extension.zip`: Chrome/Edge extension. Extract it first; the extracted directory must contain `manifest.json` at its root.

The executable is not code-signed, so Windows may show an unknown-publisher warning. You must install the [ngrok CLI](https://ngrok.com/download/windows) separately and ensure `ngrok` is on `PATH`.

## Connect

1. Start the desktop app. It launches the local MCP server at `127.0.0.1:8787`.
2. Enter your **dedicated ngrok hostname** and its matching **ngrok authtoken**. Click **Save & Connect**. The authtoken is encrypted in your Windows user profile; it is never included in the executable or ngrok's command-line arguments.
3. In Chrome/Edge, open the extensions page, enable Developer mode, and choose **Load unpacked**. Select the folder extracted from the extension ZIP.
4. In the extension popup, set `ws://127.0.0.1:8787/bridge` (or this profile's port) and paste the desktop **Extension-only credential** — not the MCP connector token. Click **Save connection & reconnect**. The app should show **Extension connected**, and the popup should report **Settings synced**.
5. When the ngrok status is verified, click **Copy Connector URL** in the desktop app and configure it in ChatGPT. The URL has the form `https://YOUR-DOMAIN/mcp?token=YOUR-BRIDGE-TOKEN`. Keep it private.

The desktop app reads its own credential-free ngrok configuration, so your existing AgentBridge account/domain can remain online independently.

## Extension settings and editable system prompts

Open the desktop **Extension settings & system prompts** panel. It controls the
extension automation toggle, worker tab cap, hourly task cap, timeout and every
application-managed system prompt: default worker, BA, PM, TL, Specialist,
Council A–E and BA Watchdog. Select a role, edit its prompt and choose **Save
extension settings**. Reset buttons affect only the draft until Save.
Settings are stored in this profile's `settings.json` and sent to the extension
when it connects/reconnects or when changed. A revision indicator appears after
extension acknowledgement. Legacy shared-MCP-token connections cannot receive
prompts; no WebSocket message can write proxy settings. Auto-close remains held
until verified Saga closure. The extension popup shows only URL/token and status.

**Advanced browser actions** replaces the popup's legacy orchestrator-tab
selection, diagnostics, and safe legacy-worker closure. Diagnose only your own
chats, since diagnostic responses can include page text.

## Independent desktop profiles

Start another copy with `--profile=work`, then select another port in **Tunnel
settings** before starting. Each profile has distinct credentials, settings,
prompts and Ngrok configuration. Use a separate browser profile/extension and
its own extension-only token for each proxy. The default profile keeps port `8787`.

## Background operation and system tray

**Minimize to system tray when closing** is enabled by default. When checked,
the window's Close (X) button hides the interface; the MCP server, ngrok tunnel,
and active WebSocket clients continue running. Click the tray icon, double-click
it, or choose **Open** in its context menu to restore the window.

Uncheck the setting to make Close (X) fully exit the application and shut down
only its owned background processes. The choice is saved to `settings.json`
in the Windows user-data directory and takes effect immediately. The tray
context menu's **Exit** action always performs the same graceful shutdown,
regardless of the checkbox. Only one application instance can run at a time;
starting it again restores the existing window.

If Windows tray creation fails, the application defaults to normal exit instead
of leaving an invisible background process. Do not run portable and source
apps simultaneously with the same profile/port. Distinct named profiles can
run concurrently on different ports.

## Build and test from source

```powershell
cd extention-proxy
npm ci
npm test
npm run dist:win
```

The portable executable is generated in `dist/`. The CI workflow builds the same Windows target and packages the extension as a root-manifest ZIP.

The new desktop theme is compact black with locally bundled **Icons8** assets.
The app displays attribution ("Icons by Icons8") and the desktop sources include
the original icon URLs in `desktop/assets/ATTRIBUTION.md`.

### Windows tray integration smoke test

The included `test/electron-tray-runtime.mjs` runs the real Electron app using
an isolated test user-data directory and port. Execute modes `first`,
`second`, then `tray-exit` in order with the same directory, after clearing
`ELECTRON_RUN_AS_NODE` (which VS Code may set). The tests check visual icon
loading, theme geometry, close-to-tray, an active WebSocket, second-instance
restoration, checkbox persistence, and graceful service shutdown.

For development:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CHAT_ORCH_DIAGNOSTICS = '1'
npm run desktop
```

Diagnostics print selected, redacted ngrok lifecycle messages. Do not paste your ngrok authtoken or full connector URL into terminal commands or public issue reports.
