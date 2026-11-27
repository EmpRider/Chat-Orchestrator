# Chat Orchestrator — E2E Testing Guide

Procedural Q&A playbook for agents testing this application end-to-end.
Not a status dashboard. Not a test-results report.

---

## 1. Prerequisites & Environment Reality

### Q: What must be installed and running before I can test?

- Windows 10/11 (Electron desktop target).
- Node.js >= 18 (`node -v` to confirm; `package.json:16`).
- Chrome or Edge installed (managed browser profile is app-owned, not your personal profile).
- Extension source at `extention/` (note spelling) — loaded unpacked into the managed browser.
- Dependencies installed: `npm install` in `extention-proxy/`.

Verify you are at the right step: `node -v` prints >= 18, `extention-proxy/node_modules/.package-lock.json` exists, and `extention/content.js` is readable.

### Q: How do I confirm the extension is correctly loaded?

Open the managed browser's Extensions page (`chrome://extensions` or `edge://extensions`). The Chat Orchestrator extension must show **Developer mode / Load unpacked** pointing at the bundled `extention/` directory. After any rebuild, click the reload icon on the extension card. The Desktop Connections panel shows green "Extension verified" only when the connected extension's installation ID and version match enrollment.

---

## 2. Starting the App the ONLY Correct Way

### Q: How do I start the desktop app?

```powershell
cd d:\Chat-Orchestrator\extention-proxy
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run desktop
```

Script resolves to `electron .` (`package.json:12`).

Verify you are at the right step: Electron window opens, tray icon appears, console prints `listening on http://127.0.0.1:8787`.

**If `npm run desktop` exits with code 0 and `Get-Process electron` returns nothing, check for a stale journal lock BEFORE reading logs.** This was observed on 2026-11-20: the app hit its own "Private journal owner lock exists" modal during startup, the parent exited, and both redirect logs were empty (stdout held only the npm banner). A silent successful exit is the signature of a blocking startup dialog, not a crash.

```powershell
Get-Content "$env:APPDATA\Chat Orchestrator\coordination.events.journal.lock" -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 8787
```

If the lock's PID is dead, reconcile per §5. If 8787 is listening, a proxy IS running — health-check it rather than starting a second one.

### Q: Startup fails with `DirectoryNotFoundException` before Electron even launches. What happened?

Your launcher redirects output to a log directory that does not exist yet (e.g. `Tee-Object -FilePath test-artifacts\runtime-logs\desktop-startup.log`). PowerShell fails the redirect, the whole pipeline exits 255, and **Electron never starts** — so the failure looks like an app bug but is a launcher bug.

Fix: create log directories before launching.

```powershell
New-Item -ItemType Directory -Force -Path test-artifacts\runtime-logs | Out-Null
```

Detect: exit code 255 with `out-file : Could not find a part of the path`. `Get-Process electron` returns nothing.

### Q: `electron .` fails with `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'`. What happened?

Your shell has `ELECTRON_RUN_AS_NODE=1` set (VS Code sets this in its integrated terminal). This makes `electron .` run as plain Node instead of launching Electron.

Detect: `$env:ELECTRON_RUN_AS_NODE` returns `1`. This variable is present by default in this shell environment but is NOT set at User or Machine scope — it is injected per-session (e.g. by VS Code). Clearing it in one shell does not persist.

Fix: clear it in the SAME PowerShell invocation that launches the app, then use `Start-Process` so the child inherits the cleaned environment:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process npm.cmd -ArgumentList 'run','desktop'
```

Running `npm run desktop` directly after clearing still works in an interactive terminal, but `Start-Process` is the reliable form for automated/headless sessions. Test launchers also strip it explicitly (`test/isolated-edge-launcher.mjs:95`, `test/isolated-profile-port-smoke.mjs:29`).

---

## 3. Stopping the App the ONLY Correct Way

### Q: How do I stop the app safely?

Use the Electron window close button, tray Quit, or send SIGINT/SIGTERM to the Electron process. All route through `app.quit()` → `before-quit` → `shutdownOwnedServices()` (`desktop/main.mjs:1409-1412`).

Never use `Stop-Process`, `taskkill /F`, or kill the child Node proxy directly. Force-killing skips journal lock release.

### Q: What happens during graceful shutdown?

1. `stopProxy()` posts `{type:'stop'}` to the proxy child process (`desktop/main.mjs:698`).
2. Waits up to 15 seconds for `{type:'stopped'}` acknowledgment (`desktop/main.mjs:691-695`).
3. If acknowledged and exit confirmed: phase becomes `'stopped'`, session dir cleaned if no `.lock` remains (`desktop/main.mjs:1341-1343`).
4. If NOT acknowledged within 15s: child is killed, phase becomes `'error'`, errorMessage = `'Proxy did not confirm journal lock release. Verify journal ownership before restart.'` (`desktop/main.mjs:708-712`).

### Q: Why does `taskkill /PID <main>` (without /F) not stop the app?

`installWindowCloseBehavior` (`desktop/tray-lifecycle.mjs:8-18`) intercepts the window `close` event and calls `window.hide()`, so WM_CLOSE only minimizes to tray. Tray Exit calls `requestTrayQuit` (`desktop/main.mjs:1274`) which opens a BLOCKING modal dialog with three buttons — unusable from a non-interactive shell. There is no IPC or CLI quit channel (`preload.cjs` exposes none).

Consequence: from a headless/automated session the ONLY options are:
(a) Ask the operator to use tray → Exit → Keep Browser Open.
(b) `taskkill /PID <main> /F` as an explicitly-recorded deviation.

If you must deviate, kill ONLY the main pid, never `/T`: the managed browser (e.g. Thorium, extension profile) is a separate process tree and its ChatGPT tabs are needed for the next run. Verify afterwards:

```powershell
Get-Process <browser-process-name>
Get-NetTCPConnection -LocalPort 8787
```

Pass signal: browser process still running, port 8787 no longer bound. Record the deviation and justification in your run artifact.

### Q: Phase is `'error'` after quit. What does that mean for the next start?

The journal lock file may still exist. The next startup will detect a potential stale lock. Do NOT delete it manually. See Section 5 for recovery policy. Inspect diagnostics first: `%APPDATA%\Chat Orchestrator\diagnostics-desktop.jsonl`.

---

## 4. Ports, Health, and Topology

### Q: What port does the proxy listen on and how do I check health?

Default: `8787` (`server.js:29`). Override with `PORT=<n>` env var. Tests use `PORT=0` for ephemeral assignment.

Health check:
```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Response shape (`server.js:3238-3243`):
```json
{"ok":true,"extensionConnected":true,"coordination":{"enabled":false,"storageReady":true}}
```

