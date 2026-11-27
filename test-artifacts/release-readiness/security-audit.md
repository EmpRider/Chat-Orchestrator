# Security Audit - Chat Orchestrator P0 Event-Driven Coordination

Scope: `D:\Chat-Orchestrator` (`extention-proxy/` + `extention/`). Read-only audit. Evidence: source inspection plus targeted tests (`public-mcp-isolation`, `caller-identity`, `agent-binding-store`, `diagnostics`, `ngrok-diagnostics`, `durable-idempotency`, `profile-token-auth`). No claim of full-suite PASS.

## 1. Threat model

Assets:
- Agent capability credentials (`agent_credential`, 64-hex) and browser pairing offers.
- Encrypted at-rest agent bindings (`mcp-agent-bindings.bin` + `.key`).
- Browser tab ancestry / root-child ownership (`tab-registry.mjs`).
- Browser session IDs, incarnation IDs, connection generations.
- Ngrok transport token (`CHAT_ORCH_PUBLIC_MCP_TOKEN`) and profile token (`CHAT_ORCH_EXTENSION_PROFILE_TOKEN`).
- Durable idempotency replay state and private event journal.

Threats:
- Cross-agent/cross-session tab ID reuse or ancestry escape.
- Stale browser session/incarnation reuse after tab replacement.
- Credential exfiltration or replay through HTTP MCP metadata.
- Ngrok-exposed endpoint bridge/desktop exposure or token comparison leaks.
- Replay or duplicate browser side effects after crash/retry.
- Unbounded resource consumption (journal, events, idempotency, pending closures, body size).
- Secret leakage in diagnostics/logs.
- Extension over-permission or host-scope abuse.

## 2. Trust-boundary map

1. Orchestrator LLM/MCP client -> proxy HTTP:
   - `/mcp` Bearer token or `/mcp/agent/:token` URL token. `server.js:3391-3470`, `3492-3520`.
   - `agent_credential` is mandatory for every tool except pairing. `server.js:2828-2846`.
2. Proxy -> extension WebSocket:
   - Local `/bridge` only, upgrade gated by loopback Host, local remote address, chrome/moz extension Origin. `server.js:3522-3545`.
   - Extension handshake validates `browser_session_id` UUID and `connection_generation >= 1`; profile token timing-safe compare. `server.js:1710-1745`.
3. Extension tab identity -> proxy:
   - `resolveCaller()` verifies live tab incarnation/route hash/browser session and registry record. `server.js:180-260`.
   - Profile manager attestation (`attest_profile_manager`) rechecked. `server.js:228-240`, `profilePrincipalFromExtension()` `server.js:126-164`.
4. Agent credential -> browser tab:
   - One-time pairing offer, opaque 32-byte credential, binding scoped to browser session/tab/incarnation/route hash. `caller-identity.mjs:76-118`.
   - Persisted bindings AES-256-GCM, key file created mode `0o600`; max 200 bindings, max 128KB. `agent-binding-store.mjs:11-48`.
5. Tab ancestry:
   - Session-only registry (`createSessionTabRegistry()`), `within()`, `directChild()`, `hasChildren()`. `tab-registry.mjs:205-235`.
   - Ancestry checks on read/send/close. `server.js:2750-2780`, `2732-2739`.
6. Ngrok public listener:
   - Separate HTTP-only server, no WebSocket upgrade, only `/health`, `/mcp`, `/mcp/agent`. `server.js:3472-3476`, `3492-3520`.
7. Crash recovery:
   - Durable idempotency UNKNOWN marker before side effect; crash returns UNKNOWN. `durable-idempotency.mjs:78-118`.
   - Private journal owner lock fail-closed; no blind replay. `coordination-storage.mjs:24-68`, `server.js:716-740`.

## 3. Critical/high findings

No confirmed critical vulnerability found in audited paths. High-sensitivity conditions are configuration/operation requirements, not code defects:

- H-1: Profile token optional. If `CHAT_ORCH_EXTENSION_PROFILE_TOKEN` is empty, `profileAuthenticated` is false and `profilePrincipalFromExtension()` does not enforce token possession. Safe only for local dev/tests; production must set a 64-hex token. Refs: `server.js:152-156`, `1710-1716`, `1795`.
- H-2: Agent binding key file permissions depend on OS/umask for pre-existing key file; creation uses mode `0o600`, but code does not chmod an existing key. Refs: `agent-binding-store.mjs:12-15`.
- H-3: Extension permissions include `tabs`, `scripting`, `storage`, `alarms`, `tabGroups` and broad host permissions for supported sites. This is expected for functionality but increases blast radius if extension is compromised. Refs: `extention/manifest.json:7-19`.
- H-4: Cross-profile isolation relies on caller supplying/deriving `browser_session_id`; mismatch is rejected, but callers can still address any tab ID that exists in their own verified ancestry. Refs: `server.js:188-215`, `tab-registry.mjs:205-215`.
- H-5: Durable replay capacity and journal limits are enforced, but capacity exhaustion becomes a denial-of-service/reconciliation condition, not automatic recovery. Refs: `durable-idempotency.mjs:84`, `server.js:716-717`, `idempotency.mjs:43-45`.

