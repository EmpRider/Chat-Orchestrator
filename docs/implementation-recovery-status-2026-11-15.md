# Chat Orchestrator — implementation recovery checkpoint

Date: 2026-11-15
Scope: targeted repairs in existing working tree; no Git reset, commit or full rewrite.
Decision source: Chat Orchestrator Decision Log v1.70 and its confirmed D-001–D-076 requirements.

**D-057 release-scope clarification (2026-11-16):** The Product Owner explicitly
instructed us **not to remove or disable existing Claude/Gemini implementation**.
Keep existing manifest injection entries, adapters, scripts and UI references
for later release work. ChatGPT is the only *officially tested/supported v1*
provider. The previously reported P1 concern about these retained future
integrations is **accepted by the Product Owner**, not a source fix to make.
No provider code, manifest, tests or runtime functionality was altered for
this clarification.

## Fresh requirement-gap repair — November 16, 2026

### D-062 tray Close Managed Browser: missing enrollment UX — November 16, 2026

The Product Owner reported that System Tray → Exit → Close Managed Browser
displayed **Managed browser not verified**. The local default-profile settings
were inspected **without reading any credential values**: selected browser
is Edge, `managedBrowserEnrollment` is absent, and `onboardingComplete`
is false. This is the existing deliberate safety guard, not evidence that
the browser close primitive itself failed. The extension cannot safely infer
that a same-product Edge connection belongs to the *dedicated* profile.
Never bypass D-062 authorization, auto-enroll from focus, or force-close
unrelated browser windows to work around this state.

**Source UX improvement:** When tray Close is chosen without approved
enrollment, or before its pre-dispatch verification succeeds, Desktop
offers **Open Connection Setup / Cancel** rather than a dead-end error.
Choosing Open restores the tray window and navigates to the Connections
view through a one-way, trusted Electron IPC notification. The user can
explicitly inspect the dedicated browser and choose **Verify connected
browser profile** followed by **Finish setup**. No browser is closed on
these failure paths. If a close was *already dispatched* and the result is
uncertain, the app explicitly says some windows may have closed and to
inspect the browser before retrying; no blind replay. Both the original
saved-enrollment guard and live extension identity check remain.

Added `test/tray-connection-setup.test.mjs` to the normal regression
suite, with a simulated navigation event and a source guard for preventing
unverified close. Actual Windows UI and browser closure still require a
non-destructive owner-assisted live acceptance test.

**Verification after tray UX repair:** Targeted D-062/UI/tray tests
**12/12 PASS**; `npm test` **PASS**, including gateway **2/2** and main
regression suite **202/202**; `npm run dist:win` **PASS**; packaged
`PACKAGED_SETTINGS_SMOKE_PASS` **PASS**. Rebuilt unsigned installer:
`extention-proxy/dist/Chat Orchestrator Setup 0.1.3.exe`,
**123,162,991 bytes**, SHA-256
`EDE8C342E83C988306BA6971085284A20B5BE3D7BBBEB51DDE3C5B7F72B6E778`.
This is the latest digest; previous builds using the same development
version number are superseded.

This source continuation addresses the follow-up audit without deleting or
disabling existing Claude/Gemini adapters, extension manifest injections, or
future-oriented UI references. No OAuth or security-framework dependency was
introduced; public MCP used a static Bearer-only header at the time. Existing uncommitted work
was preserved.

### Public custom-MCP URL authentication — November 16, 2026

The Product Owner supplied a screenshot of ChatGPT's Add custom MCP server
showing **No authentication**, no custom-header control, and an access-denied
error with the previous Bearer-only `/mcp` endpoint. Following explicit
instruction, public ingress now supports `/mcp/agent/<key>`, reusing
the existing 256-bit public MCP transport token. The alternate `/mcp`
route **still requires** `Authorization: Bearer <key>`; the token in a
`/mcp` query does not authorize that route. Based on the AgentBridge
route-token source (`/mcp/<routeToken>`), we use a fixed 256-bit token in
the `/mcp/agent/<key>` URL *path*, compared in constant time via fixed SHA-256
digests. The dedicated path rejects
missing, invalid, wrong-length, trailing-slashed, or query-supplemented paths before the public
body parser and keeps private browser-bridge/admin routes unavailable.
Normal MCP pairing, scoped credentials and idempotency remain unchanged; there
is still **no OAuth**.

