# Default Edge profile E2E findings — 2026-11-07

**Status: BLOCKED. Not A–Z verified.** These are real runtime findings, not isolated-profile results.

## Environment
- Live local Proxy 127.0.0.1:8787 healthy and connected to Edge extension.
- Existing default Edge profile; dedicated new ChatGPT test root tab 269061263. Existing user tabs untouched. No proxy/extension/browser restart.
- Installed Worker Tool connector schema does not declare required caller_tab_id; live Proxy schema does. Direct MCP requests with caller_tab_id were necessary.

## Verified on the actual default profile
- Register test root and verify empty initial queue: PASS.
- Simultaneous worker spawn: FAIL: Could not place worker in its root tab group: Worker tab grouping could not be confirmed.
- 18 simultaneous status-request events: PASS, all 18 unique persisted; duplicate idempotency key returned same original event.
- Invalid ACK before delivery: rejected (PASS).
- 16-event batch delivery: first 16 DELIVERED; remaining 2 QUEUED (16-item cap enforced).
- Queue reading immediately afterward: FAIL: Caller tab session/incarnation changed; manual registry reconciliation required.
- Read-only journal integrity valid; 66 total frames, 18 events for test root: 16 DELIVERED, 2 QUEUED, 0 PROCESSED.

## Source changes, not live-deployed
- extention/background.js now preserves manager tab incarnation across same-site conversation URL navigation; leaving the chat provider still revokes it.
- extention-proxy/test/owner-acl.test.mjs includes same-site navigation regression assertion.
- Source syntax check PASS; targeted owner regression 1/1 PASS; full npm test 81/81 PASS.

## Important limits and recovery
- No real worker response/fixing loop or full concurrent worker FIFO passed in this default-profile round because worker spawn failed.
- Do not replay, ACK, delete, or truncate 16 unresolved delivered events without inspecting the actual manager chat; delivered does not prove processed.
- Running Edge extension's group error differs from the workspace source's text; verify installed extension source/version before rerunning.
- Existing journal owner lock is legitimate while Proxy runs; do not manually delete it.
- After explicit decision on safe journal reconciliation and extension reload, rerun default-profile worker/multi-message/concurrency/ACK/reconnect/loss scenarios.

## Evidence
- D:\web-chat-automation\default-profile-source-regression-20261107.log
- D:\web-chat-automation\default-profile-root-navigation-regression.log
- AgentBridge terminal history contains actual Proxy MCP errors, queue counts and read-only replay.

No Git commit, push, release or production restart performed.