Pass signal: `ok === true`. `extensionConnected === true` means WebSocket bridge to extension is live.

### Q: How do I distinguish the proxy from other listeners?

Port 8765 is NOT the proxy. Only port 8787 (or your `PORT=` override) serves `/health`, `/mcp`, `/mcp/agent/:token`, and `/bridge`. Confirm with the `/health` response above.

### Q: What are the MCP and WebSocket endpoints?

- WebSocket bridge (extension only): `ws://localhost:<port>/bridge` (`server.js:3347`)
- MCP with Bearer token: `POST /mcp` with `Authorization: Bearer <transport-key>` (`server.js:3268`)
- MCP with URL-embedded token: `POST /mcp/agent/<token>` (`server.js:3300`)
- Public listener (optional, separate port): `CHAT_ORCH_PUBLIC_PORT` + `CHAT_ORCH_PUBLIC_MCP_TOKEN` (`server.js:34-43`)

GET/DELETE on `/mcp` and `/mcp/agent/:token` return 405 (`server.js:3308-3311`).

### Q: `/health` says `coordination.enabled:false`. Is coordination off?

NO. `enabled` is a hardcoded `false` legacy field at `server.js:3242`. The authoritative signal is `coordination.storageReady`. `storageReady:true` means the journal lock was acquired and replay succeeded. Do not treat `enabled:false` as a defect.

---

## 5. Journal, Owner Lock, and Stale-Lock Recovery

### Q: Where does the journal live?

`%APPDATA%\Chat Orchestrator\coordination.events.journal` and `.lock` sibling. Path constructed by `privateCoordinationJournalPath()` (`desktop/main.mjs:174`). Override with `CHAT_ORCH_JOURNAL_DIR` (`desktop/main.mjs:559`).

### Q: What does the lock file contain?

Exactly `{"version":1,"pid":<n>,"hostname":"<os.hostname()>","nonce":"<uuid v4>"}` — 101 bytes typically. `inspectJournalRecovery` rejects anything else as `OWNER_UNVERIFIED` (`coordination-storage.mjs:106-119`). Note there is no snapshot hash in the lock; a snapshot is computed on demand from the journal stat + lock bytes (`coordination-storage.mjs:127-130`). Lock presence does NOT prove the writer is alive — the process may have crashed without cleanup.

### Q: What is the exact stale-lock recovery policy?

Four cases:

1. **Live owner**: Lock PID matches a running proxy. Do nothing. Wait for graceful shutdown.
2. **Dead owner + zero-byte journal**: Desktop shows guided dialog "Archive this verified stale lock?" (`desktop/main.mjs:926-936`). Click **Archive stale lock**. This calls `archiveEmptyStaleJournalLock()` which verifies snapshot unchanged and archives (never deletes) the lock (`coordination-storage.mjs:138-143`).
3. **Dead owner + non-empty journal**: NEVER auto-delete. Preserve both files. Reconcile manually by inspecting journal contents and determining which events were committed. No automated recovery path exists.
4. **Malformed/corrupt lock**: Treat as case 3. Inspect before acting.

Key rule: Automated stale-lock deletion is forbidden. Archive (empty journal) or manual reconciliation (non-empty) only.

### Q: The app says the lock is stale but the Archive button is disabled because the journal is non-empty. What now?

This is expected and not a bug. `inspectJournalRecovery` (`desktop/coordination-storage.mjs:92-134`) blocks with reason `JOURNAL_NOT_EMPTY` at line 124. Reconcile the journal by hand first: every queue event must reach `PROCESSED` with an `explicit_manager_ack`. Check `"phase":"DELIVERED"` count equals `"phase":"PROCESSED"` count by reading the journal with `Get-Content -Raw` and regex counting. Do NOT paste journal payloads into reports.

Only when there are zero unacknowledged deliveries may you archive. The archive procedure that preserves all evidence:

1. Confirm owner PID is dead: `Get-Process -Id <pid>` returns error.
2. Confirm no `*.lock.recovery` marker exists.
3. Note the SHA256 + byte size of both journal and lock.
4. Copy BOTH files to `test-artifacts/failure-evidence/` before touching anything.
5. `Move-Item <lock> <lock>.reconciled-<epoch>-manual`.

Never truncate or edit the journal. Record the deviation and its justification in your run artifact.