The Desktop Connections display only shows the safe `/mcp/agent` path.
**Copy Connector URL** is a trusted local IPC action that copies the full
HTTPS URL including the secret route path to the clipboard; the original
**Copy MCP transport key** remains for header-capable clients. Because full
URL paths can appear in tunnel/access logs or screenshots, the complete URL is a
bearer credential and must be treated like a password. Diagnostic output
scrubs token-bearing paths and URL queries. SDK-based no-header MCP tests
are implemented; actual
ChatGPT registration and ngrok live E2E are still **not verified**.

**AgentBridge source-pattern follow-up (2026-11-16):** Inspected
`5258MF/AgentBridge` source files
`src/extension/src/bridge-server.ts` and
`src/extension/src/http-helpers.ts`, plus
`docs/chatgpt-web-connector.en.md`. Its working pattern uses the
`/mcp/<routeToken>` **URL path** and exact constant-time path comparison,
not `?token=` query parameters. The dedicated Chat Orchestrator endpoint
was therefore changed to `/mcp/agent/<256-bit-key>`, with a fixed-length
SHA-256 timing-safe path comparison, no query credential bypass, and
path-token redaction for ngrok diagnostics. The existing independently
persisted 256-bit public MCP key is reused; legacy `/mcp` Bearer is
preserved. The optional shared-domain gateway also forwards the new path.
No OAuth or new identity subsystem.

**Verification after this change:** `npm test` **PASS** (clean-shutdown
gateway suite **2/2**, main suite **200/200**, plus smoke precheck).
Node.js v25.9.0 on Windows crashes with a libuv assertion when
`--test-force-exit` is used on the gateway WebSocket integration file.
Running just that test file without the force-exit flag and awaiting the
actual socket close handshake removes the crash; all other existing tests
retain their original runner mode. `npm run dist:win` **PASS**;
`PACKAGED_SETTINGS_SMOKE_PASS` **PASS**.
Latest **unsigned** NSIS installer at
`extention-proxy/dist/Chat Orchestrator Setup 0.1.3.exe`:
**123,162,583 bytes**, SHA-256
`39BF58CAA93A8E12D403B64CBECED3DC7A12E9868A422FBCF23BEC9618B84DC5`.
This digest supersedes earlier installer references in this document.

- **D-068: Lost Child reconciliation.** An authenticated, verified browser
  inventory after reconnect (and before allocating a new worker) now handles
  managed Child closures missed by a suspended MV3 service worker through the
  same Accident / Yes / Cancel record as ordinary tab removal. No prompt
  replay, silent worker deletion, or task completion is inferred. Failed
  closure persistence leaves the Child tracked for later reconciliation;
  overlapping closed Parent/Child windows retain ancestor precedence.
- **D-072: Child clarification and live Parent enrollment.** An already
  approved, live direct Parent can be re-attested as a private FIFO recipient
  without requiring a *recent* Parent MCP request. The original Child task
  stays pending context, the task-origin URL is carried in the FIFO record,
  and a busy Parent is not interrupted. A genuinely missing/closed Parent
  still requires the existing closure recovery flow; it is not impersonated.
- **D-073: direct Child-to-Parent messages.** `send_to_tab` to the caller's
  *direct* registered Parent now enqueues a typed `CHILD_MESSAGE` in the
  existing authenticated private journal; it returns an event ID and
  `QUEUED`, not a fabricated Child task ID. Parent-to-Child behavior is
  unchanged, and siblings/nonadjacent ancestor writes remain forbidden.
- **D-005/D-010 UX.** Candidate ChatGPT tabs receive an explicit Yes/No
  Parent enrollment offer, with a sticky per-tab No choice and no automatic
  pairing or Child promotion. Cancelled Parent-closure subtrees display an
  unmanaged/orphaned notice inside their still-open ChatGPT tabs after reload.
- **Browser verification retry.** Temporary errors checking a previously
  approved connected browser installation now cause bounded retry, rather
  than a permanent unverified state until another disconnect.
- **D-062 Desktop Quit partial hardening.** The extension now confirms all
  earlier window removals before scheduling final-window close, reports an
  error rather than silently swallowing failures, and removes incorrect
  intentional-exit markers from windows that failed to close. Desktop checks
  these receipts and keeps the Proxy alive through the final attempt. The
  *final* browser-window removal can terminate the extension socket; full
  OS-level closure confirmation still needs real Windows acceptance testing.

