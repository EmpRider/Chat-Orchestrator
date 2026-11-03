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
4. In the extension popup, use `ws://127.0.0.1:8787/bridge` and copy the **bridge token** from the desktop app. Click **Save & reconnect**. The app should show **Extension connected**.
5. When the ngrok status is verified, click **Copy Connector URL** in the desktop app and configure it in ChatGPT. The URL has the form `https://YOUR-DOMAIN/mcp?token=YOUR-BRIDGE-TOKEN`. Keep it private.

The desktop app reads its own credential-free ngrok configuration, so your existing AgentBridge account/domain can remain online independently.

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
of leaving an invisible background process. Never run the portable executable
and the source app simultaneously: both normally use port `8787`.

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
