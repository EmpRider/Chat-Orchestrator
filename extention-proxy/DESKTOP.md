# Chat Orchestrator desktop app (Windows)

**Verification repair (newer source):** The selected Chrome/Edge browser type,
extension installation ID and bundled extension version must match on enrollment.
After an extension reinstall, use **Repair / Reverify extension** in Connections.
Saved enrollment is not sufficient for a green live-verified status: the Desktop
rechecks the actual connected extension after every Proxy/extension reconnect,
including fast socket replacements. Until it matches, status shows
**reverification required**, and browser-close commands also perform a fresh
identity check just before executing. Choosing **Close Managed Browser**
persists a short-lived, exact tab/incarnation intentional-exit marker before
scheduling window closure, preventing a suspended extension from turning a
deliberate Quit into a false Accident prompt.
The type and version checks are a safety improvement, not cryptographic
attestation of the operating system's native browser profile directory.
Bundled Load unpacked is for developer/testing; Chrome Web Store and Edge
Add-ons are planned consumer channels, with publication still unverified.

## CURRENT SETUP (2026-11-15) — use this, not the archived sections below

The supported first-release target is an **installed Windows Setup.exe**,
bundled extension plus **existing Chrome or Edge**. The latest locally built NSIS
installer is `dist/Chat Orchestrator Setup 0.1.3.exe` and remains **unsigned**.
Real clean-install/uninstall and live ChatGPT E2E have not been verified.

1. Launch the desktop application. Connections opens a first-run setup guide.
2. Select an installed browser. The app opens its dedicated persistent user-data
   directory. It does **not** use an ordinary personal browser profile.
3. In the selected browser's Extensions page choose **Developer mode / Load
   unpacked** and select the extension bundled in the app's resources. Configure
   the local WebSocket URL and separate **profile connection key** in the popup.
4. After the extension connects, confirm it is installed in that dedicated
   browser, click **Verify connected browser profile** and **Finish setup**.
   The app refuses **Close Managed Browser** without a verified, matching
   extension installation. This enrollment ID is not cryptographic proof
   of the operating-system process user-data directory.
5. Configure ngrok domain and authtoken. For ChatGPT, choose
   **No authentication**, then click **Copy Connector URL** to copy
   `https://YOUR-DOMAIN/mcp/agent/<transport-key>`.
   The key is embedded only in the copied URL, never the on-screen status.
   Keep the entire URL private; tunnel operators may log the URL path.
   Header-capable clients can still use `/mcp` with
   `Authorization: Bearer <transport-key>` and **Copy MCP transport key**.
   The local extension profile key is a different secret.
6. Explicitly approve a Parent in the ChatGPT tab using the extension. The
   resulting one-time code pairs that Agent via `pair_conversation`. All
   further MCP tool calls require its `agent_credential` and unique UUID
   `idempotency_key`.

**Authentication choice:** The Product Owner selected **one static public
transport key, no OAuth**. The dedicated `/mcp/agent/<transport-key>` route accepts
the key from the URL path for ChatGPT's no-custom-header configuration;
it is **not** an unauthenticated endpoint. The legacy `/mcp` route continues
to require a Bearer header. Bad or absent URL tokens return 401. Real ChatGPT
MCP registration still requires live verification.

**Window X behavior:** The saved **Minimize to system tray when closing**
checkbox stays available, checked by default. Enabled X hides to tray; disabled
X asks the same explicit Exit confirmation as the tray menu
(**Keep Browser Open / Close Managed Browser / Cancel**). Cancel leaves all
work running.

**Updates:** Preferences shows a trusted release notice and **Update Now**
button. A requested update stays pending until active Child tasks, direct-Parent
review and FIFO events are cleared. The app deliberately does **not** download,
execute, or silently trust a new unsigned EXE; it opens the verified publisher
release page for a separate deliberate installation without stopping the Proxy.
Use **Cancel pending** to withdraw the request.

**All sections below are historical design/diagnostic notes** from earlier
candidate implementations. Conflicting tokenless authentication, selected-root
registration, temporary-journal and portable-build instructions are
**SUPERSEDED** by the above and the current source code. Preserve them for
incident context only.

---