## 4. Verified controls

- MCP tool auth: `agent_credential` regex 64 hex; resolved to immutable binding; live tab re-verification on every call. Refs: `server.js:2828-2846`, `180-260`.
- Caller tab/session conflicts rejected. Refs: `server.js:188-193`.
- Ancestry: `within()`, `directChild()`, `hasChildren()`; read restricted to descendants; send restricted to direct child/parent; close requires direct child. Refs: `tab-registry.mjs:205-235`, `server.js:2750-2780`, `3079-3092`.
- Session ownership: browser session ID, incarnation ID, connection generation, socket generation. Refs: `server.js:126-180`, `1484-1500`, `1710-1745`.
- Cross-session isolation: tab registry keyed by `sessionId`; `tableFor(sessionId)`; cross-session child registration rejected. Refs: `tab-registry.mjs:56-61`, `registerChild()` `tab-registry.mjs:156-185`.
- Ngrok: Bearer and URL token timing-safe compare; public app 404s unknown paths; `/bridge` upgrade rejected on public listener; no desktop endpoints. Refs: `server.js:3440-3458`, `3492-3520`, `3522-3545`.
- Input validation: zod schemas, UUIDs, safe integers, enums, length caps. Refs: `server.js:2818-2846`, `2930-3260`.
- Replay protection: same key same request replay; same key different request conflict; durable UNKNOWN after crash. Refs: `idempotency.mjs:24-60`, `durable-idempotency.mjs:78-118`.
- Secret handling: diagnostics allowlist and redaction; ngrok diagnostics redact tokens/headers/queries. Refs: `diagnostics.mjs:1-80`, `ngrok-diagnostics.mjs:14-70`.
- Resource limits: journal 32MB/4096 events; idempotency 2048; pending closures 200; body 4MB; registry 200. Refs: `server.js:716-717`, `coordination-storage.mjs:7`, `idempotency.mjs:1`, `durable-idempotency.mjs:12`, `express.json({limit:'4mb'}) server.js:3391`, `closure-store.mjs:6`, `tab-registry.mjs:51`.
- Crash recovery: no blind replay; manual reconciliation required. Refs: `durable-idempotency.mjs:10-18`, `coordination-storage.mjs:18-68`, `reconcileRoot()` `server.js:270-335`.

## 5. Release-blocking conditions

Release is blocked unless all are true:
1. `CHAT_ORCH_EXTENSION_PROFILE_TOKEN` is a valid 64-hex value in production.
2. `CHAT_ORCH_PUBLIC_MCP_TOKEN` is a valid 64-hex value whenever `CHAT_ORCH_PUBLIC_PORT` is set.
3. Proxy binds loopback only when private coordination or public port is enabled. Ref: `server.js:3630-3633`.
4. Agent binding key file exists with mode `0o600` and encrypted bindings load successfully.
5. No secrets appear in diagnostics files or ngrok diagnostics.
6. Cross-profile E2E passes: tab IDs from profile A cannot resolve/read/write in profile B.
7. Crash/restart E2E returns UNKNOWN for interrupted operation and does not replay.
8. Full targeted security test suite passes (not just subset).

## 6. Security-focused E2E scenarios

1. Cross-profile isolation:
   - Pair profile A, pair profile B.
   - Use A credential with B `browser_session_id`/`tab_id`; expect conflict/unregistered caller.
   - Verify `list_tabs` only returns A descendants.
2. Ancestry escape:
   - Parent P, child C1, grandchild G.
   - Attempt read/send from sibling C2 to G; expect denial.
   - Attempt close G from P directly; expect denial.
3. Stale incarnation:
   - Replace child tab; verify read/send denied until manual reconciliation.
4. Ngrok exposure:
   - Request `/bridge`, `/admin`, unknown paths on public port; expect 404/403.
   - Attempt WebSocket upgrade on public port; expect rejection.
   - Verify Bearer and URL token timing-safe paths and no token echo.
5. Replay:
   - Same idempotency key same request -> exact first response.
   - Same key changed request -> conflict.
   - Crash during operation -> restart returns UNKNOWN, no duplicate side effect.
6. Resource exhaustion:
   - Journal >32MB or >4096 events -> reject.
   - Idempotency >2048 -> reject.
   - Pending closures >200 -> reject.
   - HTTP body >4MB -> reject.
7. Secret redaction:
   - Inject bearer/token into diagnostic event; verify redacted in diagnostics file and ngrok output.

## 7. GO/NO-GO recommendation

CONDITIONAL GO. No confirmed critical code-level blocker in audited authentication, authorization, ngrok isolation, replay, or redaction paths. Release is not approved as PASS until all Section 5 conditions and Section 6 E2E scenarios are evidenced. Required evidence:
- Full test run output for security-relevant tests.
- Production configuration proof: profile token, public token, loopback bind.
- File permission proof for `mcp-agent-bindings.bin.key` (`0o600`).
- Cross-profile E2E logs and crash-recovery UNKNOWN transcript.
- Diagnostics redaction sample.