Added or updated regression coverage in
`test/task-lifecycle-regression.test.mjs`,
`test/direct-parent-queue.test.mjs`,
`test/ui-redesign-contract.test.mjs` and the Chrome local-storage fixture in
`test/owner-acl.test.mjs`. The new Proxy/MCP/WebSocket integration fixture
uses a simulated extension, not a real logged-in ChatGPT browser.

**Verified results (2026-11-16):** `npm test` **199/199 PASS**,
`npm run dist:win` **PASS**, packaged executable
`PACKAGED_SETTINGS_SMOKE_PASS`, editor diagnostics **0**,
`git diff --check` found no whitespace defects (existing Windows line-ending
warnings only). Rebuilt unsigned Windows x64 NSIS installer:
`extention-proxy/dist/Chat Orchestrator Setup 0.1.3.exe`, **123,161,611
bytes**, SHA-256
`FCB595CAD2465CA4E0B5FF71485FB5CE3628D45EDC44C00CAEF075FDB2EC79E4`.
Earlier installer digests elsewhere in this document are superseded.

**Still outside this patch:** automatic signed Windows installer execution
and upgrade/restart, actual static-Bearer ChatGPT connector interoperability,
real Chrome/Edge UI and store-install E2E, and reliable proof that the final
Chrome/Edge browser process ended. Do not claim release readiness from
offline tests alone.

## Further implementation follow-up — live identity, intentional Quit and update safety

The latest continuation fixes three additional *verified source mismatches*
while retaining the Product Owner's selected **static public Bearer token only**:

- **Current connection is distinct from saved approval.** Desktop reports
  `managedBrowserVerified` only when a fresh, uniquely attested extension
  installation matches the saved browser/product/installation identity. A
  Proxy restart or extension socket swap invalidates that live observation.
  A trusted local Proxy-to-Desktop session-change event catches replacements
  between health polling intervals. Reconnect revalidates automatically
  without asking for approval again when the saved identity still matches.
  Explicit verification, Finish Setup and Close Managed Browser also reject
  browser-selection changes during asynchronous attestation; Quit always
  rechecks the active extension immediately before closing windows.
- **Intentional browser exit survives MV3 worker suspension.** The extension
  records an exact browser-session + tab-ID + incarnation list in local
  storage *before* scheduling explicit Desktop Quit's browser-close side
  effect. This evidence is time-limited (two minutes). If recording fails,
  no windows are scheduled for closure. Normal, stale or foreign-incarnation
  tab closes still require a human Accident / Yes / Cancel choice. Missed
  intentional Parent removals are retired during verified browser inventory
  without fabricating new accidental-closure prompts. A separate source
  persistence bug was corrected: retirement is now saved even if an earlier
  pending closure already exists.
- **Deferred release approval cannot silently age into a different update.**
  The official release metadata is fetched again immediately before a
  previously approved update opens its publisher page; withdrawn or
  superseded versions are held for renewed user review. No automatic
  download, installer execution or Agent-disrupting restart is added.

New test coverage checks the persistent-vs-live enrollment distinction,
stale/incorrect intentional-exit markers, suspended MV3 worker recovery,
no close on storage failure, missed Parent shutdown, and deferred-release
approval. Static Bearer MCP security and the separate local/Agent identity
boundaries were preserved.

**Verification for this follow-up (2026-11-15):** `npm test` **190/190 PASS**
(plus startup smoke); `npm run dist:win` **PASS**; isolated packaged app
`PACKAGED_SETTINGS_SMOKE_PASS`; editor diagnostics **0**; `git diff --check`
found no whitespace errors. Built Setup.exe includes Electron ASAR and the
extension manifest. New unsigned Windows installer:
`extention-proxy/dist/Chat Orchestrator Setup 0.1.3.exe` —
**123,158,848 bytes**, SHA-256
`B2DE2ED06F9BA480FF019E55BA9B61FCA4FE11EB93374B0D8517D4303904E290`.
All older checksums below describe **superseded build outputs**.

**Remaining constraints:** Browser executable/user-data-dir ownership is not
cryptographically attested by an extension; live ChatGPT static-Bearer
connector interoperability, real Edge/Chrome profile E2E, code signing and
clean Windows installation/uninstallation remain external acceptance tasks.

