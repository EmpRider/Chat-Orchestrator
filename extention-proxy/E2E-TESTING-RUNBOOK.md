# Chat Orchestrator — live E2E testing runbook

**Target:** the actual installed desktop/proxy, Microsoft Edge **Default** profile, authenticated ChatGPT session, installed Chat Orchestrator extension, ngrok tunnel, and ChatGPT MCP connectors.  
**Owner:** E2E operator / test manager.  
**Last reviewed against repository source:** 2026-11-12.  
**Related:** [Desktop setup and recovery](DESKTOP.md), [prior Default-profile findings](DEFAULT-PROFILE-E2E-FINDINGS-2026-11-07.md), [prior isolated E2E report](E2E-REPORT-2026-11-07.md).

## 1. Scope and pass criteria

This is a **real user journey** test, not a proxy mock or an isolated regression test. Drive ChatGPT in the **existing, logged-in Edge Default profile**; use its installed `2AgentBridge` and `2Woker tool` connectors when available. Execute harmless worker prompts through the actual desktop, local proxy, Edge extension, and public MCP connection. Validate the resulting ChatGPT conversations, worker task IDs, queue events, and acknowledgments.

An end-to-end **PASS** requires observable completion of the full path:

`Edge Default profile -> ChatGPT manager tab -> installed MCP connector -> ngrok /mcp -> desktop proxy -> Edge extension /bridge -> worker ChatGPT tab -> response -> get_result -> manager FIFO delivery -> review/report -> explicit ACK -> close_worker`.

Report **FAIL** for a reproducible incorrect response or behavior, **BLOCKED** for missing access or unsafe state, and **UNVERIFIED** for any stage not actually exercised. Passing `npm test`, an MCP health probe, a mock conversation, or an isolated-browser exercise **does not** establish Default-profile E2E PASS.

## 2. Non-negotiable operating rules

1. **Use Edge Default only.** Reuse the existing logged-in Edge window/profile. Do not clone it, create a temporary or incognito profile, use Chrome, or reset browser data. The prior isolated-profile report is historical coverage, not acceptance evidence for this profile.
2. Leave unrelated tabs, sessions, extensions, credentials, browser profiles, and other ngrok/AgentBridge connections alone. Use a **new dedicated ChatGPT manager tab inside the existing Default profile** for this test and retain its identity until the test is closed.
3. Inspect working-tree changes and active runtime state before touching anything. Preserve all staged/unstaged/untracked files. Do not `git reset`, `git clean`, overwrite installation files, or silently change configuration.
4. Do **not** restart the desktop, proxy, tunnel or browser, reload the extension, refresh active worker conversations, or reinstall a connector while there are unresolved, delivered, or uncertain tasks/events. First record IDs, verify state, and make a defensible recovery decision.
5. Never replay an ambiguous chat submission automatically; a timeout or missing receipt is **not** evidence that a prompt was never sent. Read the chat/task state first.
6. Never acknowledge an event that has not actually been processed. A successful dispatch or ChatGPT message submission **does not** prove manager review. Acknowledgment records the consumer's assertion; it is not independent proof of a Saga update.
7. Never delete/truncate a coordination journal, `.lock`, registry, profile directory, or diagnostics as a recovery shortcut. Do not delete an owner lock merely because it exists.
8. Use benign reasoning and status prompts only. Do not send secrets or arbitrary private conversations to workers; redact tokens, cookies, connector URLs containing credentials, private chat content, and user data in any shared artifacts.
9. Do not force-close workers with running tasks or unresolved FIFO receipts. Pause only **new** queue delivery when diagnosing, then reconcile existing delivered batches separately.

## 3. Test inventory and preflight record

Before opening, restarting, or reloading anything, create a test record with the fields below:

| Field | Required observation |
| --- | --- |
| Run | Run ID, date/time with timezone, operator, scenario IDs |
| Source | Repository path, `git branch --show-current`, commit SHA, `git status --short` |
| Desktop | Source/packaged executable, version, process/PID, configuration profile, local port |
| Browser | Confirm Edge **Default**, actual signed-in ChatGPT tab and URL, extension ID/version and installed folder |
| Bridge | `/health` response, extension WebSocket connection, connected browser session ID |
| MCP | Public ngrok host (redacted), exact `/mcp` path, connector names/tool schemas, tool discovery result |
| Coordination | Enabled/available tools, journal path and owner lock state, pending phases, predecessor/incarnation conflicts |
| Identity | Manager `caller_tab_id`, `browser_session_id`, worker tab/task IDs as created |
| Evidence | Screenshot/recording IDs, sanitized log timestamp ranges, tool call/result IDs |

Run the following **read-only** checks in PowerShell from the repository. Never assume an earlier report describes the current process:

```powershell
Set-Location 'D:\Chat-Orchestrator'
git status --short
git branch --show-current
git rev-parse --short HEAD
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess
Get-Process msedge -ErrorAction SilentlyContinue |
  Select-Object -First 8 Id,ProcessName,StartTime
try { Invoke-RestMethod 'http://127.0.0.1:8787/health' } catch { $_.Exception.Message }
```

Inspect the desktop **Overview**, **Connections**, **Agents & queue**, and **Preferences** panels. Read any visible queue, agent and browser identity state before mutating it. Keep all preexisting pending work out of the test; historical pending events may require separate manual reconciliation. Inspect the latest logs read-only:

```powershell
Get-Content "$env:APPDATA\Chat Orchestrator\diagnostics-desktop.jsonl" -Tail 60
Get-Content "$env:APPDATA\Chat Orchestrator\diagnostics-proxy.jsonl" -Tail 60
```

Missing log files are a diagnostic observation, not permission to restart. Verify the loaded unpacked extension's actual source/build against `extention/manifest.json`, `extention/background.js`, and `extention/content.js`; compare the running desktop/proxy version with source. A source fix is **not deployed** merely because it exists locally. Note version mismatches as **BLOCKED/UNVERIFIED** until safely deployable.

## 4. Start and connect — only if components are actually down

**First choose reuse over restart.** If the running desktop, local proxy, extension, tunnel, and connector are healthy and match the intended build, continue with them. Do not launch a second desktop/proxy on port `8787` or run a second copy against the same profile.

If there are **no unresolved tasks/events** and the desktop is stopped, start the development desktop from PowerShell:

```powershell
Set-Location 'D:\Chat-Orchestrator\extention-proxy'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CHAT_ORCH_DIAGNOSTICS = '1'
$env:CHAT_ORCH_LOG_LEVEL = 'debug'
npm run desktop
```

For a packaged test, launch the **installed** app instead, then record the executable and version. The desktop owns the local proxy and its ngrok lifecycle. The usual local API is `127.0.0.1:8787`; confirm the configured port in the desktop. The extension connects to `ws://127.0.0.1:8787/bridge` (substitute the actual configured port). The public connector endpoint is `https://<configured-ngrok-domain>/mcp`.

Confirm all these before sending any worker prompt:

1. Desktop **Overview/Connections** identifies the intended profile, local port, and tunnel; no duplicate listener or port conflict.
2. `GET http://127.0.0.1:8787/health` returns `ok: true`, `extensionConnected: true`, and, for private coordination, `coordination.storageReady: true`. **Do not infer that coordination is unavailable solely from `coordination.enabled: false`; current source returns that field as false even when the conditional tools are exposed.**
3. The existing Edge **Default** profile has the expected unpacked extension enabled, and its popup points to the local `/bridge` socket. Verify its installed source/build is current.
4. The desktop's dedicated ngrok tunnel is connected, and the ChatGPT connector uses that tunnel's **exact** HTTPS `/mcp` URL. Inspect actual MCP tool discovery through the connected plugin. A browser `GET /mcp` or `GET /health` alone cannot prove a Streamable HTTP `POST /mcp` tool call works.
5. The authenticated ChatGPT session is available in **Edge Default**. Verify the browser controller actually operates that Edge window and can navigate to `https://chatgpt.com/`; do not silently fall back to another browser.
6. ChatGPT exposes **`2AgentBridge` and `2Woker tool`** (names may differ on the installation) and their working commands. Verify connector-provided tool parameters against the live MCP schema; a stale connector schema can omit a now-required `caller_tab_id`.