**Worked example (2026-11-20, this repo).** Startup was blocked by a lock owned by PID 28476, a proxy instance force-killed during an earlier session. Verification before archiving:

- `Get-Process -Id 28476` → dead (`ESRCH` from `process.kill(pid,0)`).
- Journal 19,514 bytes, 20 events across 4 refs, every ref a complete
  `QUEUED → LEASED → DISPATCHING → DELIVERED → PROCESSED` chain ending in
  `explicit_manager_ack` — zero in-flight or UNCERTAIN deliveries.
- No `.lock.recovery` marker present.

Action: journal and lock copied to `test-artifacts/failure-evidence/journal-snapshot-2026-11-20-pre-recovery.journal` and `journal-lock-2026-11-20-pre-recovery.json`, then the lock was renamed to `coordination.events.journal.lock.reconciled-1795113603425-045ff43d-…`. Both files remain recoverable; nothing was deleted. Proxy then started cleanly and `/health` returned `storageReady:true`.

Practical note: the lock is normally held by the Electron owner process, so `npm run desktop` exiting with code 0 and no electron children means a blocking dialog ate the start — check `%APPDATA%\Chat Orchestrator` for a `.lock` first, not the logs (the logs will be empty).

---

## 6. BrowserMCP Boundary

### Q: What may BrowserMCP do?

- Connect to and inspect the Parent tab.
- Bootstrap the Parent (approve via extension dialog).
- Submit the TOP-LEVEL prompt only (the initial task delegation).

### Q: What must BrowserMCP NEVER do?

- Type, paste, or submit anything in a Child or Grandchild conversation.
- Press Enter or click Send in any descendant tab.
- Retry a child submission.
- Use Playwright, Selenium, or CDP as a fallback for child interaction.

Any descendant prompt submitted by external automation invalidates the test even if the result looks correct.

### Q: How do I prove provenance?

Check proxy diagnostics (`%APPDATA%\Chat Orchestrator\diagnostics-desktop.jsonl` and per-session log under `%TEMP%\chat-orchestrator-session-<uuid>`). All legitimate child submissions originate from `spawn_worker` or `send_to_tab` tool calls through the MCP bridge. Zero blocked calls reaching the server confirms upstream safety filtering, not local automation.

### Q: May BrowserMCP click the extension's own "Use this ChatGPT tab as a Parent Agent?" Yes button?

YES. That button is the extension's user-approval UI, not a chat prompt: it sends `{type:'create_pairing_offer',approve_parent:true}` to the background worker (`content.js:2038-2041`), which sets `approvedParents[tabId]` and has the extension itself compose and submit the setup message. A human clicks the identical control. This is NOT a descendant prompt submission. Record it in the run artifact as an approval interaction, and never describe it as a submitted prompt.

### Q: How strong is the pairing evidence, and can a test harness reuse the credential?

The Parent confirms pairing in-chat and the in-page badge reads `Chat Orchestrator · Parent · Connected`. The `agent_credential` is returned only to the ChatGPT conversation and is never stored anywhere the harness can read. Therefore external test tooling CANNOT call proxy agent tools as a Parent; every real agent operation must be driven through the Parent's own connector. Do not attempt to extract the credential from the transcript.

### Q: Several agents drive several Parent tabs at once. What breaks?

Two things, both observed live on 2026-11-20:

**1. A tab selection does not survive across BrowserMCP calls.** `tab select` and the command
that follows it must be in the *same* `browser` call. With more than one agent driving the
browser, an interleaved `tab select` from another agent retargets every subsequent command,
and a `get text` silently returns the wrong conversation. Symptom seen: a Parent that had
just been told to `list_tabs` appeared to answer `Provided tab ID conflicts with paired
conversation`, because the text was read from a different Parent whose id did not match.

```
# WRONG — another agent can select a different tab in between
tab select 1304387354
get text --max all

# RIGHT — selection and use are one atomic call
tab select 1304387354
fill getByRole('textbox', {name: 'Ask ChatGPT'}) "..."
press Enter
wait 25000
get text --max all
```

**2. Never let concurrent agents write the execution index directly.** A
read-modify-write on `test-artifacts/test-design/e2e-execution-index.json` from two agents
loses one agent's statuses. Workers write `results.json` under their own
`parallel-runs/<run>/worker-*/` directory; `runner/merge-results.mjs` folds them in serially.

Also: do NOT restart or kill the proxy while any agent holds a paired Parent session. A
restart invalidates every in-flight pairing binding at once. Scenarios that need a proxy
restart (`RC-09`, and anything under "exclusive runtime") belong to a serialized wave with
all other browser work stopped.

---

## 7. Parent Bootstrap and Pairing

### Q: How does Parent approval work?

1. Navigate to ChatGPT in the managed browser.
2. Extension shows in-page approval dialog: "Use this ChatGPT tab as a Parent Agent?"
3. User clicks Yes.
4. Extension injects `<chat_orchestrator_parent_setup>` tag containing a one-time pairing code into the chat.
5. ChatGPT reads the tag and calls `pair_conversation` through the named MCP connector.

Step 4 is performed by the extension itself (`background.js:4128-4140`), not by the tester. The setup prompt is composed by the background worker and submitted via `submit_parent_initialization` under a foreground-submit lease. A tester must never paste that tag manually — doing so bypasses the approval gate this sequence exists to enforce.

Each Parent needs its own ChatGPT tab. Approval for an already-open ChatGPT tab is a single click on the extension's own dialog.