## Local 0.1.3 redesigned UI + modular-instructions candidate (November 6, 2026)

This is a local development candidate, not a published GitHub Release. The desktop has four pages
(Overview, Connections, Agents & queue, Preferences). The extension popup configures only
its local WebSocket URL; no MCP/extension bridge token or scoped agent pairing is required.

- Desktop EXE: `extention-proxy/dist/Chat-Orchestrator-0.1.3-no-bridge-auth.exe`
- Browser extension ZIP: `extention-proxy/dist/Chat-Orchestrator-0.1.3-no-bridge-auth-extension.zip`

To update an existing installation, exit the old desktop program using its **system tray > Exit**
command (window X may only hide it), then run the new portable EXE using the **same profile**.
Settings and the Ngrok authtoken live in the Windows profile data folder, not in the EXE.
To update the extension, replace the existing unpacked files, choose **Reload** in
Edge/Chrome extensions, then refresh chat tabs so document-start hooks load.
No extension credential needs to be copied.

Verification of this local candidate: `npm test` 70/70, MCP smoke,
real Electron four-page UI smoke and isolated packaged EXE settings WebSocket smoke PASS.
The extension ZIP has a root manifest and 21 files. No GitHub release was published;
P0 recovery, independent QA and live-browser acceptance remain separate.


The desktop app runs the MCP server locally and starts a dedicated ngrok tunnel. It does not change the existing AgentBridge tunnel or its ngrok configuration.

## Install from a GitHub release