If any check fails, mark the specific layer **BLOCKED**, inspect logs/configuration, and resolve it without disrupting another component. Record a screenshot or tool receipt proving that ChatGPT was opened in the correct Edge profile and that the actual connectors were available.

## 5. Restart / reload decision matrix

| Changed or observed | Required action | Precondition and postcheck |
| --- | --- | --- |
| No relevant source/config change; all services healthy | **No restart** | Reuse existing process/session; capture health and tool list |
| `desktop/main.mjs`, desktop preload/UI, desktop runtime settings that require relaunch | Controlled desktop restart **only after safe-state check** | Read and resolve queues; use system tray **Exit**, confirm process/port stops, then launch once; verify all layers |
| `server.js`, registry/journal modules, proxy runtime wiring | Controlled proxy/desktop restart **only after safe-state check** | Record queue, journal, lock and identities; confirm graceful exit and new runtime readiness |
| `extention/background.js`, `content.js`, manifest, extension packaging | Update installed unpacked extension, click **Reload** at `edge://extensions` | First ensure no pending/uncertain delivery; verify installed file version, WebSocket reconnect and owned-tab identity |
| Extension content script was reloaded/updated | Refresh **only safe/idle** ChatGPT test tabs when necessary | Confirm no in-progress prompt or unresolved worker submission; re-run `list_tabs` and validate IDs/incarnations |
| Tunnel URL, ngrok credentials, or tunnel lifecycle actually changed | Repair/reconnect only affected ngrok instance | Avoid stopping other tunnels; verify desktop connection and MCP POST discovery |
| Public `/mcp` endpoint or connector installation/schema changed | Refresh/update relevant ChatGPT connector configuration | Verify exact endpoint and discovered tool arguments before further work |
| Worker/manager tab lost, tab identity changed, queue status uncertain | **No blanket reload/restart** | Inspect tab/task identity, pending/conflicts, chat transcript and immutable reports; use documented recovery APIs |
| Edge Default is already signed in and usable | **Reuse that window** | No alternate browser or profile; preserve unrelated tabs |

**Decision rule:** (a) Is the build/config unchanged and healthy? **Reuse.** (b) Does only one layer need an update and is every task/event settled? **Reload that layer.** (c) Is a restart required but any event is delivered, queued, or uncertain? **Stop and reconcile the current run first.** (d) Can ownership or delivery state not be established? **Do not destroy the evidence or claim successful recovery.**

**Important journal lifecycle:** the current desktop creates a **fresh temporary journal for each run** and removes its runtime directory on normal exit. A crashed run may leave an old temporary journal/lock; the next launch uses a fresh queue and does **not** automatically recover the old run. Thus a restart can remove access to an unresolved live FIFO context. Preserve and inspect evidence before restarting; a clean new queue does not prove the prior queue was processed.

## 6. Baseline live test procedure

1. In the **existing Edge Default** window, open a dedicated ChatGPT test manager conversation. Label the run with a unique `E2E-YYYYMMDD-HHMM` identifier. Do not choose an old busy manager conversation with unresolved delivery.
2. Send a harmless **actual ChatGPT prompt** explicitly requesting use of the connected `2AgentBridge` for read-only runtime inspection and `2Woker tool` for the worker lifecycle. Verify the prompt appears in the transcript and that the connector tools were **invoked**, with returned call IDs/results. Example:

   > Run a harmless Chat Orchestrator E2E test in this conversation. First call `list_tabs` with the connected 2Woker tool to identify this conversation's `caller_tab_id` and `browser_session_id`. Use these IDs on subsequent calls. If the private coordination tools are exposed, register this manager and arm delivery. Spawn two independent ChatGPT workers with the same marble-probability problem, collect both results, send the exact same follow-up twice to one worker, verify both replies with `read_chat`, then review and acknowledge FIFO batches in order. Use 2AgentBridge to inspect desktop/proxy logs read-only if a failure occurs. Do not restart or reload anything without checking pending events.