### Q: How do I verify pairing independently from the chat transcript?

Do NOT trust the chat transcript alone. Check proxy diagnostics for a successful `pair_conversation` call with matching `caller_tab_id`. The extension's connection status in Desktop Connections panel also reflects verified pairing. Transcript text can be fabricated or reformatted by ChatGPT.

Strongest cheap signal: the in-page badge reads `Chat Orchestrator · Parent · Connected · N direct Children`. It is rendered by the content script from extension state (`content.js:2062+`), not by ChatGPT, so it cannot be produced by model text. Confirmed live 2026-11-20 on tabs 1304387265 / 1304387339 / 1304387341.

---

## 8. Child Lifecycle Through Chat Orchestrator Only

### Q: What are the real tool names and signatures?

Every public MCP tool requires a fresh UUID `idempotency_key` for a new logical call; reuse it only for an identical retry. All tools EXCEPT initial `pair_conversation` also require the paired `agent_credential`. Current registration is at `server.js:2687–3109`.

| Tool | Purpose | Key params |
|------|---------|------------|
| `pair_conversation` | Register Parent/Child agent | pairing code from injected tag |
| `spawn_worker` | Two-phase child creation | `task`, `site`, optional `role`, `wait_seconds` |
| `start_prepared_worker` | Activate prepared tab (phase 2) | internal; follows `spawn_worker` with `__defer_start` |
| `send_to_tab` | Follow-up to Child or Parent | `tab_id`, `text`, `wait_seconds` |
| `get_result` | Poll task status/result | `task_id`, `wait_seconds` (max 50) |
| `read_chat` | Read transcript | `tab_id`, `last_n`, `include_reasoning` |
| `close_worker` | Close child after review | `tab_id` |
| `complete_task` | Child signals own work done | `task_id`, optional `summary` |
| `review_task` | Parent marks child reviewed | `tab_id`, `task_id` |
| `reopen_child` | Recover lost child by task_id | `task_id` |
| `coordination_*` (11 conditional tools) | FIFO queue, delivery, ACK, predecessor-incarnation inspection and quarantine | various; exposed only while private journal coordination is enabled |

Local `/mcp` needs NO bearer token: `attachProfile` sets `{mode:'legacy'}` unconditionally (`server.js:69-75`), so `POST /mcp` from loopback is reachable. It still enforces `agent_credential` per tool (`server.js:2706-2720`), so you can discover tools but cannot act. Bearer auth applies only to the public/ngrok listener (`server.js:3335-3343`).

### Q: A mid-tree agent finished its child's work but its own task never leaves `waiting_for_children`. Why?

`parentReviewed` is set by exactly one handler — `review_task` (`background.js:3089`). A queue-batch ACK does NOT set it. `hasUnreviewedDescendants` (`background.js:719-737`) therefore keeps the manager's task deferred until every descendant task is `done|failed` AND `parentReviewed === true`.

This means any delegating agent must call `review_task` per child result. This is enforced in the `child_result` prompt module (`agent-settings.mjs:44`) and migrated in from earlier saved defaults. If you see an indefinite `waiting_for_children`, first confirm the agent's prompt actually contains `review_task`; older saved installs may predate the migration.

Because `verifyDirectChild` (`server.js:345-355`) checks direct-child ancestry, a Parent can only review ITS OWN children — reviewing a grandchild from the top is correctly refused, it must be done by the middle agent.

There are **11 standard MCP tools**, plus **11 optional coordination MCP tools** when the private journal is active (22 total). `start_prepared_worker` is an **internal Extension operation**, not a separately registered public MCP tool. Never assert a historical fixed 18-tool count.

### Q: The Parent reviewed its Child, but the Child tab is still open. Is that a bug?

Not in the close mechanism — but it was a **contract gap** found 2026-11-20 (finding D-ZOMBIE-TABS).

Review and closure are deliberately separate steps:

| Step | Tool | Gate it enforces |
|---|---|---|
| Review | `review_task` | clears `waiting_for_children`; also unlocks the Child for another independent task |
| Close | `close_worker` | refuses while any task on that tab is `queued\|running\|uncertain\|waiting_for_children`, and refuses until `parentReviewed === true` **and** the batch ACK returned `PROCESSED` (`server.js:2957`) |

They are separate on purpose: closing on review would remove the Parent's ability to send a **fixing task** to the same Child via `send_to_tab` — the "if it's not OK, follow up" half of the policy. So `close_worker` is the Parent's decision to make *after* it is satisfied.

**The leak:** an open Child tab consumes a worker slot (`workers.length + workerSlotReservations.size >= cfg.maxWorkers`, `background.js:972`). The `child_result` prompt module told the Parent to review and ACK but **never told it to close**, so a compliant Parent accumulated open tabs until `spawn_worker` returned `SUB_AGENT_LIMIT_REACHED`. Worse, the pre-fix saved profile on disk was still the V2 default that did not even contain `review_task`.

Now fixed in two places:

1. `agent-settings.mjs` — a fourth `child_result` clause instructs `close_worker` after review+ACK, and states the `SUB_AGENT_LIMIT_REACHED` consequence. The old default is kept as `PREVIOUS_DEFAULT_CHILD_RESULT_V3` and migrated, so **already-saved profiles upgrade too**. If you are testing an old install and Children never close, first confirm its saved `child_result` module contains `close_worker`.
2. `background.js` `guard()` — the limit error now names the closable tabs instead of leaving you to guess:

   `SUB_AGENT_LIMIT_REACHED: Complete work inline or reuse an idle Child. 2 reviewed worker tab(s) are still open and hold slots: 201, 301. Call close_worker on one of them to free a slot.`

   A tab is named only when it would actually pass `close_worker`'s gate (all tasks terminal **and** `parentReviewed === true` **and** no live descendants). That last condition matters: `closeReviewedWorker` refuses a Child with descendants *before* it looks at task status (`server.js:1940`). The first version of this fix omitted it and advertised a subtree-owning tab as closable — a Parent following that advice would have hit a second failure. Otherwise the message says *"No reviewed worker is closable yet"*.

**What to assert in a test:** after a Parent reviews a Child and ACKs, a subsequent `close_worker` on that `worker_tab_id` returns `{"closed":<tabId>,"parent_reviewed":true}`, and the tab is gone from `chrome.tabs`. Before review, or before ACK, `close_worker` must be refused with the messages quoted above — a scenario that asserts closure without those two refusals has not tested the gate.

**Operator escape hatches** (when no Parent is left to close anything): Desktop `close_all_workers` / `desktop_close_legacy_workers`. Truly orphaned worker tabs whose Parent tab is gone are turned into explicit Accident / Yes / Cancel decisions by `reconcileMissedChildClosures` — they are never closed silently, which is deliberate.

### Q: Does `spawn_worker` return immediately with a result?

No. It is two-phase: prepare tab → validate identity → activate → wait for idle composer → insert prompt → click Send once → verify user turn appeared → return `submission_confirmed: true`. Next spawn starts only after prior submission handoff succeeds (`DESKTOP.md:79-85`).

---

## 9. How to Read Submission Confirmation

### Q: What counts as confirmed submission?

Evidence paths in `extention/content.js`:
1. Marker visible in the sent user turn after send (`userTurnHasMarker`). Careful: the
   *pre-click* check at `content.js:1080-1085` is a duplicate **refusal**, not a confirmation —
   if the marker is already in a user turn before clicking, submission aborts with
   `SUBMISSION_UNCERTAIN` and no Send happens. Confirmation requires the marker to appear
   **after** the click.
2. New user turn count increased after send.
3. Composer cleared + new rendered turn.
4. Route change + generation started.
5. Authenticated API snapshot matches expected content.

Paths 2-4 are pre-empted in practice: `content.js:1267` computes `matchedUserTurn=matchedMarker||(…)`
and the ternary at `:1301` tests `matchedMarker` first, so whenever the task UUID is in the dispatch
text (it always is, `background.js:1739`) the reported label is path 1 even when a later path's DOM
facts also held. The label means "which matched first", not "which conditions were true".

### Q: Which evidence path proved a submission?

Read `submission_evidence` in the tool result (added 2026-11-20). Values:
`TASK_MARKER_IN_USER_TURN`, `EXACT_RENDERED_USER_TURN`, `NEW_USER_TURN_AND_CLEARED_COMPOSER`,
`NEW_CONVERSATION_ROUTE_AND_GENERATION`, or `AUTHENTICATED_CHILD_PAIRING` /
`AUTHENTICATED_CHILD_COMPLETION` (set by the reconciliation paths, not by the DOM poll).
The field is absent when no path was ever recorded — an absent field means "unproven", never
"assume the strong path". Before this field existed, every path collapsed to the same
`submission_confirmed: true` boolean and CM-01…CM-05 were unattestable. The discriminator also
now reaches `diagnostics-proxy.jsonl` (`evidenceType` / `proofType` are in `SAFE_FIELDS`).

Path 5 cannot fire on a fresh Child: `content.js:1077` gates it on `chatgptConversationRoute()`,
and a new worker opens at `https://chatgpt.com/` with no `/c/` segment. It is the post-12s
fallback only, reachable from an already-open conversation.

Confirmation timeout: 12 seconds (`content.js:1253,1329`). Poll interval: 200ms.

### Q: What does `SUBMISSION_UNCERTAIN` mean and what do I do?

Thrown when no new user turn or generation detected within 12s, or when account changed mid-submission, or when Send was already attempted (`content.js:1083,1350,1422,1485`).

Action: INSPECT the tab state. Never blind-retry. Check whether the draft remains unsent, whether the user turn appeared but wasn't detected, or whether the account switched. Use Desktop Queue Recovery **Recheck** to examine the original Parent user turn before using **Retry exact draft**.

---

## 10. Common Failure Modes

### Q: "This tool call was blocked by OpenAI's safety checks"

Upstream OpenAI moderation, not a repo defect. Prove it: proxy diagnostics show zero blocked calls reaching the server. The block happened between ChatGPT and OpenAI's backend. No local fix possible; rephrase the prompt.

### Q: Child answers inline and never calls `complete_task`. What actually happens?

**Verified 2026-11-19 by live E2E (E2E-SMOKE-20261119-A).** This is not an infinite hang; it is a three-stage escalation.

1. **Immediate:** the content script reports `{type:'task_done', ok:true, text}` when the assistant turn settles (`content.js:1801`). `background.js:4021-4032` deliberately refuses to turn that into a completion:

   > `A settled assistant chat turn is not a semantic task completion. Retain only a short UI comparison signature; do not notify the Parent until explicit MCP completion or validated fallback.`

   So the task stays `running` and the Parent sees nothing. Parent `get_result` returns `status:"running"`.

