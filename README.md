# Chat Orchestrator (MCP + browser extension)

## Local 0.1.3 redesigned UI release candidate (November 5, 2026)

This is a **locally built candidate**, not yet a published GitHub Release. It includes a reorganized
four-page desktop experience (Overview, Connections, Agents & queue, Preferences) and a
simpler extension popup with direct guidance for the **extension-only** credential.

- Desktop EXE: `extention-proxy/dist/Chat Orchestrator 0.1.3.exe`
- Browser extension ZIP: `extention-proxy/dist/Chat-Orchestrator-0.1.3-extension.zip`

To update an existing installation, exit the old desktop program using its **system tray > Exit**
command (window X may only hide it), then run the new portable EXE using the **same profile**.
Settings and credentials live in the Windows profile data folder, not in the EXE. To update the
browser extension without losing its extension ID and saved credentials, replace the files in
its existing unpacked folder, choose **Reload** in Edge/Chrome extensions, then refresh chat
tabs so document-start hooks are installed. In the extension popup, use **Connections >
Extension-only credential** from the desktop; the MCP token cannot authorize settings sync.

Local verification: `npm test` (72 passing), isolated real Electron navigation/layout smoke
(`node test/ui-redesign-runtime.mjs`), and packaged settings WebSocket smoke
(`node test/packaged-extension-settings-smoke.mjs`). These do **not** mean the separate
unfinished P0 crash-recovery and final end-to-end release gates are approved.


An orchestrator chat (Claude or ChatGPT) calls MCP tools; a local server forwards them to a
browser extension, which opens/drives worker chat tabs and returns their replies.

**Windows desktop + Chrome extension release:** Download both packages from
[GitHub Releases](https://github.com/EmpRider/Chat-Orchestrator/releases) and follow
[the desktop setup guide](extention-proxy/DESKTOP.md). The desktop app manages its own
ngrok tunnel and gives you the ChatGPT connector URL.

![Compact black desktop dashboard](docs/dark-ui-preview.png)

The Windows desktop app includes a compact dark interface and a system tray
icon. **Minimize to system tray when closing** is checked by default: closing
the window keeps the proxy and ngrok alive. Uncheck it to exit when closing,
or use **Exit** from the tray context menu at any time. The choice persists
across restarts. Desktop icon artwork is by [Icons8](https://icons8.com/).

```
Orchestrator chat --MCP/HTTPS (tunnel)--> extention-proxy (server.js)
                                              | WebSocket (localhost)
                                              v
                                   extention (MV3 service worker)
                                              | tabs + content scripts
                                              v
                                   worker tab (ChatGPT / Claude)
```

## Tools exposed to the orchestrator

| Tool | Purpose |
| --- | --- |
| `list_tabs` | Open Claude/ChatGPT tabs with `tab_id`, site, role |
| `spawn_worker(site, task, share_context_from?, wait_seconds?)` | New chat in a separate window = sub-agent |
| `send_to_tab(tab_id, text, wait_seconds?)` | Follow-up message to an existing worker |
| `get_result(task_id, wait_seconds?)` | Poll/wait for a worker's reply (max 50s per call) |
| `read_chat(tab_id?, last_n?)` | Read a tab's transcript (default: orchestrator tab) |
| `close_worker(tab_id)` | Close a worker window |

## Setup (Windows desktop app)

1. Download the **Windows portable EXE** and **Chrome extension ZIP** from
   [the latest release](https://github.com/EmpRider/Chat-Orchestrator/releases/latest).
   Install the [ngrok CLI](https://ngrok.com/download/windows) separately and make sure `ngrok`
   is available on your `PATH`.
2. Double-click the EXE. In its UI, enter your **dedicated ngrok domain** and the
   **matching ngrok authtoken**, then click **Save & Connect**. The app manages the tunnel
   automatically; you do not need to start a tunnel manually. Your existing AgentBridge
   domain and tunnel remain separate.
3. Extract the extension ZIP. Open `chrome://extensions`, enable **Developer mode**,
   select **Load unpacked**, and choose the extracted folder containing `manifest.json`.
   In the extension popup, set the WebSocket URL to `ws://127.0.0.1:8787/bridge`,
   copy the **Extension-only credential** using the desktop app's separate copy button,
   and click **Save connection & reconnect**. The ordinary MCP bridge token cannot
   receive system prompts or proxy settings.
4. In desktop **Extension settings & system prompts**, select **Advanced browser actions**
   and enter the chat tab ID (from `list_tabs`) to set the legacy orchestrator.
   Log in to your worker-chat sites in that browser profile.
5. Once the app shows the ngrok route as verified, click **Copy Connector URL**.
   Add that URL as the ChatGPT connector endpoint. It uses your dedicated domain and
   has the form `https://YOUR-DOMAIN/mcp?token=YOUR-BRIDGE-TOKEN`.
   Keep this URL private.
6. In the orchestrator chat, try:
   *"Use spawn_worker on chatgpt to review this plan, wait up to 45 seconds, then summarise."*

For more detail, see the [desktop setup guide](extention-proxy/DESKTOP.md).

## Develop from source

```powershell
cd extention-proxy
npm ci
npm test
npm run desktop
```

The default profile uses port `8787`. For a separate independent local proxy, launch
 the EXE with `--profile=work` and choose an unused port in **Tunnel settings**.
 Each profile keeps separate credentials, prompts, Ngrok configuration and settings.
 Never run two apps with the same profile and port.

## Verify the pieces

- `cd extention-proxy; npm test` runs MCP smoke tests and synthetic extraction
  regression tests for ChatGPT, Claude and Gemini. Live site verification is separate.
- `read_chat` prefers structured conversation data (using the same-site private
  web APIs adapted from Liksu/llm-chat-exporter-extension), then falls back to
  visible DOM messages. If both readers fail, it returns an extraction error
  instead of falsely reporting an empty successful chat.
- Optional `read_chat` flags: `last_n`, `include_reasoning` (default false),
  `include_attachments` (default true, returns names/placeholders only).
- **Do not run the legacy "Diagnose this tab" control on private conversations:**
  that older diagnostic response can include page text. Use synthetic tests instead.

## Safety knobs

- Proxy Tool **Extension settings & system prompts** owns the kill switch, worker limits,
  task timeout and editable worker/BA/PM/TL/Specialist/Council A–E/Watchdog prompts.
  The extension popup owns only the WebSocket URL/token and read-only connection status.
  Settings sync over the extension-only authenticated WebSocket.
- Token required on both `/mcp` and `/bridge`; server binds to `127.0.0.1` only.
- `send_to_tab` refuses the orchestrator tab; `close_worker` only closes tabs it spawned.

## Known limits

- The structured reader depends on private web APIs that may change. ChatGPT
  and Gemini use browser-local session-token hooks; credentials are not sent to
  the MCP server. Reload the extension **and** refresh existing conversation tabs
  so hooks can initialize at document start.
- Gemini is supported for `read_chat`; automated Gemini worker prompting is not
  enabled. Legacy DOM-only reads can still lose formatting and older virtualized turns.
- Automating the web UIs may conflict with each site's terms; keep it to personal use.
- Anyone with your token and tunnel URL can drive your logged-in chats: keep the token secret.