3. Through `2Woker tool`, call **`list_tabs` first**. Match the result to the actual ChatGPT manager tab by title/URL, not only the active-tab guess. Record `caller_tab_id` and `browser_session_id`. Tab IDs can overlap across browser sessions; pass the correct `browser_session_id` when needed. Do not reuse IDs from a prior run.
4. Inspect `coordination_pending` and `coordination_incarnation_conflicts` if available; ensure the test manager belongs to the current session and there is no unsafe unresolved state. Register with `coordination_register_manager` and call `coordination_start_delivery` **only when ready to process the resulting batches**. `coordination_pause_delivery` prevents *new* dispatch only; it does not settle already delivered work.
5. Spawn **two independent workers** using `spawn_worker` with `site: "chatgpt"`, correct caller/session IDs, and the *identical* task below. Record distinct worker `tab_id`s and `task_id`s and check grouping/parent ownership:

   > A bag contains three red marbles and two blue marbles. Two marbles are drawn without replacement. What is the probability that both are red? Explain the calculation.

6. Use `get_result` for each returned `task_id` until both reach terminal status. Maximum `wait_seconds` per call is 50. The expected mathematical answer is `(3/5) × (2/4) = 3/10 = 30%`. Verify *both* the tool results and the actual worker chat messages. A new tab alone is not proof of a submitted task or completed answer.
7. To one worker, call `send_to_tab` with the exact follow-up **twice**, **sequentially**, giving each call its own `task_id`:

   > Please restate the probability as a percentage in one sentence.

   After each call inspect `get_result`; then use `read_chat` with that worker `tab_id` to confirm there are **two distinct identical user follow-up messages and two resulting answers**. If the first send is uncertain, inspect its transcript/task state before attempting a second send; never mistake replay for the intentional repeat test.
8. Verify child result events, immutable report access, correct manager wake and FIFO ordering, then apply the review/ACK procedure in §7. If a worker's answer is incomplete, send a corrective instruction to the **same worker** and collect its replacement result before closing it.
9. Once all owned worker tasks are terminal and their FIFO events are processed, use `close_worker` on each direct child. Ensure no descendant exists before closing its parent and verify tabs/groups are cleaned up without touching unrelated Edge tabs.

## 7. FIFO delivery, report review, and acknowledgments

When private coordination is exposed, test `CHILD_RESULT`, `STATUS_REQUEST`, and `CHILD_TAB_LOST` behavior when applicable. Each delivered manager batch is an ordered, immutable set of events; **delivery is not processing**.

For **each** batch:

1. Record `batch_id`, every `event_id`, phase, and original FIFO position. Process events in arrival order, including status barriers and child results *after* a status request in the same batch before preparing a status answer.
2. For each `CHILD_RESULT`, inspect the preview and the worker result. When `preview_truncated` is true or full context is needed, use `coordination_get_report` with its `event_id` to read the immutable report. Verify the result meets the task; if not, send a correction to that same child and review its new result.
3. For `STATUS_REQUEST`, synthesize an accurate status from all relevant events in the batch. For `CHILD_TAB_LOST`, inspect the verified task and transcript before considering `reopen_child`. Reopening does **not** automatically resume execution.
4. **Only after each event was actually reviewed/handled**, call `coordination_ack_batch` with that exact `batch_id` and the processed ordered `event_ids` (API cap **16 IDs per call**). Verify ACK succeeded and the queue phase changed as expected. Never fabricate missing event IDs or ACK because a batch was merely visible.
5. Check `coordination_pending` again. Do not close a worker while an owned result or FIFO receipt is unresolved. Record any `QUEUED`, `DELIVERED`, `UNCERTAIN`, `PROCESSED`, or other reported phases without asserting completion from a transport receipt alone.