2. **After ~5 min (`completionMonitor`, D-042):** the extension reloads the child tab and looks for a validated fallback. **Both** candidate paths now require an explicit final-answer cue, and either is disqualified by an in-progress phrase (`still working`, `waiting for`, `incomplete`, …). The cue vocabulary is `final answer`, `final result`, `completed task`, `task completed`, `here is the result`, `the result is`, `the answer is` — phrase-level, so a bare `answer` does not count. (`background.js:848-859`)
   - `knownCompletion` — the answer contains the recorded `uiCandidate.signature`, is at least **12 characters**, and carries a cue (`background.js:921-927`), OR
   - `monitoredFinalAnswer` — the answer is at least **24 characters** and carries the same cue (`background.js:860-875`).

   The length floors stay because they stop an idle-looking page being read as completion; the cue requirement is what stops a **settled turn** being read as an **answer**. The floors differ on purpose: the signature path has already proved it is reading the same turn the Child settled on, while the marker path only has this task's UUID in the transcript.

   **A bare short answer (e.g. `391`, or a 23-char token with no cue) matches neither, and that is intentional.** Before this change (2026-11-26) a matching signature alone completed the task: because the signature *is* the settled answer, `includes()` was trivially true for any answer ≤140 chars, so the only real gate was `answer.length >= 12` and any 12+ char answer auto-completed. That was D-A.

3. **After retries `[5,3,1]` minutes:** the task becomes `manual_required` (`background.js:823`) and appears in the **Desktop → Completion checks needing your decision** panel with **Completed / In Progress** buttons (`desktop/renderer.js:350-378`). A human decision is the only remaining path.

**Consequence to test for:** a Child that answers briefly without a final-answer cue can never be closed by the Parent; only a Desktop operator can close it. **This is a deliberate product decision, not a bug**, and it is now enforced identically on both completion paths. When writing E2E scenarios, use either a long answer with an explicit cue, or have the child call `complete_task`. See `test-artifacts/failures/D-A-short-answer-never-completes.md`.

You can observe the escalation without guessing:

```powershell
Get-Content "$env:TEMP\chat-orchestrator-session-*\diagnostics-proxy.jsonl" -Tail 30
```

And the Desktop panel is populated from `desktop_completion_status` (`server.js:3208`, `background.js:2378-2400`).

### Q: "Queued / Submission confirmed: No" but child actually answered

Prompt arrived successfully; the defect was the missing completion contract (same root cause as above). The child responded but never signaled completion. Inspect with `read_chat` and `get_result`.

### Q: Duplicate pump/phantom queue entries every 2s

Likely a polling loop or duplicate event emission. Check proxy diagnostics for repeated identical events. Verify coordination storage isn't being written twice per cycle.

### Q: `extension.worker.group_window_mismatch` appears in diagnostics but placement says `success:true`. Is that a failure?

Observed 2026-11-19: `expectedWindowId:1304387189, actualWindowId:1304387125`, followed immediately by `placement_confirmed success:true`. The tab does end up in the managed window, but a mismatch was detected and then discarded rather than retried or surfaced. If the child tab is not visible in the intended group/window, treat this warning as the cause. Otherwise it is a cosmetic inconsistency (finding D-C).

### Q: The extension bridge disconnected mid-session. How long can that last?

Observed gap: `bridge.disconnected` at 13:52:50 → `bridge.connected socketGeneration:2` at 13:58:01 (**5 min 11 s**). Backoff is linear and caps at 15 s with no jitter (`background.js:3516-3520`). Any MCP tool call issued during the outage holds up to 55 s (`waitForExtensionReconnect`, D-029/D-030) then fails. Recovery itself works.

### Q: The child answered correctly but `get_result` still says `running` after 30 minutes. Is the task lost?

No, but it may be waiting on a human. See Section 9 "Child answers inline and never calls `complete_task`." Check the Desktop panel **Completion checks needing your decision**; if the task is listed, the operator must choose Completed / In Progress. This is the D-044 design, not data loss.

### Q: Second `spawn_worker` in the same browser session returns "Spawn blocked". Why?

A prior child submission has not yet been reconciled. `spawnSubmissionHolds` is keyed per `browserSessionId` (`server.js:471,507-533`); the next spawn is held until the previous submission's handoff is verified. Observed 2026-11-19 (finding D-E).

**Correction to catalog LC-12 (measured 2026-11-19/20):** two `spawn_worker` calls issued back-to-back do NOT block each other. Both proceeded and produced tabs `1304387194` and `1304387195`. The serialisation in `serializeWorkerSpawn` is a tail-chained queue (`server.js:500-504`), and the hold only engages AFTER an *unverified* submission. So the real invariant is "concurrent spawning is serialised, not refused", and the block appears only once a submission is ambiguous. Catalog LC-12 is recorded as INVALID_TEST in `e2e-execution-index.json` until corrected.

If the held child is genuinely finished (answered but never called `complete_task`), the hold does not clear on its own. Close the child with `close_worker`, or resolve it through Desktop → **Completion checks needing your decision**, then spawn again. Do not loop `spawn_worker` — it will keep returning the same block.

### Q: `spawn_worker` returns "This tool call was blocked by OpenAI's safety checks"

That error text comes from OpenAI before the call reaches Chat Orchestrator. Proven by: proxy diagnostics show **no** corresponding `mcp.call_completed` for that call. See §10. Reword the prompt — quoted verbatim instructions and imperative-wrapped task text are the usual triggers.

### Q: Proxy restart fails with `ELECTRON_RUN_AS_NODE` error

See Section 2. Clear the env var before restarting.

### Q: Extension fix deployed but behavior unchanged

