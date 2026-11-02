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

## Setup

1. **Server**
   ```powershell
   cd extention-proxy
   npm install
   npm start
   ```
   It prints a token (also stored in `extention-proxy/.token`).

2. **Extension**: `chrome://extensions` -> Developer mode -> *Load unpacked* -> select `extention/`.
   Open the popup, paste the token, keep the URL `ws://localhost:8787/bridge`, **Save & reconnect**.
   The status should turn green ("connected").

3. **Mark the orchestrator tab**: open the chat that will act as orchestrator and click
   *Set this tab as orchestrator* in the popup. Log in to both sites in this browser profile.

4. **Expose the server to the cloud** (claude.ai / chatgpt.com call connectors from their servers,
   so `localhost` is not reachable):
   ```powershell
   cloudflared tunnel --url http://localhost:8787
   # or: ngrok http 8787
   ```
   Add a custom connector with URL `https://<tunnel-host>/mcp?token=<token>`.

5. In the orchestrator chat, ask for example:
   *"Use spawn_worker on chatgpt to review this plan, wait up to 45 seconds, then summarise."*

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
