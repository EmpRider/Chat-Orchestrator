# Chat Orchestrator — P0 Event-Driven Agent Coordination

**Saga source of truth:** Project #4, "Chat Orchestrator — P0 Event-Driven Agent Coordination."
**Working tree:** `D:\web-chat-automation` — `feat/p0-event-driven-agent-coordination`.
**Approved base:** `main` and feature HEAD originally `660e1a6a28673e306f02c6a071b12ed41d828534`.
**Owner decisions:** DESIGN APPROVED, PLAN APPROVED, START (2026-11-04); pre-code GitHub push expressly waived then; on 2026-11-05 owner explicitly authorized detailed Git commits and remote push. This ledger is catch-up publication; no claim it existed remotely before source editing.

## Scope and acceptance

Implement a trustworthy Windows Electron 45 / Chrome/Edge Chat Orchestrator event-driven manager/child coordination layer. Use AgentBridge Worker Tool, one active epic/PM and major task/TL, reusable Council/Watchdog seats, private principal-bound queue, orderly status/result batching, explicitly acknowledged processing, independently read-back-verified Saga completion, and parent-authorized closure. Preserve existing Ngrok/tray and six public Worker Tool operations. Storage/uncertain external side effects fail closed. Out of scope: editing Code Anime, changing upstream chat services, claims of true exactly-once LLM/Saga execution, automatic stale lock removal without owner proof, and a dependency/SQLite architecture switch without explicit separate evidence.

## Current Saga work breakdown (snapshot 2026-11-05 Asia/Colombo)

The **Saga MCP board**, not this file, contains the authoritative live statuses. This file records code/acceptance/Git traceability at catch-up publication; refresh only after verified changes.

| Saga ID | Role and milestone | Prerequisites | Recorded Saga state | Evidence/remaining acceptance |
| --- | --- | --- | --- | --- |
| #60–64 | BA/PM/TL plan, design, readiness, branch, START | sequential approved Council/Watchdog gates | DONE (Saga) | design/plan/START; original branch base verified |
| #65 I01 | TL/S1: persistent proxy FIFO / journal | #64 | IN_PROGRESS | private journal and tests; #129 unknown delivery/crash owner recovery and #131 independent review remain IN_PROGRESS; Windows stale-lock/power-loss guarantees unproven |
| #67 I03 | Security: principal/owner authorization | #65 | BLOCKED | #137–141 subtasks DONE, full parent still dependency-blocked; `principal-auth.mjs`, `server.js`, `scoped-mcp-auth.test.mjs` |
| #66 I02 | Extension: manager idle/batched delivery | #65, #67 | BLOCKED | #132–136 subtasks DONE, full parent dependency-blocked; `extention/background.js`, `content.js` |
| #68 I04 | PM/TL: Saga-first completion/closure | #66, #67 | BLOCKED | #142–146 subtasks DONE; independent Saga readback and closure hold tests; parent remains blocked |
| #69 I05 | UI: compact proxy + extension state | #66, #67, #68 | BLOCKED | #147–151 subtasks DONE; dark connected/disconnected/busy/queued/unknown local visual evidence |
| #70 I06 | Agent/team prompts and replacement skill | #68 | BLOCKED | #152–155 DONE; #156 skill consistency and remote Git sync pending; new `skills/agent-team/SKILL.md` is a copy-derived replacement, installed original untouched |
| #71 V01 | QA: FIFO/Saga lifecycle | #68, #69, #70 | BLOCKED | #157–161 subtasks DONE, parent dependencies unmet; synthetic contract smoke |
| #72 V02 | QA: security/Windows compatibility | #65, #66, #67, #69 | BLOCKED | #162, #163, #165, #166 DONE; #164 live Chrome/Ngrok/tray and Worker Tool regression TODO |
| #73 V03 | Independent Watchdog/Council final acceptance | #71, #72 | BLOCKED | #167–171 TODO; do not claim final GO or user acceptance |
| #74 P04 | PM/Git coordinator: approved GitHub catch-up publication | #63, #64 | BLOCKED at snapshot | #172–173 DONE, #174–176 pending remote SHA, detailed commit, and user authorization reconciliation |

## Source and responsibility inventory

- **Backend S1/security:** `extention-proxy/server.js`; new `extention-proxy/principal-auth.mjs`, `desktop/coordination-storage.mjs`; secret-safe storage, default-deny scopes, immutable event/journal transitions, bounded FIFO, dedupe, owner/reconnect checks.
- **Extension S2:** `extention/background.js`, `content.js`, `popup.html`, `popup.js`; detected busy/idle/unknown states, protected manager batching, source-incarnation completion, reusable role prompts.
- **Desktop S3:** `extention-proxy/desktop/{main.mjs,preload.cjs,index.html,renderer.js,style.css}`; authenticated status surfaces, compact dashboard, task hierarchy, event/UNCERTAIN states, tray integration.
- **Tests/verification:** `extention-proxy/test/*` security, scoped auth, journal, private coordination, UI; isolated Windows Electron/browser probes. One full `npm --prefix D:\web-chat-automation\extention-proxy test` pass on 2026-11-05: **61 tests, 61 PASS, 0 FAIL, 0 SKIP**; `git diff --check` exit 0. This does not certify external live production delivery.
- **Skill:** `skills/agent-team/SKILL.md` new, copy-derived from `C:\Users\Empire Rider\.claude\skills\agent-team\SKILL.md`; source SHA-256 `6C2E6A18FCB6BCC61E733FB7EC9F218E3F6E86FFF8AEC890E873F2D49BC6BED1`. Adds scope/auth/role-seat, Saga/ACK, storage and Git-waiver integration. Not installed automatically.

## Verification and release hold

- Require a single coordinated final smoke at the final integrated SHA: three child completions, status interleaving, busy-to-idle single batch, reconnect, cross-principal denial, six Worker Tool operations, `UNCERTAIN` no replay, Saga mismatch preventing early tab close, Ngrok/tray, Chrome+Edge and Windows portable build. Report each as PASS, FAIL or NOT RUN.
- Windows journal lock ownership and directory-entry power-loss durability are not independently proved. Manual reconciliation remains necessary. An isolated package build or Edge/CDP probe cannot be called a successful live Ngrok/Chrome production test.
- Preserve blocked Saga parent state and independent Watchdog/TL/QA sign-offs until evidence. Ask BA for final user acceptance; do not automatically delete this ledger or the new skill file.
- The publication commit should include this ledger and only reviewed P0 code/tests/skill changes, with detailed scope, evidence, risks, and verified remote SHA. **No force push to main.**