Extension was not reloaded. Go to managed browser Extensions page, click reload on the extension card. Desktop Connections must show updated version and re-verified status.

### Q: Tailnet/IP auth failures on subagent model keys

Model provider rejected the request based on IP or key scope. Not a proxy defect. Check key permissions and allowed IPs with the provider. Proxy diagnostics show the outbound request succeeded; the 401/403 came back from upstream.

---

## 11. Running the Automated Suite

### Q: How do I run all tests?

The supported configured baseline is:

```powershell
cd d:\Chat-Orchestrator\extention-proxy
npm test
```

**Current coverage caveat (2026-11-19):** `package.json:10` explicitly runs 50 of 51 `*.test.mjs` files; the untracked `test/child-followup-contract.test.mjs` regression is not yet included in that command. Run it separately until the package script is updated in an authorized source change:

```powershell
node --test --test-force-exit test/child-followup-contract.test.mjs
```

Do **not** treat plain `node --test --test-force-exit` discovery as the configured suite: it discovers executable manual/desktop helper scripts, some of which need dedicated profiles, CDP endpoints, a packaged executable or absolute paths. Their failures must be triaged separately.

### Q: The suite reports 11 failures. Are they real defects?

As of 2026-11-19: **329 pass, 11 fail**, and all 11 failures are bare isolated-harness scripts under `test/`, not unit tests. They are top-level-await scripts that `throw` on a missing prerequisite instead of calling `test.skip`.

**2026-11-20 update — the hardcoded-path defect is fixed.** The four scripts that hardcoded `file:///D:/web-chat-automation/extention-proxy/desktop/index.html` now resolve the desktop URL from `import.meta.url`:

```js
const desktopUrl = new URL('../desktop/index.html', import.meta.url).href.toLowerCase();
```

in `isolated-desktop-stop.mjs`, `isolated-electron-exit.mjs`, `isolated-recovery-snapshot.mjs`; `desktop-cdp-smoke.mjs` already used an `endsWith('/extention-proxy/desktop/index.html')` form. `grep -r "D:/web-chat-automation" test/` now returns nothing. Those four are now runnable on any checkout, though they still need CDP/Electron at runtime — so they remain environment-gated, not structurally broken.

The rest need a live CDP browser (:9339 / :9341), the desktop health port, or a packaged `.exe` under `dist/`.

Run only the fast unit suite:

```powershell
node --test --test-force-exit --test-ignore-pattern="**/desktop-cdp-smoke.mjs" --test-ignore-pattern="**/desktop-ui-activation-smoke.mjs" --test-ignore-pattern="**/electron-tray-runtime.mjs" --test-ignore-pattern="**/isolated-desktop-stop.mjs" --test-ignore-pattern="**/isolated-edge-extension-smoke.mjs" --test-ignore-pattern="**/isolated-edge-launcher.mjs" --test-ignore-pattern="**/isolated-electron-exit.mjs" --test-ignore-pattern="**/isolated-manager-observe.mjs" --test-ignore-pattern="**/isolated-profile-port-smoke.mjs" --test-ignore-pattern="**/isolated-recovery-snapshot.mjs" --test-ignore-pattern="**/packaged-extension-settings-smoke.mjs"
```

The two isolated scripts that DO run standalone: `test/isolated-edge-launcher.mjs` (~42 s) and `test/isolated-profile-port-smoke.mjs` (~25 s). Both spawn real browsers and need no pre-running services.

### Q: Why `--test-force-exit`?

Node's built-in test runner keeps the process alive if open handles remain (WebSocket servers, timers). `--test-force-exit` forces termination after all tests complete. Without it, the suite hangs.

### Q: What is the fake-extension-over-WebSocket fixture pattern?

Tests spawn the proxy with `PORT=0`, connect a WebSocket to `/bridge`, and respond to `call` messages with scripted results. No real browser involved. Best template: `test/direct-parent-queue.test.mjs:16-80`. Pattern:

1. Spawn `server.js` with `PORT=0`, `CHAT_ORCH_PROFILE_DIR=<tmpdir>`.
2. Parse stdout for `listening on http://...:<port>`.
3. Connect MCP client to `http://127.0.0.1:<port>/mcp`.
4. Connect WebSocket to `ws://127.0.0.1:<port>/bridge`.
5. Handle `call` messages by method name, return `{type:'result', id, ok:true, result}`.

### Q: How do I write a new regression test?

1. Copy `test/direct-parent-queue.test.mjs` as template.
2. Add your method handlers in the bridge `on('message')` switch.
3. Assert what the extension received (method name + params), not just proxy return values.
4. Use `t.after()` for cleanup (client close, bridge terminate, server kill, tmpdir rm).
5. Add the test filename to `package.json:10` scripts.test list.

---

## 12. Second-pass Requirements / Use-Case / Test-Case Coverage

### Q: Where are the full updated use cases and scenarios?

See `test-artifacts/test-design/e2e-scenario-catalog.md`. The 2026-11-19 deep review preserved the original 150 scenarios and added **125 explicit cases**: **275 unique test cases across 19 use cases**, including their triggering actions, expected assertions, requirement/source references and minimum evidence modes. The priority overlay identifies **124 P0 release-blocker cases**; these numbers are **planned coverage**, not passed automation.