For idempotency testing, submit a harmless `coordination_status_request` with a UUID `idempotency_key`; repeat with **the same key** and verify no second event was created. Use a new UUID for a genuinely new event. Test rejection of premature/incorrect ACK without damaging real receipts.

## 8. Full E2E scenario matrix

Record **PASS / FAIL / BLOCKED / UNVERIFIED**, evidence, and any resulting issue ID for every applicable row. Run the **core** scenarios first, then resilience/negative scenarios only if a safe and isolated test root can be maintained *within the same Edge Default profile*.

| ID | Scenario | Required evidence / expected outcome |
| --- | --- | --- |
| P01 | Source-versus-installed build | Repo commit/worktree, desktop/extension versions and actual loaded files recorded |
| P02 | Desktop startup / single instance | Correct desktop UI and proxy listener; no port collision or accidental second proxy |
| P03 | Proxy health + bridge | `ok`, `extensionConnected`, coordination storage and connected WebSocket |
| P04 | Ngrok + MCP connector | Correct public `/mcp`, live tool discovery/invocation and schema alignment |
| P05 | Edge Default + authenticated ChatGPT | Browser/profile screenshot, actual ChatGPT navigation, expected connectors present |
| P06 | Identify test manager | `list_tabs` matches real caller tab and browser session; no reused IDs |
| P07 | Register + arm manager | Successful `coordination_register_manager`, `coordination_start_delivery`, pending snapshot |
| P08 | Two concurrent workers | Two independently created direct-child ChatGPT chats, correct tab groups/ownership |
| P09 | Prompt submission and completion | Both actual prompts visible and both `get_result` terminal with correct `30%` answer |
| P10 | Duplicate intentional follow-up | Two equal user messages, two separate task IDs, two replies confirmed by `read_chat` |
| P11 | Result receipt and immutable report | `CHILD_RESULT` preview and full `coordination_get_report` when needed |
| P12 | FIFO and status barrier | Stable ordered batches including interleaved `STATUS_REQUEST`; max-16 batch behavior |
| P13 | ACK discipline | Premature ACK rejected; processed exact batch ACK succeeds; pending phases verified |
| P14 | Parent review/fixing loop | Same child receives correction; new result reviewed and ACKed before closure |
| P15 | Clean close and tab grouping | Children closed only after terminal status/processed receipts; unrelated tabs untouched |
| R01 | Manager pause/resume | Pause prevents new dispatch, does not erase already delivered batch; resume recovers safely |
| R02 | Lost worker / reopen | Loss event with identity, `reopen_child` inspect-only recovery, no automatic replay |
| R03 | Bridge disconnect / reconnect | Connection loss/recovery logged; task status remains truthful; no duplicate submission |
| R04 | Same-site manager navigation | Identity/ownership remains correct or safe failure is reported; no silent root switch |
| R05 | Stale tab and browser identity | Wrong `caller_tab_id` / session/incarnation rejected; no cross-session action |
| R06 | Independent manager roots | Separate queues/owned children; cross-root read/close denied |
| R07 | Nested workers | Correct descendants and grouped ownership; nested worker closed before parent |
| R08 | Idempotency and duplicate events | Same key returns original event; new key creates a new event, proper ordering |
| R09 | Reconcile predecessor conflicts | Inspect conflicts and event details read-only; any quarantine requires explicit operator review |
| R10 | Graceful tray Exit **when safe** | Proxy and owned tunnel stop, journal writer drains and owned lock releases |
| R11 | Diagnostic and negative paths | Source/installed error logs correlate with tool errors, no guessed success or silent replay |