Download both files from [Chat Orchestrator Releases](https://github.com/EmpRider/Chat-Orchestrator/releases):

- `Chat-Orchestrator-0.1.3.exe`: portable Windows desktop app.
- `Chat-Orchestrator-0.1.3-extension.zip`: Chrome/Edge extension. Extract it first; the extracted directory must contain `manifest.json` at its root.

The executable is not code-signed, so Windows may show an unknown-publisher warning. You must install the [ngrok CLI](https://ngrok.com/download/windows) separately and ensure `ngrok` is on `PATH`.

## Redesigned desktop (0.1.3)

The four pages are **Overview** (connection status), **Connections** (port, local WebSocket URL,
Ngrok domain/authtoken and MCP URL), **Agents & queue** (journal/worker status), and
**Preferences** (worker limits, system prompts, tray). There is no scoped pairing UI.

## Connect

1. Start the desktop app. It launches the local MCP server at `127.0.0.1:8787`.
2. Enter your **dedicated ngrok hostname** and its matching **ngrok authtoken**. Click **Save & Connect**. The authtoken is encrypted in your Windows user profile; it is never included in the executable or ngrok's command-line arguments.
3. In Chrome/Edge, open the extensions page, enable Developer mode, and choose **Load unpacked**. Select the folder extracted from the extension ZIP.
4. In the extension popup, set `ws://127.0.0.1:8787/bridge` (or this profile's port) and
   click **Save and reconnect**. The app should show **Extension connected**, followed by settings sync.
5. When Ngrok is online, click **Copy Connector URL** and configure it in your chat agent.
   The clipboard URL is `https://YOUR-DOMAIN/mcp/agent/<transport-key>`.
   The on-screen display deliberately omits the token; ChatGPT should use
   **No authentication**. Treat the copied URL as a password.

The desktop app reads its own credential-free ngrok configuration, so your existing AgentBridge account/domain can remain online independently.

## Extension settings and editable system prompts

Open the desktop **Extension settings & system prompts** panel. It controls the
extension automation toggle, worker tab cap, hourly task cap, timeout and the
operation-specific MCP/agent communication instruction modules (core, task,
workspace, delegation, queue receipt/ACK, child result, status, lost tab and failure).
Select an operation, edit its instructions, and choose **Save extension settings**.
Role policies (BA, PM, TL, specialists, Council, Watchdog) come from SKILL.md,
not these proxy-managed prompts. **Preview** composes a draft locally without
submitting a chat message. Reset buttons affect only the draft until Save.
Settings are stored in this profile's `settings.json` and sent to the extension
when it connects/reconnects or when changed. A revision indicator appears after
extension acknowledgement. The proxy owns editable settings; the extension cannot overwrite them
by sending a WebSocket settings message. Auto-close stays disabled; the parent must review worker results before explicitly closing a worker.
The extension popup shows only the local WebSocket URL and connection status.

**Advanced browser actions** replaces the popup's legacy orchestrator-tab
selection, diagnostics, and safe legacy-worker closure. Diagnose only your own
chats, since diagnostic responses can include page text.

## Independent desktop profiles

Start another copy with `--profile=work`, then choose another port under **Tunnel settings**.
Each profile has its own settings, prompt modules and Ngrok configuration/authtoken.
Use a separate browser profile/extension for each local WebSocket URL. The default port is `8787`.

## Proxy-owned tab relationships (source candidate; final E2E pending)

### Dedicated managed browser workspace (approved default)

The first new worker opens one **unfocused normal browser window** containing
the bundled `chrome-extension://.../workspace.html` anchor page. Each later
`spawn_worker` or `reopen_child` creates an **inactive tab** in that same
window via `chrome.tabs.create({windowId,active:false})`, rather than
opening a separate browser window for each worker. Root conversations remain
where the user originally opened them.

The extension groups all descendants of the same root into a native
`chrome.tabs.group()` group, and gives separate roots different group IDs
and colors. Native groups are flat: the proxy's parent/child/grandchild
registry still owns the real tree. The extension stores the workspace anchor
window ID, anchor tab ID, browser session, and root-to-group associations in
`chrome.storage.session`; on each reuse it checks that the original extension
anchor tab remains in a normal window, and validates a group's actual
tracked worker membership before reusing it. All window/group creation is
serialized, including concurrent root spawns. Group creation failure removes
only the newly created, unstarted worker tab. The extension does not move
existing user tabs, close a user's window, or focus the workspace on spawn.

If the anchor has disappeared, a new workspace is created only when a later
spawn/recovery actually needs it. Previously opened worker tabs are not moved
or replayed automatically; any interrupted or lost task still requires
the existing parent-child reconciliation process. Browser restart changes
session-bound identifiers and never makes a recycled numeric window/group ID
an authorization identity. Closing a worker closes only its tab.

The browser extension requires `tabGroups` permission. The feature uses the
existing browser profile rather than launching an isolated browser profile.
Consolidation reduces window/taskbar clutter, **not necessarily renderer RAM
or CPU usage**; background-tab throttling and multi-root group behavior need
verification in the final isolated Chrome/Edge E2E round.

There is no longer a required globally selected orchestrator tab for MCP calls.
Invoke `list_tabs` with no arguments to discover candidate browser tab IDs
(only IDs, site, role and active state are returned before pairing).
Every other operation must supply `caller_tab_id`, the ID of the chat
conversation making the call:

```json
{"caller_tab_id":101,"site":"chatgpt","task":"Inspect this workstream","wait_seconds":0}
```

The first `spawn_worker` from an unregistered, supported non-worker tab
creates a root with `parentTabId=null` in the proxy registry. The worker
opens as its direct child. A registered worker tab may also invoke
`spawn_worker` and create a grandchild under itself. Reusable role seats
are scoped to the same direct parent, not reused across different roots.
`coordination_register_manager` or self-`read_chat` can also establish a
new non-worker root. The extension checks that each referenced tab still
exists on a supported site, with the expected browser session and incarnation.

The proxy's root/worker relationship registry is **session-only**. It lives
in memory and is cleared when the proxy stops (or its process exits).
On the next start, roots and workers must register again. Historical
`tab-relations.json` files written by older builds are **ignored** and
left unchanged for forensic review; they are never loaded as active tabs.
The worker phases during a session are `prepared`, `started`,
`reattached` and `uncertain`. Reused numeric IDs, changed sessions,
missing ancestors and ambiguous started tasks still fail closed **within**
that session. The proxy never silently promotes or reparents workers.
The separate durable FIFO journal is not part of the tab registry: pending
and uncertain events are retained for manual reconciliation, not dropped or
automatically ACKed at shutdown.

Worker creation is two-phase: open and register the child relationship first,
then start the task. `send_to_tab`, explicit target `read_chat`, and
`close_worker` enforce the direct parent relationship. Child completion,
status barriers and queue ACKs use the calling parent's local profile/tab
scope. Ordered journal delivery is still separately armed and never replayed
blindly. A parent can send successive fixing tasks to the same child via
`send_to_tab` and review each unique internal task UUID. `close_worker`
requires all recorded tasks to be terminal and, when the private FIFO is
enabled, all matching CHILD_RESULT receipts to be processed/ACKed by the
parent. It rejects active tasks, uncertain workers and tabs with descendants.
No Saga task, subtask or note ID is required for closure. Optional
`saga_task_id` on `spawn_worker` is an external tracking hint included in
the worker instructions, never used for uniqueness, ownership or authorization.

**Security limitation:** MCP HTTP provides no independently authenticated
browser-origin identity. `caller_tab_id` is client-supplied; tab inspection
proves browser existence/incarnation but cannot authenticate the remote
caller. The registry prevents accidental relationship confusion, not
malicious spoofing after transport/Agent credentials are stolen. The Ngrok
provider authtoken does *not* restrict visitors to `/mcp` or `/mcp/agent`.
The Proxy validates an independent, 256-bit transport key at both endpoints,
and Agent pairing/ACLs remain required for privileged operations. A URL
containing `/mcp/agent/<transport-key>` can be copied, logged by the tunnel provider, or otherwise
leaked; the whole URL must be treated as sensitive. No OAuth is implemented.

**Compatibility and release state:** This is an uncommitted, untested source
candidate, not the running Electron/Edge installation. Existing journal
records under the previous single-profile queue scope and existing worker
seat identifiers are not automatically migrated; they require explicit
manual reconciliation if needed. Older SAGA_CONFIRMED journal events remain
readable for backward compatibility, but new closure no longer writes or
requires a Saga proof. Do not restart the user's active browser or replay workers to
force migration. Run the complete regression + isolated Edge/Electron/Ngrok
E2E suite in one coordinated final acceptance pass with the owner.

## Root identity recovery (local Desktop only)

An existing browser manager can become invalid if its saved tab incarnation
differs from the Extension's live observation. **Do not disable identity
verification or delete the tab registry to make Worker Tool calls succeed.**

In the Desktop's **Advanced browser actions** panel:

1. Enter the tab ID returned by Worker Tool `list_tabs`.
2. Select **Inspect root recovery**. The result is read-only about the existing
   root, plus a one-use, 60-second confirmation offer only when safe.
3. If `can_reconcile` is true, select **Confirm safe root recovery** and
   approve the dialog. Then call Worker Tool `coordination_register_manager`
   for the same root again.

This operation is permitted only for a previously registered *root* in the
**same browser session and chat provider**, with no registered descendants
and **zero unresolved FIFO records**. Changed browser sessions, unknown
roots, lost ancestry and unresolved `QUEUED`, `DELIVERED` or `UNCERTAIN`
events remain blocked. A failure never modifies the journal, ACKs events,
replays a batch or submits a chat prompt. The Desktop uses trusted
window-to-utility-process IPC, not a public Worker Tool method. Recovery
confirmation is one-use and expires in 60 seconds.

A previously delivered, unacknowledged FIFO batch must first be reviewed and
reconciled against the actual parent conversation. The app intentionally
does not offer a blind reset, replay or force-ACK control. For new E2E tests,
use a **clean new root** rather than the blocked historical root, and verify
the loaded Edge extension matches the workspace before interpreting failures.

`LogLayer` events `identity.registry_mismatch`,
`identity.root_reconciled`, `extension.worker.group_unconfirmed`,
`fifo.dispatch_result` and `fifo.ack_processed` help pinpoint failures.
Passing automated regressions does not replace a real default-profile
Worker Tool acceptance test after deployment.

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

## Private queue recovery and lock diagnostics

### Structured LogLayer diagnostics

The Desktop and Proxy write privacy-restricted **LogLayer JSONL** diagnostics
to the active profile folder. The Extension sends operational diagnostic
events over its existing local WebSocket bridge; the Proxy sanitizes and
records them without granting access to journal operations.

- Default profile: `%APPDATA%\Chat Orchestrator\diagnostics-desktop.jsonl`
  and `%APPDATA%\Chat Orchestrator\diagnostics-proxy.jsonl`.
- Named or E2E profiles store logs in their own selected profile directory.
- Each component uses bounded rotation (2 MiB per file, current plus two
  historical `.1` / `.2` files).
- Set `CHAT_ORCH_LOG_LEVEL=debug` **before** starting the Desktop process
  to capture successful bridge request/response timing and detailed FIFO
  readiness decisions. Default `info` records significant lifecycle,
  delivery/ACK, placement and identity failures.
- Each record includes event name, severity, timestamp and allowlisted
  correlation fields such as tab ID, request UUID, batch UUID and task UUID.
  Log files **never intentionally store** prompts, chat transcripts,
  auth tokens, cookies, full URLs or raw exception messages/stacks.
- For identity errors, search for `identity.registry_mismatch`; the
  `mismatchField` states exactly which saved/live identity field differs,
  without printing either identity value. For worker tabs, search for
  `extension.worker.group_unconfirmed` and
  `extension.worker.group_window_mismatch`. FIFO events include
  `fifo.batch_prepared`, `fifo.dispatching`,
  `fifo.dispatch_result`, `fifo.ack_rejected` and
  `fifo.ack_processed`.
- Diagnostic logs are **not** a substitute for the durable FIFO journal.
  Their write failures are caught, and the system never ACKs, retries,
  replays or recovers events based on logs alone.

To inspect the last entries read-only:

```powershell
Get-Content "$env:APPDATA\Chat Orchestrator\diagnostics-proxy.jsonl" -Tail 60
```

These source changes require a normal application/extension deployment before
they produce diagnostics in the running default profile. **Do not reload the
live extension or proxy until unresolved FIFO delivery has been reconciled.**

### Tray Exit journal-owner cleanup

The system tray **Exit** action now requests a serialized Proxy shutdown and
waits for its `stopped` acknowledgment. Proxy shutdown first stops accepting
new work, closes lingering HTTP connections (without replaying requests),
drains the journal append queue, closes the journal and owner-lock handles,
then unlinks **only its own lock**. Desktop gives that process up to 15
seconds to finish rather than force-killing it after 3.5 seconds; when it
cannot confirm graceful exit, it surfaces an explicit lock-ownership warning
instead of claiming a verified clean stop. The final isolated Electron tray
test checks that `coordination.events.journal.lock` is absent on clean exit.
This fix prevents a known premature-kill path but does not imply all possible
OS crashes or storage failures can be recovered automatically.

**An existing stale owner lock is not removed by this fix.** Preserve the
journal and lock files, verify no process is using this specific profile,
and reconcile unacknowledged or uncertain queue operations before an
operator-controlled recovery. Never run an automated stale-lock deletion.

The internal event journal is **enabled by default**. Desktop startup creates it in a fresh temporary directory for this run; saved profile settings and credentials remain available across launches. On normal exit the runtime directory is removed. A crashed run may leave its temporary directory behind; the next launch still starts with a fresh worker queue. The desktop Coordination
panel shows a read-only journal inspection (presence, byte size and whether an
owner lock exists). A lock's presence **does not prove its writer is alive**.
After a crash or interrupted shutdown, treat any remaining `.lock` file or
incomplete/checksum-invalid event as **manual reconciliation required**.

1. Do not start a second proxy with the same named profile, port, or user-data
   directory. Keep other profiles and the running production instance untouched.
2. Preserve the entire `coordination.events.journal`, its `.lock` file, and the
   diagnostic error before investigating. Never paste journal payloads or
   credentials into a public report.
3. Independently verify process and user-data ownership and reconcile each
   potentially delivered `UNCERTAIN` event with the manager chat and Saga board.
   A transport send is **not** proof of manager processing or Saga confirmation.
4. Until a separate trusted reconciliation mechanism exists, the application
   **does not automatically remove an owner lock, repair a torn tail, retry
   ambiguous chat submissions, or close workers**. Leave this profile stopped
   if the evidence is incomplete; use a distinct profile for other work.

Each run uses a separate temporary journal path. Existing user-data files are
left untouched; no cross-run queue recovery is attempted.