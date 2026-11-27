# Chat Orchestrator — P0 Event-Driven Agent Coordination

**Saga source of truth:** Project #4, "Chat Orchestrator — P0 Event-Driven Agent Coordination."
**Working tree:** `D:\Chat-Orchestrator` — `feat/p0-event-driven-agent-coordination`.
**Approved base:** `main`; feature HEAD `4f0692456b435890cc511601e5be79934bae8a43` (origin/feat/... at `603511a`; local is 1 commit ahead, push pending).
**Owner decisions:** DESIGN APPROVED, PLAN APPROVED, START (2026-11-04); pre-code GitHub push expressly waived then; on 2026-11-05 owner explicitly authorized detailed Git commits and remote push. This ledger is catch-up publication; no claim it existed remotely before source editing.
**Last housekeeping refresh:** 2026-11-26 (full `npm test` pass + `git diff --check` clean).

## Scope and acceptance

Implement a trustworthy Windows Electron 45 / Chrome/Edge Chat Orchestrator event-driven manager/child coordination layer. Use AgentBridge Worker Tool, one active epic/PM and major task/TL, reusable Council/Watchdog seats, private principal-bound queue, orderly status/result batching, explicitly acknowledged processing, independently read-back-verified Saga completion, and parent-authorized closure. Preserve existing Ngrok/tray and six public Worker Tool operations. Storage/uncertain external side effects fail closed. Out of scope: editing Code Anime, changing upstream chat services, claims of true exactly-once LLM/Saga execution, automatic stale lock removal without owner proof, and a dependency/SQLite architecture switch without explicit separate evidence.

## Current Saga work breakdown (snapshot 2026-11-26)

The **Saga MCP board**, not this file, contains the authoritative live statuses. This file records code/acceptance/Git traceability; refresh only after verified changes.

| Saga ID | Role and milestone | Prerequisites | Recorded Saga state | Evidence/remaining acceptance |
| --- | --- | --- | --- | --- |
| #60–64 | BA/PM/TL plan, design, readiness, branch, START | sequential approved Council/Watchdog gates | DONE (Saga) | design/plan/START; branch base verified |
| #65 I01 | TL/S1: persistent proxy FIFO / journal | #64 | IN_PROGRESS | private journal + tests; journal lock management/recovery shipped (5ca176c, 603511a, 4f06924); auto-reconcile stuck DELIVERED batches + queue_blocked surfacing added; #129 owner recovery improved but not independently proven; #131 independent review pending; Windows stale-lock/power-loss durability still unproven |
| #67 I03 | Security: principal/owner authorization | #65 | BLOCKED | #137–141 subtasks DONE; authorization lives in `server.js` + `caller-identity.mjs` (no separate `principal-auth.mjs` module); full parent dependency-blocked |
| #66 I02 | Extension: manager idle/batched delivery | #65, #67 | BLOCKED | #132–136 subtasks DONE; full parent dependency-blocked; `extention/background.js`, `content.js` |
| #68 I04 | PM/TL: Saga-first completion/closure | #66, #67 | BLOCKED | #142–146 subtasks DONE; independent Saga readback and closure hold tests; parent remains blocked |
| #69 I05 | UI: compact proxy + extension state | #66, #67, #68 | BLOCKED | #147–151 subtasks DONE; dark connected/disconnected/busy/queued/unknown local visual evidence |
| #70 I06 | Agent/team prompts and replacement skill | #68 | BLOCKED | #152–155 DONE; #156 skill consistency and remote Git sync pending; `skills/agent-team/SKILL.md` copy-derived (SHA-256 a14038f920fb19065927ae6b784d8b0adfcab3e239d31ed7dc37d0d7463f279e) |
| #71 V01 | QA: FIFO/Saga lifecycle | #68, #69, #70 | BLOCKED | #157–161 subtasks DONE, parent dependencies unmet; synthetic contract smoke |
| #72 V02 | QA: security/Windows compatibility | #65, #66, #67, #69 | BLOCKED | #162, #163, #165, #166 DONE; #164 live Chrome/Ngrok/tray and Worker Tool regression TODO |
| #73 V03 | Independent Watchdog/Council final acceptance | #71, #72 | BLOCKED | #167–171 TODO; do not claim final GO or user acceptance |
| #74 P04 | PM/Git coordinator: approved GitHub catch-up publication | #63, #64 | BLOCKED at snapshot | #172–173 DONE; #174–176 pending remote SHA, detailed commit, and user authorization reconciliation. Local HEAD 1 commit ahead of origin; push not yet performed |