## Latest follow-up — additional mismatch fixes, November 15

The Product Owner requested further source fixes while explicitly retaining
**static Bearer-only public MCP authentication, not OAuth**. Existing uncommitted
changes were preserved; no Git reset, commit, push or live chat/tab action.

- **Browser ownership sanity checks:** The authenticated extension now reports
  browser product (Chrome/Edge) and MV3 manifest version at connection time.
  Setup verification rejects a different selected browser or extension build.
  Browser-wide Close also rejects a different browser product, even if the
  extension install ID is otherwise valid. This is not cryptographic OS
  user-data-dir attestation; real profile checks remain an E2E acceptance task.
- **First-run repair:** A persistent Repair / Reverify extension button is
  accessible after setup. Reinstalling the extension can reset completed
  onboarding, and Finish Setup independently rechecks the current installation
  ID, selected browser product and bundled extension version.
- **Updater stale-state guard:** The extension task/review observation,
  browser inventory observation and Proxy FIFO queue snapshot must all be
  recent. Unknown/stale observations block update handoff rather than
  assuming quiescence. Update Now rechecks the published release before
  accepting approval. An unavailable changed release remains held, not
  repeatedly retried as if it still matched the approved version.
- **Recovered Child accounting:** A reopened Child with explicit direct
  Parent review and a terminal original task no longer leaves the update
  pending forever solely due to an independent lost-worker record that
  has not transitioned its closure status. Unreviewed work still blocks.
- **Minimal public MCP:** Static Bearer remains the only public transport
  authentication. Regression tests assert OAuth and OAuth-discovery routes
  are absent. UI correctly labels bundled unpacked extension installation
  as developer/testing mode; store publication is not claimed.

**Current verification:** Full npm test **184/184 PASS**, standalone smoke
included. Windows NSIS builder **PASS**, isolated packaged executable smoke
**PACKAGED_SETTINGS_SMOKE_PASS**, zero editor diagnostics.
Rebuilt unsigned Windows Setup 0.1.3 EXE size **123,157,380 bytes**,
SHA-256 **4D2A6DF890FB0299C883A41A49BE03A10DBBF292CD6C73F84475E40A202ED58F**.
The older installer hashes below are historical.

**Remaining external verification:** ChatGPT static Bearer connector header
compatibility; real Edge/Chrome + ChatGPT session E2E; native browser-profile
ownership proof; NSIS install/uninstall/upgrade tests; signing/SmartScreen;
and official extension store publication. Do not claim production readiness.

## November 15 — implementation follow-up (newer than the original checkpoint below)

The Product Owner explicitly asked to continue implementation and fix the audited
mismatches. Existing uncommitted code changes were preserved; no Git reset, commit,
push or live browser modification was performed.

- **X setting kept:** D-061 now recognizes the existing persisted enable/disable
  checkbox; enabled means hide X to tray, disabled means explicit D-062 Exit
  confirmation. No blanket always-hide change was made.
- **Browser close safety:** New extension installation enrollment UUID is
  persisted in the extension profile and attested through its authenticated
  loopback session. Only a trusted Desktop action explicitly enrolled by the
  user can request browser-wide Close with a matching stable enrollment ID.
  Missing/mismatched IDs fail closed. This prevents accidental cross-profile
  close for unverified sessions but does **not cryptographically prove**
  the browser's native user-data directory.
- **First-run setup:** A guided Connections section opens on first launch,
  supports installed Chrome/Edge selection, one-time extension installation,
  explicit browser-enrollment verification, and completed-setup persistence.
- **Application updates:** Check trusted GitHub release versions; show visible
  consent-first notice; persist a pending Update Now request; wait for active
  tasks, Parent reviews, unresolved close decisions, and FIFO readiness.
  The safe handoff only opens the authenticated publisher release page for
  **manual** verification/installation. It does not silently download, execute
  or restart the unsigned installer. Auto-install remains deliberately blocked.
- **Documentation:** Updated README and current desktop setup instructions,
  including the independent local WebSocket key, public MCP Bearer transport
  key, per-Agent capability, and the remaining ChatGPT OAuth integration blocker.