Never manufacture negative cases that threaten unrelated live work. A deliberately failed assertion is PASS only when the system correctly rejects the unsafe operation and leaves state intact.

## 9. Recovery and escalation

| Symptom | Immediate check | Safe next action |
| --- | --- | --- |
| `GET /health` fails or port occupied | Listener PID, correct desktop instance, logs, configured port | Fix only the identified component after queue inspection; avoid second proxy |
| `spawn_worker` returns connector `INVALID_ARGUMENT`, while a direct local MCP diagnostic says `Creating browser windows from extensions is not supported in Owl.` | Compare the `list_tabs` session with the actual Edge Default browser; inspect the precise local MCP `isError` text and confirm which browser implements `chrome.windows.create` | Record this as an unsupported connected-browser session. Do not treat the Owl tab as an Edge Default manager, change the MCP error into a false success, or claim worker creation. Reconnect the existing Edge Default extension only through a supported, authorized path. |
| An existing Edge Default profile cannot be attached to by browser automation, or launching an Edge tab is explicitly rejected by runtime policy | Record the original browser-controller and local command errors, plus read-only process and extension-installation evidence | Preserve the current Edge profile and sessions; do not relaunch with `--isolated`, duplicate the profile, kill Edge, or switch tools to evade an explicit refusal. Mark browser-driven E2E blocked and continue independent regression checks. |
| Extension disconnected | Popup socket URL, extension loaded/version, `bridge.connected`/`bridge.disconnected` | Reconnect when safe; never reload active uncertain work reflexively |
| ECC browser discovery says Edge `User Data` is **already running** and suggests `--isolated` | Confirm the current Edge Default process and that the controller cannot attach to it | **Do not use `--isolated`, a copied profile, or kill the logged-in browser.** Record the precise ECC error; leave browser-driven E2E BLOCKED until a supported attachment to the existing Default profile works |
| Public MCP fails, including SSE 404 | Actual `/mcp` URL, installed connector protocol and tool list, ngrok route | Compare live schema and Streamable HTTP capability; log the exact failing call |
| Spawn creates a tab but result is missing | `list_tabs`, `get_result`, actual worker transcript, grouping state, diagnostics | Determine whether prompt was sent; do not reissue ambiguous submission |
| Group placement unconfirmed | Root/tab/window ownership and `extension.worker.group_unconfirmed` | Record installed source/version and placement error; no moving unrelated tabs |
| Prompt stuck at readiness/composer | `read_chat`, compose/send diagnostics, page readiness, send-button state | Locate the exact failed gate before trying again; verify no prior delivery |
| Manager missing or duplicate events | `coordination_pending`, batch IDs, idempotency keys, incarnation conflicts | Examine immutable reports and manager transcript before ACK/replay |
| Identity/incarnation mismatch | `list_tabs` browser session, root/descendants, predecessor inspection | Only use supported, guarded identity repair after examining ownership and pending events |
| Worker tab unexpectedly lost | Owned `task_id`, `coordination_inspect_worker_tasks`, `CHILD_TAB_LOST` | `reopen_child` only when verified; inspect chat before resending |
| `.lock` present after crash | Runtime process ownership, journal checksum, diagnostics | Preserve journal and lock; manual review; **no** automatic deletion/truncation |

The desktop **Advanced** root identity reconciliation is allowed only under its implementation guards (same browser session, previously registered root, no registered descendants, zero unresolved FIFO events). `coordination_incarnation_conflicts` and `coordination_get_predecessor_event` allow read-only historical inspection. `coordination_reconcile_predecessors` is an explicit **quarantine of unprocessed historical events**, not an ACK or replay: require a fresh snapshot digest, the documented confirmation string, a defensible reason and a stable idempotency key after operator review. Do not use it simply to make an E2E test green.

For transient non-safety tool failures, inspect state before a retry; allow at most **three** attempts for the same operation with roughly 5–6 seconds between attempts. Never retry a safety-blocked operation through disguised parameters or a different tool. Preserve completed independent checks and report remaining blocked steps.