**2026-11-20 correction.** The catalog file as committed contains **84** `### ID:` scenario blocks, while its own header claims 96. The machine-readable index at `test-artifacts/test-design/e2e-execution-index.json` is generated by parsing the real blocks (`test-artifacts/runner/build-index.mjs`) and records the discrepancy in `countDiscrepancy` rather than padding the gap. Do not quote "96" or "275" as executed coverage — those are claims, and only the index reflects what is actually testable today. Current index: 40 P0 (36 unexecuted), 62 parallel-safe P0/P1, 15 exclusive-runtime.

### Q: What new workflows are most likely to be missed by normal unit tests?

- **UC-12 / RC-029–RC-034:** The five-second close-dialog gate, pending-choice authorized calls, admitted-before-Cancel operation finishing after Cancel, and a post-Cancel-created unmanaged Child.
- **UC-10 / CM-063–CM-064 / ST-026:** Interrupted multi-event ACK, and an oversized oldest FIFO event that cannot fit a notification prompt. These are source-risk investigations; inject failures in a disposable journal, never the live user journal.
- **UC-19 / RC-055–RC-059:** Historical manager-recipient incarnation inspection and explicit quarantine; no implicit ACK, replay or event loss.
- **UC-15 / SC-023–SC-033:** Same-key first-response replay (including intentionally stale reads), conflict/revocation checks, write-ahead UNKNOWN after crash, and safe pairing replay policy.
- **UC-03 / LC-051–LC-052 / ST-029:** Multi-PC exact named-connector routing plus extension revision/capability ACK; a connector name is a hint, not authentication.
- **UC-06 / CM-035–CM-043:** Same-Child follow-ups carrying a complete_task contract, one active independent task until Parent review, and clarification retaining the original task ID.

### Q: What counts as proof for a previously synthetic-only flow?

Capture independent tool-call request/response, actual ChatGPT user turn(s), exact child task and parent hierarchy, durable journal event transitions and ACK, and current terminal/review state. Use only an isolated managed Chrome/Edge profile for live acceptance. Do not use BrowserMCP/Playwright/CDP to submit descendant prompts, because this bypasses the Orchestrator path being tested.

Catalog findings G-01–G-10 identify confirmed inventory mismatches and unverified source risks. None of the newly documented test cases should be marked PASS merely because this guide or catalog was updated.

---

## 13. Evidence Rules

### Q: What counts as independent evidence?

- Proxy diagnostics JSONL: `%APPDATA%\Chat Orchestrator\diagnostics-desktop.jsonl`.
- Per-session proxy logs: `%TEMP%\chat-orchestrator-session-<uuid>/`.
- Extension console logs in managed browser DevTools.
- `/health` endpoint responses.
- MCP tool call receipts with `submission_confirmed: true`.

A transport send (WebSocket message dispatched) is NOT proof of processing. Only a matching result/response confirms it.

### Q: How do I take screenshots for evidence?

Use the managed browser's DevTools screenshot capability or OS screenshot tool. Capture the full tab including URL bar. Annotate with timestamp. Store outside the repo.

### Q: Where do diagnostics live and how do they rotate?

Desktop diagnostics: `%APPDATA%\Chat Orchestrator\diagnostics-desktop.jsonl` (persistent across sessions). Per-session proxy logs: `%TEMP%\chat-orchestrator-session-<uuid>/` (created at `desktop/main.mjs:94`, cleaned on confirmed graceful stop at line 1342). Log rotation handled by `loglayer` (2MB/file, 3 files max per `automation-progress.md:26`).

---

## 14. Two-Attempt Rule and Loop Bounds

### Q: A test failed. Can I retry?

Yes, once, under identical conditions. After two identical failures with unchanged state, CHANGE THE APPROACH. Do not loop unbounded.

### Q: A timeout returned unknown state. Can I retry immediately?

No. Inspect state first. Check `/health`, diagnostics, tab state, journal lock. Determine whether the operation partially completed before retrying. Blind retry risks duplicate submissions or corrupted journal entries.

---

## 15. What NOT to Do

### Q: What are the hard prohibitions?

- **Never force-kill** Electron or proxy processes (`Stop-Process`, `taskkill /F`). Always use graceful quit.
- **Never automate Child/Grandchild tabs** with external tools (Playwright, Selenium, CDP, keyboard simulation). Only the Proxy may submit to descendants.
- **Never bypass a broken workflow** to make a test pass. Fix the root cause or document the gap.
- **Never ask the user to run routine commands** that an agent can execute. Reserve user prompts for decisions requiring human judgment.
- **Never claim success without evidence**. Every pass requires independent verification (diagnostics, health check, tool receipt).
- **Never edit a test to match a bug**. Fix the code or file a tracked issue.
- **Never auto-delete journal locks**. Archive (empty) or reconcile manually (non-empty).
- **Never blindly reissue an uncertain prompt**. Inspect first.
- **Never trust chat transcript text alone** as proof of pairing or submission. Verify from proxy-side diagnostics.
- **Never poll `get_result` repeatedly** while waiting for child completion. Finish the assistant response and await orchestrator notification (`server.js:2865`).
- **Never mark a scenario PASS without application-state evidence.** Transcript text alone is insufficient; a skipped assertion cannot yield a PASS.
- **Never leave a Child unreviewed and expect its Parent to advance.** `waiting_for_children` clears only via `review_task`. If you see a permanent stall, check the `child_result` prompt module contains `review_task` before assuming a code defect.
- **Never leave a reviewed Child open and expect the next spawn to succeed.** An open Child tab holds a worker slot until `close_worker` runs. If `spawn_worker` returns `SUB_AGENT_LIMIT_REACHED`, read the tab IDs in the message and close one — do not loop the spawn.