- **New tests:** `test/update-policy.test.mjs` covers semver/release trust and
  update quiescence; `test/managed-profile-enrollment.test.mjs` verifies the
  real Proxy-WebSocket mock-extension browser-close consent boundary. Updated
  two older fixtures to model new extension persistent storage/enrollment.

**Verification from the updated working tree:** `npm test` **182 / 182 PASS**
(including the original smoke test). Windows x64 NSIS rebuild **PASS** and
isolated unpacked packaged smoke **PACKAGED_SETTINGS_SMOKE_PASS**.
Installer `extention-proxy/dist/Chat Orchestrator Setup 0.1.3.exe`:
123,156,583 bytes; SHA-256
`B4F0864607243E65CAD56B1C0BD1B5231833F7F37EF0805D85D0F2732118AC9A`.
Electron ASAR and bundled extension manifest exist. The installer remains
**UNSIGNED**.

**Product Owner security clarification (2026-11-15):** Do not add OAuth to MCP;
retain the static public Bearer token with separate local profile and per-Agent
authorization. A proposed OAuth gateway was explicitly rejected and all related
code and Desktop IPC additions were reverted. **Static Bearer compatibility with
the target ChatGPT connector remains unverified**, but this is an interoperability
limitation rather than authorization to add OAuth or remove the token. Real installed
Chrome/Edge + ChatGPT E2E, physical browser-profile attestation, native NSIS
install/uninstall/SmartScreen and signed-installer verification are pending.
Do not label this build production-ready.

**Verification after the explicit static-Bearer correction:** Core syntax checks
PASS; four targeted auth/profile/public-port tests PASS; full `npm test`
**182/182 PASS**. Rebuilt NSIS installer (the previous hash above is obsolete):
`extention-proxy/dist/Chat Orchestrator Setup 0.1.3.exe`,
123,156,526 bytes, SHA-256
`D1AC952CC5C92469EF05B92CC891F2E277D51F475CD823BDAB37CA09ABA83197`.
This is still an **unsigned developer build**.

## Changes implemented

- Browser extension explicitly approves each Parent. One-use pairing offers issue per-Agent opaque MCP credentials. Unregistered tabs do not automatically become Roots.
- Child can pair and recursively delegate. Direct-Parent send/close permissions and all-ancestor read permissions are separated.
- Universal required UUID idempotency keys; in-flight duplicates return the original response. The encrypted operational replay ledger persists first responses and rejected write-ahead uncertainty across Proxy restarts; reusing keys for reads intentionally returns the previous snapshot.
- Per-Child follow-up FIFO and independent-task queue with explicit Parent review; recursive result completion waits for reviewed descendants.
- Ordinary Proxy shutdown preserves managed browser tabs and marks uncertain work; no blind replay.
- Notifications record delegation-origin ChatGPT conversation and route there without forcing OS foreground focus. Events for separate known origins do not share a batch.
- User-selected Windows Chrome/Edge with independent persistent user-data directory, no CDP or remote-debugging flag. Extension still requires once-per-profile installation.
- Separate HTTP-only public MCP/ngrok upstream port. No public WebSocket bridge, even if ngrok alters forwarding headers. A failed public bind fails the complete server startup.
- Windows auto-start user opt-in, default OFF; NSIS installer target selected.
- Tray Quit confirmation: Keep Browser Open, Close Managed Browser, Cancel. Close requires explicit desktop consent and a uniquely connected extension. It closes the connected extension profile's normal browser windows; ownership of the installed dedicated profile is not independently cryptographically attested.
- Public MCP transport requires an independent Bearer credential; local extension WebSocket requires the paired profile connection key, strict local origin/host checks and a verified browser session. Per-Agent pairing remains separate from the transport secret.
- Explicit Child `complete_task`, recursive pending-descendant gate and Parent `review_task` are implemented. Idle ChatGPT UI alone is not completion: the 5-minute / 5,3,1-minute / 2-minute configurable check schedule and manual Completed/In Progress controls are wired into the extension/desktop. Remote generation through refresh remains unverified.
- Child clarification holds the ORIGINAL task ID in `WAITING_FOR_PARENT_CONTEXT`; Parent supplemental context resumes that same task rather than creating another unrelated independent task.
- Approved Parent identity remains tab-stable across provider/conversation navigation, while unsupported pages cannot invoke privileged tools. An unregistered tab cannot gain Parent authority from an absent/undefined incarnation.
- In-page managed Parent/Child status badge is limited to approved ChatGPT tabs. Best-effort visibility-state shim is likewise only injected into managed ChatGPT tabs and does not use CDP.
- User-mediated Parent/Child closure is durably recorded with independent Accident / Yes / Cancel choices. A confirmed missing Parent after outage is reconstructed from live inventory; missing inventory never proves closure.
- Parent Accident now restores the Parent and captured nested Child/Grandchild hierarchy, creating only genuinely closed tabs and reusing verified still-live tabs. Each new Child creation is atomically reserved before the browser API effect; uncertain outcomes never trigger duplicate automatic create. Parent Accident is not marked resolved until every descendant is verified. Partial `restoring_children` operations expose an explicit Resume Accident action, not background replay.
- Notification FIFO journal now resides in the persistent app profile, not the temporary runtime folder; confirmed graceful Proxy restarts release the owner lock while preserving the journal. Crash-stale locks and ambiguous writes still require manual reconciliation.