## 10. Diagnostics, evidence, and report form

Default desktop diagnostics locations:

```text
%APPDATA%\Chat Orchestrator\diagnostics-desktop.jsonl
%APPDATA%\Chat Orchestrator\diagnostics-proxy.jsonl
```

Useful trace markers include `proxy.ready`, `proxy.start_failed`, `bridge.connected`, `bridge.disconnected`, `bridge.timeout`, `identity.registry_mismatch`, `identity.root_reconciled`, `extension.worker.group_unconfirmed`, `fifo.batch_prepared`, `fifo.dispatching`, `fifo.dispatch_result`, `fifo.ack_rejected`, and `fifo.ack_processed` (availability depends on the **deployed** build). Diagnostic logging is best enabled **before a safe startup**, and logging must never become an excuse to restart with pending work.

For each tool interaction, capture the **timestamp**, scenario ID, connector/tool name, sanitized arguments, returned IDs, response/status/error **verbatim**, matching browser screenshot/transcript where possible, and correlated redacted diagnostics. Keep a separate line for what is *observed* versus *inferred*; do not describe a tool call as performed without its real receipt.

Use this report template at the end of every run:

```markdown
# Chat Orchestrator Default Edge E2E — <run ID>
Date/time and timezone: <...>
Result: PASS / FAIL / BLOCKED / PARTIAL (with explicitly UNVERIFIED rows)
Source: <branch, SHA, dirty worktree summary>
Installed versions: <desktop, proxy, Edge extension, connectors>
Environment: Edge Default, ChatGPT URL, local port, tunnel endpoint [redacted]
Manager: <caller_tab_id, browser_session_id>
Workers: <tab_id -> task_id and terminal status>
FIFO: <batch_id -> ordered event_ids -> actual review -> ACK outcome>

| Scenario | Status | Evidence / tool IDs | Defect or blocker |
| --- | --- | --- | --- |
| P01 | ... | ... | ... |

Actual changes/restarts/reloads: <component, reason, timestamp, consequences>
Known unresolved events or submissions: <exact IDs, phases, why unsettled>
Defects and likely code locations: <verified evidence, no unproven root cause>
Cleanup: <worker closure, tab state, listeners, journal ownership, unrelated sessions intact>
Unverified scope / next safe action: <...>
```

## 11. End-of-run cleanup and acceptance gate

1. Stop creating new worker tasks. Finish or accurately flag every owned running task and pending FIFO event. When appropriate, pause **new** delivery; do not hide delivered batches.
2. Read the final worker transcripts and `get_result`, inspect full reports as needed, ACK **only** verified processed events, and confirm pending queue phases.
3. Close only terminal, direct-child workers after descendants and receipts are settled. Verify their tabs/groups are gone and unrelated Default-profile tabs remain unchanged.
4. Keep the existing desktop/Edge session running if the user still needs it. If the scenario explicitly requires shutdown and the state is safe, use **system tray > Exit** (the window **X** can merely hide the app). Confirm graceful shutdown, listeners and owned journal-lock state without manual deletion.
5. Preserve test artifacts, report all source/deployed version differences, and leave the working tree intact except for intentional, reported changes.
6. Declare overall **PASS** only when P01–P15 are evidenced on the real Default-profile pipeline; report R01–R11 separately with their actual statuses. A failed core row means **FULL E2E NOT PASSED**, even if source regressions all pass.

**Historical guardrail:** the 2026-11-07 Default-profile run recorded a grouping failure plus **18 status events** (16 delivered, two queued, none processed) before an identity mismatch. Do **not** assume those events survived, were processed, or were cleared. Investigate the *current* runtime/journal and manager transcript before any restart, replay or acknowledgment. The live Default-profile test harness in `test/live-default-profile-e2e.mjs` currently contains only a placeholder; a log line from that file is **not** a live E2E test.