## Source and responsibility inventory

- **Backend S1/security:** `extention-proxy/server.js`; authorization in `extention-proxy/caller-identity.mjs`; secret-safe storage, default-deny scopes, immutable event/journal transitions, bounded FIFO, dedupe, owner/reconnect checks. (Ledger previously referenced `principal-auth.mjs`; that module does not exist — authorization is inlined in server.js + caller-identity.mjs.)
- **Extension S2:** `extention/background.js`, `content.js`, `popup.html`, `popup.js`; detected busy/idle/unknown states, protected manager batching, source-incarnation completion, reusable role prompts.
- **Desktop S3:** `extention-proxy/desktop/{main.mjs,preload.cjs,index.html,renderer.js,style.css}`; authenticated status surfaces, compact dashboard, task hierarchy, event/UNCERTAIN states, tray integration.
- **Tests/verification:** `extention-proxy/test/*` security, scoped auth, journal, private coordination, UI; isolated Windows Electron/browser probes. Full `npm test` on 2026-11-26: **333 tests, 333 PASS, 0 FAIL, 0 SKIP** across 51 wired test files; `git diff --check` exit 0. 12 additional untracked regression test files (child-followup-contract, cm06-14-confirmation-timeout, da-completion-boundary, endurance-st05, fifo-oversized-event, lc16-review-task-gate, rc10-pairing-reconciliation, reconcile-predecessors-lce7, recovery-rc-scenarios, recovery-rc13-interrupted-ack, transport-outage, transport-rc02-st03) each pass individually; not yet wired into `npm test` script. This does not certify external live production delivery.
- **Skill:** `skills/agent-team/SKILL.md` new, copy-derived from `C:\Users\Empire Rider\.claude\skills\agent-team\SKILL.md`; source SHA-256 `6C2E6A18FCB6BCC61E733FB7EC9F218E3F6E86FFF8AEC890E873F2D49BC6BED1` (current working copy SHA-256 `a14038f920fb19065927ae6b784d8b0adfcab3e239d31ed7dc37d0d7463f279e`). Adds scope/auth/role-seat, Saga/ACK, storage and Git-waiver integration. Not installed automatically.

## Verification and release hold

- Require a single coordinated final smoke at the final integrated SHA: three child completions, status interleaving, busy-to-idle single batch, reconnect, cross-principal denial, six Worker Tool operations, `UNCERTAIN` no replay, Saga mismatch preventing early tab close, Ngrok/tray, Chrome+Edge and Windows portable build. Report each as PASS, FAIL or NOT RUN.
- Windows journal lock ownership and directory-entry power-loss durability are not independently proved. Manual reconciliation remains necessary. An isolated package build or Edge/CDP probe cannot be called a successful live Ngrok/Chrome production test.
- Preserve blocked Saga parent state and independent Watchdog/TL/QA sign-offs until evidence. Ask BA for final user acceptance; do not automatically delete this ledger or the new skill file.
- The publication commit should include this ledger and only reviewed P0 code/tests/skill changes, with detailed scope, evidence, risks, and verified remote SHA. **No force push to main.**
- Housekeeping note (2026-11-26): `npm test` = 333/333 pass; 12 untracked regression tests pass individually; `git diff --check` clean; local HEAD 4f06924 is 1 commit ahead of origin (push pending, user authorization required); `principal-auth.mjs` does not exist (auth inlined).