## Tests

- Full npm test run: **179/179 PASS** (2026-11-15, after recursive Accident restoration, retry/concurrency protections and Proxy-WebSocket transport integration).
- The independent smoke test also passes; the npm test run includes it before the 179 Node tests.
- Local public-port isolation integration: 2/2 pass.
- Lifecycle tests cover recursive completion, restart preservation, FIFO, origin route, desktop consent, missed browser close events, recovery of live/closed descendants, stale-binding retirement and atomic no-duplicate creation.
- A local synthetic Proxy-to-WebSocket recovery integration verifies that failure partway through recursive restoration can resume without recreating the existing Parent or Child.
- Core Node syntax checks passed.
- Windows x64 NSIS installer built successfully from this working tree: `extention-proxy/dist/Chat Orchestrator Setup 0.1.3.exe` (117.45 MiB), SHA-256 `38657CB3C82CBA5DEAA8A1A9E3612967D2D9A5D186579859D2721DE963445EC6`. The build has **no code signing certificate** and is unsigned.
- Verified unpacked Electron ASAR includes `server.js`, `caller-identity.mjs`, `agent-binding-store.mjs`, `durable-idempotency.mjs`, and the Desktop modules; extraResources contains the extension manifest.
- Isolated packaged executable smoke test **PASS** (`PACKAGED_SETTINGS_SMOKE_PASS`): temporary E2E profile, local authenticated browser bridge handshake, settings synchronization and controlled shutdown. This is an unpacked app executable smoke, not an installation test of the NSIS wizard or real browser integration.

Offline/synthetic tests DO NOT establish live ChatGPT browser E2E success.

## Remaining blockers (do not call production-ready)

1. **Real Chrome/Edge + ChatGPT E2E:** dedicated profile/extension installation and pairing, nested Child delegation, provider-composer submission, completion notification at correct origin chat, provider refresh effects, closure/reopen behavior and Desktop quit must be verified with actual sessions. Synthetic tests are not a production sign-off.
2. **Accident recovery identity/review:** a restored tab has a new browser incarnation; existing AI conversations may not immediately possess a usable fresh MCP pairing credential. The original task is held UNCERTAIN rather than replayed or declared complete, and further manual review/reconciliation may be required before reusing that seat.
3. **Crash/restart ambiguity:** a browser API create that was dispatched but never acknowledged stays in a durable `creating` hold and requires manual owner verification; a stale journal owner lock is never deleted automatically. Unverified closure records remain visible rather than silently resolved.
4. **External connectivity and trust:** test the chosen ChatGPT MCP connector's handling of the required public HTTP Bearer token and verify dedicated-browser-profile ownership end to end; HTTP discovery and browser tab observations alone cannot prove a physical originating conversation.
5. **Installation/distribution:** NSIS Setup.exe now builds and packaged resources / isolated app startup have been verified. Actual NSIS installation/uninstallation, Windows trust/code-signing, SmartScreen behavior and official Chrome Web Store / Edge Add-ons publication are **not** verified. Rebuild after any further code changes.
6. **Updates/provider scope:** user-consent auto-updater is not complete. Only ChatGPT is officially supported in v1; legacy Claude/Gemini code remains and should not be advertised as supported. Avoid broad refactoring until real E2E behavior is stable.

Do not put private user conversations, Agent credentials or raw debug tokens into this report.
