# Chat Orchestrator (MCP + browser extension)

An orchestrator chat (Claude or ChatGPT) calls MCP tools; a local server forwards them to a
browser extension, which opens/drives worker chat tabs and returns their replies.

**Windows desktop + Chrome extension release:** Download both packages from
[GitHub Releases](https://github.com/EmpRider/Chat-Orchestrator/releases) and follow
[the desktop setup guide](extention-proxy/DESKTOP.md). The desktop app manages its own
ngrok tunnel and gives you the ChatGPT connector URL.

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
   copy the **bridge token** from the desktop app, and click **Save & reconnect**.
4. Open the chat you want as orchestrator and click **Set this tab as orchestrator**
   in the extension popup. Log in to your chosen worker-chat site in the same browser profile.
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

The source desktop app uses the same dedicated-ngrok UI. Do not run it alongside
the portable EXE, because both use local port `8787`.

## Verify the pieces

- `cd extention-proxy; npm test` runs an end-to-end smoke test with a fake extension (passes).
- Popup -> **Diagnose this tab** shows how many elements each DOM selector matches. If a count is
  `0`, update the selector lists at the top of `extention/content.js`.

## Safety knobs

- Kill switch checkbox, max worker windows, max tasks/hour and task timeout (popup).
- Token required on both `/mcp` and `/bridge`; server binds to `127.0.0.1` only.
- `send_to_tab` refuses the orchestrator tab; `close_worker` only closes tabs it spawned.

## Known limits

- DOM selectors are best-effort and untested against the live sites; expect to tweak them.
- Replies are read with `innerText`, so code-fence markers are lost.
- Automating the web UIs may conflict with each site's terms; keep it to personal use.
- Anyone with your token and tunnel URL can drive your logged-in chats: keep the token secret.
