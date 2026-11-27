# E2E Scenario Catalog

Generated from source and decision log. Total scenarios: 268

## E2E-START-001 — Electron app starts and proxy listens on 8787

```yaml
id: E2E-START-001
title: "Electron app starts and proxy listens on 8787"
category: startup
priority: P0
source_references:
  - "extention-proxy/package.json:12"
  - "extention-proxy/server.js:29"
  - "docs/E2E_TESTING_GUIDE.md:startup"
requirements:
  - "D-001"
preconditions:
  - "Node>=18"
  - "no stale journal lock"
setup:
  - "npm run desktop with ELECTRON_RUN_AS_NODE cleared"
stimulus:
  - "Launch desktop"
expected_mcp_calls:
  - "GET /health"
expected_events:
  - "proxy_started"
expected_state:
  - "ok:true, extensionConnected:false initially"
assertions:
  - "port 8787 bound"
  - "health ok"
failure_injection:
timeout: "60s"
cleanup:
  - "graceful quit"
browsermcp_boundary: ["none", "desktop launched by operator"]
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-START-002 — ELECTRON_RUN_AS_NODE=1 prevents Electron launch

```yaml
id: E2E-START-002
title: "ELECTRON_RUN_AS_NODE=1 prevents Electron launch"
category: startup
priority: P0
source_references:
  - "docs/E2E_TESTING_GUIDE.md:electron run as node"
  - "extention-proxy/test/isolated-electron-exit.mjs"
requirements:
  - "D-002"
preconditions:
  - "VS Code integrated terminal"
setup:
  - "set env var"
stimulus:
  - "npm run desktop"
expected_mcp_calls:
expected_events:
expected_state:
  - "process exits as node, no BrowserWindow"
assertions:
  - "detect SyntaxError BrowserWindow"
failure_injection:
timeout: "30s"
cleanup:
  - "unset env"
browsermcp_boundary: ["none"]
execution_mode: automated
automation_status: automated
```

## E2E-START-003 — Missing log directory causes redirect failure before Electron

```yaml
id: E2E-START-003
title: "Missing log directory causes redirect failure before Electron"
category: startup
priority: P2
source_references:
  - "docs/E2E_TESTING_GUIDE.md:DirectoryNotFoundException"
requirements:
  - "D-002"
preconditions:
setup:
  - "Tee-Object to nonexistent dir"
stimulus:
  - "launch"
expected_mcp_calls:
expected_events:
expected_state:
  - "exit 255, Electron never starts"
assertions:
  - "exit code 255"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-START-004 — Stale journal lock blocks startup with modal

```yaml
id: E2E-START-004
title: "Stale journal lock blocks startup with modal"
category: startup
priority: P0
source_references:
  - "extention-proxy/desktop/main.mjs:134"
  - "extention-proxy/desktop/coordination-storage.mjs:92"
requirements:
  - "D-024"
preconditions:
  - "lock owned by dead pid"
setup:
  - "seed lock"
stimulus:
  - "npm run desktop"
expected_mcp_calls:
expected_events:
  - "startup_blocked"
expected_state:
  - "modal shown"
assertions:
  - "no silent exit"
failure_injection:
timeout: "30s"
cleanup:
  - "reconcile"
browsermcp_boundary: ["none"]
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-START-005 — Health endpoint reports storageReady true

```yaml
id: E2E-START-005
title: "Health endpoint reports storageReady true"
category: startup
priority: P0
source_references:
  - "extention-proxy/server.js:3238-3243"
requirements:
  - "D-001"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "GET /health"
expected_mcp_calls:
expected_events:
  - "health_ok"
expected_state:
  - "coordination.storageReady:true"
assertions:
  - "enabled legacy false ignored"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-START-006 — Single instance lock prevents second desktop

```yaml
id: E2E-START-006
title: "Single instance lock prevents second desktop"
category: startup
priority: P0
source_references:
  - "extention-proxy/desktop/main.mjs:134-136"
requirements:
  - "D-001"
preconditions:
setup:
  - "app running"
stimulus:
  - "launch second"
expected_mcp_calls:
expected_events:
expected_state:
  - "second quits"
assertions:
  - "no duplicate listeners"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-START-007 — Profile settings load and disabled defaults

```yaml
id: E2E-START-007
title: "Profile settings load and disabled defaults"
category: startup
priority: P0
source_references:
  - "extention-proxy/agent-settings.mjs:99"
  - "extention-proxy/server.js:53-67"
requirements:
  - "D-048"
preconditions:
setup:
  - "missing settings.json"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
expected_state:
  - "disabledAgentSettings"
assertions:
  - "automation disabled by default"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-START-008 — Extension profile token generated persisted

```yaml
id: E2E-START-008
title: "Extension profile token generated persisted"
category: startup
priority: P2
source_references:
  - "extention-proxy/desktop/main.mjs:156-168"
requirements:
  - "D-004"
preconditions:
setup:
  - "first run"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
expected_state:
  - "token file exists"
assertions:
  - "token length 64 hex"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-START-009 — Managed browser launches with dedicated profile

```yaml
id: E2E-START-009
title: "Managed browser launches with dedicated profile"
category: startup
priority: P0
source_references:
  - "extention-proxy/desktop/managed-browser.mjs"
requirements:
  - "D-002"
  - "D-003"
preconditions:
setup:
  - "settings saved"
stimulus:
  - "start desktop"
expected_mcp_calls:
expected_events:
  - "browser_launched"
expected_state:
  - "managed profile dir used"
assertions:
  - "not personal profile"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-START-010 — Auto launch browser toggle respected

```yaml
id: E2E-START-010
title: "Auto launch browser toggle respected"
category: startup
priority: P2
source_references:
  - "docs/chat_orchestrator_decision_log.md:D-060"
requirements:
  - "D-060"
preconditions:
setup:
  - "toggle off"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
expected_state:
  - "no browser launch"
assertions:
  - "toggle behavior"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-MCP-001 — MCP POST /mcp with Bearer transport key

```yaml
id: E2E-MCP-001
title: "MCP POST /mcp with Bearer transport key"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:3268"
  - "extention-proxy/server.js:3424"
requirements:
  - "D-038"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "POST /mcp with Bearer"
expected_mcp_calls:
  - "initialize"
expected_events:
  - "mcp_initialized"
expected_state:
  - "sessionless transport"
assertions:
  - "200 JSON-RPC"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-002 — MCP URL token route /mcp/agent/:token

```yaml
id: E2E-MCP-002
title: "MCP URL token route /mcp/agent/:token"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:3300"
  - "extention-proxy/server.js:3457-3458"
requirements:
  - "D-038"
preconditions:
setup:
  - "valid token"
stimulus:
  - "POST /mcp/agent/<token>"
expected_mcp_calls:
  - "initialize"
expected_events:
  - "mcp_initialized"
expected_state:
  - "valid"
assertions:
  - "200"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-003 — Invalid MCP URL token returns 401

```yaml
id: E2E-MCP-003
title: "Invalid MCP URL token returns 401"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:3446-3455"
requirements:
  - "D-038"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "POST invalid token"
expected_mcp_calls:
expected_events:
expected_state:
  - "401 jsonrpc error"
assertions:
  - "code -32001"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-004 — GET/DELETE /mcp return 405

```yaml
id: E2E-MCP-004
title: "GET/DELETE /mcp return 405"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:3460-3469"
requirements:
  - "D-038"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "GET /mcp"
expected_mcp_calls:
expected_events:
expected_state:
  - "405 Allow POST"
assertions:
  - "method not allowed"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-005 — Public MCP port isolation

```yaml
id: E2E-MCP-005
title: "Public MCP port isolation"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:34-43"
  - "extention-proxy/test/public-mcp-isolation.test.mjs"
requirements:
  - "D-038"
preconditions:
setup:
  - "public port configured"
stimulus:
  - "connect public"
expected_mcp_calls:
  - "tools/list"
expected_events:
  - "public_tools"
expected_state:
  - "no private tools unless paired"
assertions:
  - "isolation"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-006 — Agent credential required for non-pair tools

```yaml
id: E2E-MCP-006
title: "Agent credential required for non-pair tools"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:2827-2854"
requirements:
  - "D-008"
  - "D-037"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "call list_tabs without credential"
expected_mcp_calls:
expected_events:
expected_state:
  - "missing credential error"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-007 — Idempotency key required for all tools

```yaml
id: E2E-MCP-007
title: "Idempotency key required for all tools"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:2836"
  - "docs/chat_orchestrator_decision_log.md:D-033"
requirements:
  - "D-033"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "call without idempotency_key"
expected_mcp_calls:
expected_events:
expected_state:
  - "validation error"
assertions:
  - "required"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-008 — Same idempotency key replays first response

```yaml
id: E2E-MCP-008
title: "Same idempotency key replays first response"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:2827-2854"
  - "extention-proxy/durable-idempotency.mjs"
requirements:
  - "D-034"
preconditions:
setup:
  - "paired agent"
stimulus:
  - "retry same key"
expected_mcp_calls:
  - "list_tabs x2"
expected_events:
  - "replay"
expected_state:
  - "identical response"
assertions:
  - "no duplicate side effects"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-009 — Different idempotency keys create distinct operations

```yaml
id: E2E-MCP-009
title: "Different idempotency keys create distinct operations"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/idempotency.mjs"
requirements:
  - "D-035"
preconditions:
setup:
  - "paired agent"
stimulus:
  - "two calls new keys"
expected_mcp_calls:
  - "spawn_worker x2"
expected_events:
  - "two tasks"
expected_state:
  - "two task_ids"
assertions:
  - "not deduped"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MCP-010 — Extension websocket bridge connects

```yaml
id: E2E-MCP-010
title: "Extension websocket bridge connects"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:3347"
  - "extention/background.js:connect"
requirements:
  - "D-028"
preconditions:
setup:
  - "extension loaded"
stimulus:
  - "start proxy after extension"
expected_mcp_calls:
expected_events:
  - "bridge_connected"
expected_state:
  - "extensionConnected:true"
assertions:
  - "health reflects"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-MCP-011 — Extension reconnect after proxy restart

```yaml
id: E2E-MCP-011
title: "Extension reconnect after proxy restart"
category: mcp_connection
priority: P0
source_references:
  - "extention/background.js:preserveOnProxyReconnect"
  - "docs: D-028"
requirements:
  - "D-028"
preconditions:
setup:
  - "proxy restart"
stimulus:
  - "restart proxy"
expected_mcp_calls:
expected_events:
  - "reconnect"
expected_state:
  - "session preserved"
assertions:
  - "no duplicate registration"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-MCP-012 — Hold browser-dependent MCP calls during transient disconnect

```yaml
id: E2E-MCP-012
title: "Hold browser-dependent MCP calls during transient disconnect"
category: mcp_connection
priority: P0
source_references:
  - "extention-proxy/server.js:1497-1522"
  - "docs:D-029"
requirements:
  - "D-029"
preconditions:
setup:
  - "extension disconnected briefly"
stimulus:
  - "call during disconnect"
expected_mcp_calls:
  - "any browser tool"
expected_events:
  - "held"
expected_state:
  - "timeout if >55s"
assertions:
  - "no immediate failure"
failure_injection:
timeout: "90s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-NGROK-001 — ngrok tunnel auto starts with proxy

```yaml
id: E2E-NGROK-001
title: "ngrok tunnel auto starts with proxy"
category: ngrok
priority: P1
source_references:
  - "extention-proxy/desktop/ngrok-reuse.mjs"
  - "docs:D-069"
requirements:
  - "D-069"
preconditions:
setup:
  - "authtoken configured"
stimulus:
  - "start desktop"
expected_mcp_calls:
expected_events:
  - "ngrok_started"
expected_state:
  - "public url"
assertions:
  - "tunnel active"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-NGROK-002 — Reuse existing ngrok tunnel

```yaml
id: E2E-NGROK-002
title: "Reuse existing ngrok tunnel"
category: ngrok
priority: P2
source_references:
  - "extention-proxy/desktop/ngrok-reuse.mjs"
requirements:
  - "D-069"
preconditions:
setup:
  - "tunnel running"
stimulus:
  - "start second"
expected_mcp_calls:
expected_events:
expected_state:
  - "reused"
assertions:
  - "no duplicate process"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NGROK-003 — ngrok diagnostics parse logs

```yaml
id: E2E-NGROK-003
title: "ngrok diagnostics parse logs"
category: ngrok
priority: P2
source_references:
  - "extention-proxy/desktop/ngrok-diagnostics.mjs"
requirements:
  - "D-069"
preconditions:
setup:
  - "log file"
stimulus:
  - "read diagnostics"
expected_mcp_calls:
expected_events:
expected_state:
  - "parsed status"
assertions:
  - "no crash"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NGROK-004 — ngrok domain normalization

```yaml
id: E2E-NGROK-004
title: "ngrok domain normalization"
category: ngrok
priority: P2
source_references:
  - "extention-proxy/desktop/config.mjs"
requirements:
  - "D-069"
preconditions:
setup:
  - "settings"
stimulus:
  - "save domain"
expected_mcp_calls:
expected_events:
expected_state:
  - "normalized"
assertions:
  - "validation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NGROK-005 — Public MCP token required on public port

```yaml
id: E2E-NGROK-005
title: "Public MCP token required on public port"
category: ngrok
priority: P1
source_references:
  - "extention-proxy/server.js:34-43"
requirements:
  - "D-038"
preconditions:
setup:
  - "public port"
stimulus:
  - "POST without token"
expected_mcp_calls:
expected_events:
expected_state:
  - "401"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NGROK-006 — Distinct public vs local ports enforced

```yaml
id: E2E-NGROK-006
title: "Distinct public vs local ports enforced"
category: ngrok
priority: P2
source_references:
  - "extention-proxy/server.js:41-43"
requirements:
  - "D-038"
preconditions:
setup:
  - "same port env"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
expected_state:
  - "startup error"
assertions:
  - "throws"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NGROK-007 — ngrok exit description

```yaml
id: E2E-NGROK-007
title: "ngrok exit description"
category: ngrok
priority: P2
source_references:
  - "extention-proxy/desktop/ngrok-reuse.mjs"
requirements:
  - "D-069"
preconditions:
setup:
  - "kill ngrok"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
expected_state:
  - "exit reason"
assertions:
  - "diagnostic"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NGROK-008 — Tunnel URL persisted in settings

```yaml
id: E2E-NGROK-008
title: "Tunnel URL persisted in settings"
category: ngrok
priority: P2
source_references:
  - "extention-proxy/desktop/main.mjs"
requirements:
  - "D-069"
preconditions:
setup:
  - "tunnel started"
stimulus:
  - "read settings"
expected_mcp_calls:
expected_events:
expected_state:
  - "url saved"
assertions:
  - "resume"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-EXT-001 — Extension loads unpacked and injects content scripts

```yaml
id: E2E-EXT-001
title: "Extension loads unpacked and injects content scripts"
category: extension_init
priority: P0
source_references:
  - "extention/manifest.json"
  - "extention/content.js"
requirements:
  - "D-004"
preconditions:
setup:
  - "extension installed"
stimulus:
  - "open ChatGPT"
expected_mcp_calls:
expected_events:
  - "content_injected"
expected_state:
  - "managed tab detection"
assertions:
  - "indicator appears"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXT-002 — Supported site detection chatgpt/claude/gemini

```yaml
id: E2E-EXT-002
title: "Supported site detection chatgpt/claude/gemini"
category: extension_init
priority: P1
source_references:
  - "extention/background.js:165"
  - "extention/content.js"
requirements:
  - "D-003"
preconditions:
setup:
  - "extension loaded"
stimulus:
  - "navigate each site"
expected_mcp_calls:
expected_events:
  - "site_detected"
expected_state:
  - "tab site"
assertions:
  - "supported sites"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXT-003 — Unsupported site ignored

```yaml
id: E2E-EXT-003
title: "Unsupported site ignored"
category: extension_init
priority: P2
source_references:
  - "extention/background.js:165"
requirements:
  - "D-003"
preconditions:
setup:
  - "extension loaded"
stimulus:
  - "navigate example.com"
expected_mcp_calls:
expected_events:
expected_state:
  - "not managed"
assertions:
  - "no injection"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXT-004 — Extension reconnects to proxy automatically

```yaml
id: E2E-EXT-004
title: "Extension reconnects to proxy automatically"
category: extension_init
priority: P1
source_references:
  - "extention/background.js:connect"
  - "docs:D-028"
requirements:
  - "D-028"
preconditions:
setup:
  - "proxy down"
stimulus:
  - "start proxy"
expected_mcp_calls:
expected_events:
  - "reconnect"
expected_state:
  - "bridge restored"
assertions:
  - "no manual"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXT-005 — Extension settings received via websocket

```yaml
id: E2E-EXT-005
title: "Extension settings received via websocket"
category: extension_init
priority: P2
source_references:
  - "extention-proxy/server.js:1664"
  - "extention-proxy/test/extension-settings-ws.test.mjs"
requirements:
  - "D-048"
preconditions:
setup:
  - "settings changed"
stimulus:
  - "push settings"
expected_mcp_calls:
expected_events:
  - "settings_push"
expected_state:
  - "extension updated"
assertions:
  - "prompt modules"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EXT-006 — Content script survives SPA navigation

```yaml
id: E2E-EXT-006
title: "Content script survives SPA navigation"
category: extension_init
priority: P1
source_references:
  - "extention/content.js"
requirements:
  - "D-006"
preconditions:
setup:
  - "ChatGPT open"
stimulus:
  - "navigate conversation"
expected_mcp_calls:
expected_events:
  - "route_changed"
expected_state:
  - "incarnation stable"
assertions:
  - "no duplicate"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXT-007 — Anti-freeze visibility emulation for unfocused tabs

```yaml
id: E2E-EXT-007
title: "Anti-freeze visibility emulation for unfocused tabs"
category: extension_init
priority: P2
source_references:
  - "extention/background.js:557-582"
  - "docs:D-052"
requirements:
  - "D-052"
preconditions:
setup:
  - "managed worker unfocused"
stimulus:
  - "spawn worker"
expected_mcp_calls:
expected_events:
  - "anti_freeze_enabled"
expected_state:
  - "tab stays generating"
assertions:
  - "no throttling"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXT-008 — Extension desktop action whitelist

```yaml
id: E2E-EXT-008
title: "Extension desktop action whitelist"
category: extension_init
priority: P1
source_references:
  - "extention-proxy/test/desktop-manual-completion-ipc.test.mjs"
requirements:
  - "D-050"
preconditions:
setup:
  - "desktop running"
stimulus:
  - "desktop action packet"
expected_mcp_calls:
expected_events:
  - "action_executed"
expected_state:
  - "result"
assertions:
  - "auth"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EXT-009 — Managed tab removal triggers closure handling

```yaml
id: E2E-EXT-009
title: "Managed tab removal triggers closure handling"
category: extension_init
priority: P0
source_references:
  - "extention/background.js:3698"
requirements:
  - "D-009"
  - "D-068"
preconditions:
setup:
  - "managed child"
stimulus:
  - "close tab"
expected_mcp_calls:
expected_events:
  - "tab_removed"
expected_state:
  - "closure prompt"
assertions:
  - "desktop notified"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-EXT-010 — Reconcile missed parent closures on startup

```yaml
id: E2E-EXT-010
title: "Reconcile missed parent closures on startup"
category: extension_init
priority: P1
source_references:
  - "extention/background.js:239-284"
requirements:
  - "D-026"
preconditions:
setup:
  - "missed closure persisted"
stimulus:
  - "start extension"
expected_mcp_calls:
expected_events:
  - "reconcile"
expected_state:
  - "pending closure"
assertions:
  - "prompt shown"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-EXT-011 — Reconcile missed child closures

```yaml
id: E2E-EXT-011
title: "Reconcile missed child closures"
category: extension_init
priority: P1
source_references:
  - "extention/background.js:285-316"
requirements:
  - "D-068"
preconditions:
setup:
  - "missed child closure"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "reconcile"
expected_state:
  - "pending"
assertions:
  - "prompt"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-EXT-012 — Extension version/installation ID verified

```yaml
id: E2E-EXT-012
title: "Extension version/installation ID verified"
category: extension_init
priority: P2
source_references:
  - "docs/E2E_TESTING_GUIDE.md:extension verified"
requirements:
  - "D-004"
preconditions:
setup:
  - "enrolled"
stimulus:
  - "open desktop connections"
expected_mcp_calls:
expected_events:
expected_state:
  - "green verified"
assertions:
  - "match"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-001 — Detected supported tab is unregistered by default

```yaml
id: E2E-PARENT-001
title: "Detected supported tab is unregistered by default"
category: parent_registration
priority: P0
source_references:
  - "docs:D-005"
  - "extention/background.js:513"
requirements:
  - "D-005"
preconditions:
setup:
  - "open ChatGPT"
stimulus:
  - "observe"
expected_mcp_calls:
expected_events:
  - "tab_unregistered"
expected_state:
  - "role none"
assertions:
  - "no auto register"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-002 — User approves parent registration

```yaml
id: E2E-PARENT-002
title: "User approves parent registration"
category: parent_registration
priority: P0
source_references:
  - "extention/background.js"
  - "docs:D-005"
  - "docs:D-036"
requirements:
  - "D-005"
  - "D-036"
preconditions:
setup:
  - "unregistered tab"
stimulus:
  - "click Make Parent"
expected_mcp_calls:
expected_events:
  - "parent_approved"
expected_state:
  - "registered"
assertions:
  - "indicator shows id"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-003 — User declines parent registration leaves normal tab

```yaml
id: E2E-PARENT-003
title: "User declines parent registration leaves normal tab"
category: parent_registration
priority: P0
source_references:
  - "docs:D-005"
requirements:
  - "D-005"
preconditions:
setup:
  - "popup"
stimulus:
  - "click No"
expected_mcp_calls:
expected_events:
  - "declined"
expected_state:
  - "unregistered"
assertions:
  - "no MCP parent"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-004 — Managed child tab cannot be promoted to parent

```yaml
id: E2E-PARENT-004
title: "Managed child tab cannot be promoted to parent"
category: parent_registration
priority: P0
source_references:
  - "docs:D-051"
  - "extention/background.js:513"
requirements:
  - "D-051"
preconditions:
setup:
  - "managed child tab"
stimulus:
  - "attempt Make Parent"
expected_mcp_calls:
expected_events:
expected_state:
  - "suppressed"
assertions:
  - "no promotion"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-005 — Parent tab keeps role until closed

```yaml
id: E2E-PARENT-005
title: "Parent tab keeps role until closed"
category: parent_registration
priority: P0
source_references:
  - "docs:D-006"
requirements:
  - "D-006"
preconditions:
setup:
  - "registered parent"
stimulus:
  - "navigate within tab"
expected_mcp_calls:
expected_events:
  - "role_stable"
expected_state:
  - "same agent id"
assertions:
  - "no reset"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-006 — Navigation does not reset hierarchy

```yaml
id: E2E-PARENT-006
title: "Navigation does not reset hierarchy"
category: parent_registration
priority: P0
source_references:
  - "docs:D-006"
  - "docs:D-053"
requirements:
  - "D-006"
  - "D-053"
preconditions:
setup:
  - "parent with children"
stimulus:
  - "navigate"
expected_mcp_calls:
expected_events:
  - "hierarchy_stable"
expected_state:
  - "children remain"
assertions:
  - "no reparent"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-007 — Parent status indicator visible

```yaml
id: E2E-PARENT-007
title: "Parent status indicator visible"
category: parent_registration
priority: P2
source_references:
  - "docs:D-007"
requirements:
  - "D-007"
preconditions:
setup:
  - "registered parent"
stimulus:
  - "inspect page"
expected_mcp_calls:
expected_events:
expected_state:
  - "indicator"
assertions:
  - "id, connection, state"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PARENT-008 — Pairing requires explicit user-approved parent

```yaml
id: E2E-PARENT-008
title: "Pairing requires explicit user-approved parent"
category: parent_registration
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
  - "docs:D-037"
requirements:
  - "D-037"
preconditions:
setup:
  - "unapproved tab"
stimulus:
  - "pair_conversation"
expected_mcp_calls:
expected_events:
expected_state:
  - "error parent not approved"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PARENT-009 — Pairing tab change before approval rejected

```yaml
id: E2E-PARENT-009
title: "Pairing tab change before approval rejected"
category: parent_registration
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-037"
preconditions:
setup:
  - "pairing offer"
stimulus:
  - "navigate before bind"
expected_mcp_calls:
expected_events:
expected_state:
  - "incarnation mismatch"
assertions:
  - "rejected"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PARENT-010 — Parent pairing creates tab registry root

```yaml
id: E2E-PARENT-010
title: "Parent pairing creates tab registry root"
category: parent_registration
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
  - "extention-proxy/tab-registry.mjs:registerRoot"
requirements:
  - "D-036"
preconditions:
setup:
  - "approved parent"
stimulus:
  - "pair_conversation"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "paired:true"
expected_state:
  - "registry root"
assertions:
  - "tab_registry has root"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PARENT-011 — Reconstruct live descendants on parent pairing

```yaml
id: E2E-PARENT-011
title: "Reconstruct live descendants on parent pairing"
category: parent_registration
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-025"
preconditions:
setup:
  - "parent with lost children"
stimulus:
  - "pair_conversation"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "recovery"
expected_state:
  - "attached/held counts"
assertions:
  - "reconciliation"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PARENT-012 — Parent unregistration not allowed live (open)

```yaml
id: E2E-PARENT-012
title: "Parent unregistration not allowed live (open)"
category: parent_registration
priority: P2
source_references:
  - "docs:D-006 boundary"
requirements:
  - "D-006"
preconditions:
setup:
  - "registered parent"
stimulus:
  - "attempt unregister"
expected_mcp_calls:
expected_events:
expected_state:
  - "not supported/forbidden"
assertions:
  - "documented"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-001 — spawn_worker creates managed child tab

```yaml
id: E2E-CHILD-001
title: "spawn_worker creates managed child tab"
category: child_creation
priority: P0
source_references:
  - "extention-proxy/server.js:spawn_worker"
  - "extention/background.js:startTask"
requirements:
  - "D-040"
preconditions:
setup:
  - "paired parent"
stimulus:
  - "spawn_worker"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "child_created"
expected_state:
  - "new tab"
assertions:
  - "task_id returned"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-002 — spawn_worker reuses idle same seat

```yaml
id: E2E-CHILD-002
title: "spawn_worker reuses idle same seat"
category: child_creation
priority: P0
source_references:
  - "extention/background.js:roleSeatKey"
  - "docs:D-045"
requirements:
  - "D-045"
preconditions:
setup:
  - "existing idle child"
stimulus:
  - "spawn same role"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "reuse"
expected_state:
  - "same tab"
assertions:
  - "no new tab"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-003 — Provider not supported returns error

```yaml
id: E2E-CHILD-003
title: "Provider not supported returns error"
category: child_creation
priority: P0
source_references:
  - "extention-proxy/server.js:spawn_worker"
requirements:
  - "D-048"
preconditions:
setup:
  - "paired parent"
stimulus:
  - "spawn claude"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "provider_not_supported"
expected_state:
  - "no tab"
assertions:
  - "error"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CHILD-004 — Global sub-agent limit enforced

```yaml
id: E2E-CHILD-004
title: "Global sub-agent limit enforced"
category: child_creation
priority: P0
source_references:
  - "docs:D-041"
  - "extention/background.js:guard"
requirements:
  - "D-041"
preconditions:
setup:
  - "limit reached"
stimulus:
  - "spawn_worker"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "limit_reached"
expected_state:
  - "actionable error"
assertions:
  - "no spawn"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-005 — Child pairing via issueManagedChildPairing

```yaml
id: E2E-CHILD-005
title: "Child pairing via issueManagedChildPairing"
category: child_creation
priority: P0
source_references:
  - "extention/background.js:issueManagedChildPairing"
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-037"
preconditions:
setup:
  - "child tab opened"
stimulus:
  - "auto pairing"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "paired"
expected_state:
  - "credential issued"
assertions:
  - "managed worker"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-006 — Child prompt submission to ChatGPT

```yaml
id: E2E-CHILD-006
title: "Child prompt submission to ChatGPT"
category: child_creation
priority: P0
source_references:
  - "extention/background.js:startTask"
  - "extention/content.js"
requirements:
  - "D-071"
preconditions:
setup:
  - "paired child"
stimulus:
  - "startTask"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "prompt_submitted"
expected_state:
  - "task running"
assertions:
  - "composer used"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-007 — Child task instructions and context included

```yaml
id: E2E-CHILD-007
title: "Child task instructions and context included"
category: child_creation
priority: P0
source_references:
  - "docs:D-071"
  - "extention/background.js:startTask"
requirements:
  - "D-071"
preconditions:
setup:
  - "parent context"
stimulus:
  - "spawn_worker with task"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "submitted"
expected_state:
  - "prompt contains task"
assertions:
  - "context"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-008 — Queued independent tasks while child busy

```yaml
id: E2E-CHILD-008
title: "Queued independent tasks while child busy"
category: child_creation
priority: P0
source_references:
  - "extention/background.js:launchOrQueueIndependent"
  - "docs:D-075"
requirements:
  - "D-075"
preconditions:
setup:
  - "busy child"
stimulus:
  - "send_to_tab"
expected_mcp_calls:
  - "send_to_tab"
expected_events:
  - "queued"
expected_state:
  - "task queued"
assertions:
  - "no interrupt"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-009 — Child can spawn descendants

```yaml
id: E2E-CHILD-009
title: "Child can spawn descendants"
category: child_creation
priority: P0
source_references:
  - "docs:D-040"
  - "extention/background.js:startTask"
requirements:
  - "D-040"
preconditions:
setup:
  - "paired child"
stimulus:
  - "spawn_worker from child"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "descendant_created"
expected_state:
  - "nested"
assertions:
  - "allowed"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-010 — Direct sibling messaging denied

```yaml
id: E2E-CHILD-010
title: "Direct sibling messaging denied"
category: child_creation
priority: P0
source_references:
  - "docs:D-073"
  - "extention-proxy/server.js:requireDirectChild"
requirements:
  - "D-073"
preconditions:
setup:
  - "two children"
stimulus:
  - "send_to_tab sibling"
expected_mcp_calls:
  - "send_to_tab"
expected_events:
  - "forbidden"
expected_state:
  - "denied"
assertions:
  - "not allowed"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CHILD-011 — Ancestor read-only access to descendant chat

```yaml
id: E2E-CHILD-011
title: "Ancestor read-only access to descendant chat"
category: child_creation
priority: P0
source_references:
  - "docs:D-074"
  - "extention-proxy/server.js:read_chat"
requirements:
  - "D-074"
preconditions:
setup:
  - "nested child"
stimulus:
  - "read_chat ancestor"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "transcript"
expected_state:
  - "authorized"
assertions:
  - "read-only"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CHILD-012 — Child close blocked if descendants remain

```yaml
id: E2E-CHILD-012
title: "Child close blocked if descendants remain"
category: child_creation
priority: P0
source_references:
  - "docs:D-047"
  - "extention-proxy/server.js:close_worker"
requirements:
  - "D-047"
preconditions:
setup:
  - "child with descendants"
stimulus:
  - "close_worker"
expected_mcp_calls:
  - "close_worker"
expected_events:
  - "blocked"
expected_state:
  - "error descendants"
assertions:
  - "not closed"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-001 — Pairing code single-use

```yaml
id: E2E-PAIR-001
title: "Pairing code single-use"
category: pairing
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
  - "extention/background.js"
requirements:
  - "D-037"
preconditions:
setup:
  - "offer generated"
stimulus:
  - "reuse code"
expected_mcp_calls:
  - "pair_conversation x2"
expected_events:
  - "second fails"
expected_state:
  - "invalid/expired"
assertions:
  - "single use"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-002 — Expired pairing offer rejected

```yaml
id: E2E-PAIR-002
title: "Expired pairing offer rejected"
category: pairing
priority: P0
source_references:
  - "extention-proxy/caller-identity.mjs:TTL_MS"
requirements:
  - "D-037"
preconditions:
setup:
  - "offer old"
stimulus:
  - "pair after 180s"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "expired"
expected_state:
  - "rejected"
assertions:
  - "TTL"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-003 — Original extension socket must be connected

```yaml
id: E2E-PAIR-003
title: "Original extension socket must be connected"
category: pairing
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-037"
preconditions:
setup:
  - "disconnect extension"
stimulus:
  - "pair"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "socket disconnected"
expected_state:
  - "error"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-004 — Live tab inspection verifies incarnation and route hash

```yaml
id: E2E-PAIR-004
title: "Live tab inspection verifies incarnation and route hash"
category: pairing
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-037"
preconditions:
setup:
  - "pairing"
stimulus:
  - "pair"
expected_mcp_calls:
  - "inspect_tab"
expected_events:
  - "verification"
expected_state:
  - "match"
assertions:
  - "no mismatch"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-005 — Managed child pairing reconciles submission proof

```yaml
id: E2E-PAIR-005
title: "Managed child pairing reconciles submission proof"
category: pairing
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
  - "extention/background.js:issueManagedChildPairing"
requirements:
  - "D-042"
preconditions:
setup:
  - "child pairing"
stimulus:
  - "pair managed child"
expected_mcp_calls:
  - "confirm_child_pairing_submission"
expected_events:
  - "proof"
expected_state:
  - "verified or deferred"
assertions:
  - "no replay prompt"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PAIR-006 — Pairing credential revoked on registry failure

```yaml
id: E2E-PAIR-006
title: "Pairing credential revoked on registry failure"
category: pairing
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-037"
preconditions:
setup:
  - "force registry fail"
stimulus:
  - "pair"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "revoked"
expected_state:
  - "credential gone"
assertions:
  - "cleanup"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PAIR-007 — Agent credential immutable binding persisted

```yaml
id: E2E-PAIR-007
title: "Agent credential immutable binding persisted"
category: pairing
priority: P0
source_references:
  - "extention-proxy/agent-binding-store.mjs"
requirements:
  - "D-037"
preconditions:
setup:
  - "paired agent"
stimulus:
  - "restart proxy"
expected_mcp_calls:
  - "load bindings"
expected_events:
  - "restored"
expected_state:
  - "credential binding"
assertions:
  - "encrypted file"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-008 — Restored binding grants nothing until live verification

```yaml
id: E2E-PAIR-008
title: "Restored binding grants nothing until live verification"
category: pairing
priority: P0
source_references:
  - "extention-proxy/agent-binding-store.mjs:1-3"
requirements:
  - "D-037"
preconditions:
setup:
  - "restored binding stale"
stimulus:
  - "call tool"
expected_mcp_calls:
expected_events:
expected_state:
  - "denied until verify"
assertions:
  - "fail closed"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-009 — Revoke credential on tab close

```yaml
id: E2E-PAIR-009
title: "Revoke credential on tab close"
category: pairing
priority: P0
source_references:
  - "extention-proxy/caller-identity.mjs:revokeTab"
requirements:
  - "D-009"
preconditions:
setup:
  - "close parent"
stimulus:
  - "close tab"
expected_mcp_calls:
expected_events:
  - "revoked"
expected_state:
  - "credential gone"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PAIR-010 — MCP conversation cannot pair to another tab

```yaml
id: E2E-PAIR-010
title: "MCP conversation cannot pair to another tab"
category: pairing
priority: P0
source_references:
  - "extention-proxy/caller-identity.mjs:bind"
requirements:
  - "D-037"
preconditions:
setup:
  - "paired session"
stimulus:
  - "pair different tab"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "error"
expected_state:
  - "already paired"
assertions:
  - "scope enforced"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-011 — Caller resolution verifies live role/incarnation every call

```yaml
id: E2E-PAIR-011
title: "Caller resolution verifies live role/incarnation every call"
category: pairing
priority: P0
source_references:
  - "extention-proxy/server.js:resolveCaller"
requirements:
  - "D-008"
preconditions:
setup:
  - "paired agent"
stimulus:
  - "call after tab change"
expected_mcp_calls:
expected_events:
expected_state:
  - "verification"
assertions:
  - "not stale"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PAIR-012 — Revoked credential denied

```yaml
id: E2E-PAIR-012
title: "Revoked credential denied"
category: pairing
priority: P0
source_references:
  - "extention-proxy/caller-identity.mjs:revoke"
requirements:
  - "D-008"
preconditions:
setup:
  - "revoke"
stimulus:
  - "call tool"
expected_mcp_calls:
expected_events:
expected_state:
  - "missing credential"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-013 — Role metadata is not authorization

```yaml
id: E2E-PAIR-013
title: "Role metadata is not authorization"
category: pairing
priority: P2
source_references:
  - "extention-proxy/server.js:spawn_worker role"
requirements:
  - "D-008"
preconditions:
setup:
  - "spawn with role"
stimulus:
  - "call"
expected_mcp_calls:
expected_events:
expected_state:
  - "role metadata only"
assertions:
  - "no privilege"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PAIR-014 — Browser session id scopes multi-profile calls

```yaml
id: E2E-PAIR-014
title: "Browser session id scopes multi-profile calls"
category: pairing
priority: P0
source_references:
  - "extention-proxy/server.js:browserSessionInput"
requirements:
  - "D-002"
preconditions:
setup:
  - "two profiles"
stimulus:
  - "call with session id"
expected_mcp_calls:
expected_events:
expected_state:
  - "correct profile"
assertions:
  - "no cross profile"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROMPT-001 — Child prompt submitted and confirmation polled

```yaml
id: E2E-PROMPT-001
title: "Child prompt submitted and confirmation polled"
category: prompt_submission
priority: P0
source_references:
  - "extention/background.js:startTask"
  - "extention-proxy/test/cm06-14-confirmation-timeout.test.mjs"
requirements:
  - "D-044"
  - "D-042"
preconditions:
setup:
  - "child tab ready"
stimulus:
  - "submit prompt"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "submitted"
expected_state:
  - "task running"
assertions:
  - "confirmation"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROMPT-002 — Submission confirmation timeout handling

```yaml
id: E2E-PROMPT-002
title: "Submission confirmation timeout handling"
category: prompt_submission
priority: P0
source_references:
  - "extention-proxy/test/cm06-14-confirmation-timeout.test.mjs"
requirements:
  - "D-044"
preconditions:
setup:
  - "slow page"
stimulus:
  - "submit"
expected_mcp_calls:
expected_events:
  - "timeout"
expected_state:
  - "uncertain or retry"
assertions:
  - "no false success"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROMPT-003 — Prompt not duplicated on retry

```yaml
id: E2E-PROMPT-003
title: "Prompt not duplicated on retry"
category: prompt_submission
priority: P0
source_references:
  - "extention/background.js:startTask"
requirements:
  - "D-032"
  - "D-034"
preconditions:
setup:
  - "submit then retry same key"
stimulus:
  - "retry"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "deduped"
expected_state:
  - "one task"
assertions:
  - "idempotency"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROMPT-004 — Queued followup dispatched when child idle

```yaml
id: E2E-PROMPT-004
title: "Queued followup dispatched when child idle"
category: prompt_submission
priority: P0
source_references:
  - "extention/background.js:dispatchQueuedFollowups"
requirements:
  - "D-049"
preconditions:
setup:
  - "busy child"
stimulus:
  - "send followup"
expected_mcp_calls:
  - "send_to_tab"
expected_events:
  - "queued_followup"
expected_state:
  - "dispatched later"
assertions:
  - "order"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROMPT-005 — Followup carries operating contract

```yaml
id: E2E-PROMPT-005
title: "Followup carries operating contract"
category: prompt_submission
priority: P0
source_references:
  - "extention-proxy/test/child-followup-contract.test.mjs"
requirements:
  - "D-071"
preconditions:
setup:
  - "child followup"
stimulus:
  - "send_to_tab"
expected_mcp_calls:
  - "send_to_tab"
expected_events:
  - "contract"
expected_state:
  - "complete_task expected"
assertions:
  - "no bare message"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROMPT-006 — Page settling detection

```yaml
id: E2E-PROMPT-006
title: "Page settling detection"
category: prompt_submission
priority: P2
source_references:
  - "extention-proxy/test/browser-page-settling.test.mjs"
requirements:
  - "D-044"
preconditions:
setup:
  - "submit"
stimulus:
  - "wait settle"
expected_mcp_calls:
expected_events:
  - "settled"
expected_state:
  - "status"
assertions:
  - "not completion alone"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROMPT-007 — Composer readiness state

```yaml
id: E2E-PROMPT-007
title: "Composer readiness state"
category: prompt_submission
priority: P2
source_references:
  - "extention-proxy/test/chatgpt-composer.test.mjs"
  - "extention-proxy/test/chatgpt-readiness-state.test.mjs"
requirements:
  - "D-044"
preconditions:
setup:
  - "ChatGPT UI"
stimulus:
  - "submit"
expected_mcp_calls:
expected_events:
  - "ready"
expected_state:
  - "composer found"
assertions:
  - "robust selectors"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROMPT-008 — Submit retry on transient failure

```yaml
id: E2E-PROMPT-008
title: "Submit retry on transient failure"
category: prompt_submission
priority: P0
source_references:
  - "extention/background.js:startTask"
requirements:
  - "D-044"
preconditions:
setup:
  - "transient fail"
stimulus:
  - "submit"
expected_mcp_calls:
expected_events:
  - "retry"
expected_state:
  - "submitted"
assertions:
  - "bounded retries"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROMPT-009 — Origin parent URL captured for completion navigation

```yaml
id: E2E-PROMPT-009
title: "Origin parent URL captured for completion navigation"
category: prompt_submission
priority: P0
source_references:
  - "docs:D-055"
  - "extention/background.js:startTask originParentUrl"
requirements:
  - "D-055"
preconditions:
setup:
  - "delegation origin"
stimulus:
  - "spawn"
expected_mcp_calls:
expected_events:
  - "origin_saved"
expected_state:
  - "url"
assertions:
  - "return later"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROMPT-010 — Immediate navigation despite unsent draft

```yaml
id: E2E-PROMPT-010
title: "Immediate navigation despite unsent draft"
category: prompt_submission
priority: P2
source_references:
  - "docs:D-056"
requirements:
  - "D-056"
preconditions:
setup:
  - "draft in parent"
stimulus:
  - "completion notify"
expected_mcp_calls:
expected_events:
  - "navigate"
expected_state:
  - "interrupts"
assertions:
  - "documented"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PROMPT-011 — No browser prompt replay after pairing

```yaml
id: E2E-PROMPT-011
title: "No browser prompt replay after pairing"
category: prompt_submission
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation no_browser_prompt_replayed"
requirements:
  - "D-036"
preconditions:
setup:
  - "pairing"
stimulus:
  - "pair"
expected_mcp_calls:
expected_events:
  - "no_browser_prompt_replayed:true"
expected_state:
  - "response"
assertions:
  - "no duplicate"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROMPT-012 — Focus emulation for background submit

```yaml
id: E2E-PROMPT-012
title: "Focus emulation for background submit"
category: prompt_submission
priority: P2
source_references:
  - "extention/background.js:acquireForegroundSubmitLease"
requirements:
  - "D-052"
preconditions:
setup:
  - "background tab"
stimulus:
  - "submit"
expected_mcp_calls:
expected_events:
  - "focus_lease"
expected_state:
  - "submitted"
assertions:
  - "restores"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-READ-001 — read_chat returns transcript

```yaml
id: E2E-READ-001
title: "read_chat returns transcript"
category: response_reading
priority: P0
source_references:
  - "extention-proxy/server.js:read_chat"
  - "extention/content.js"
requirements:
  - "D-074"
preconditions:
setup:
  - "paired agent authorized"
stimulus:
  - "read_chat"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "transcript"
expected_state:
  - "messages"
assertions:
  - "content"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-READ-002 — Reasoning excluded by default

```yaml
id: E2E-READ-002
title: "Reasoning excluded by default"
category: response_reading
priority: P0
source_references:
  - "extention-proxy/server.js:read_chat"
requirements:
  - "D-074"
preconditions:
setup:
  - "conversation with reasoning"
stimulus:
  - "read_chat"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "transcript"
expected_state:
  - "no reasoning"
assertions:
  - "filter"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-READ-003 — Attachments included by default

```yaml
id: E2E-READ-003
title: "Attachments included by default"
category: response_reading
priority: P2
source_references:
  - "extention-proxy/server.js:read_chat"
requirements:
  - "D-074"
preconditions:
setup:
  - "attachments"
stimulus:
  - "read_chat include_attachments"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "labels"
expected_state:
  - "attachment names"
assertions:
  - "no bytes"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-READ-004 — last_n limits messages

```yaml
id: E2E-READ-004
title: "last_n limits messages"
category: response_reading
priority: P2
source_references:
  - "extention-proxy/server.js:read_chat"
requirements:
  - "D-074"
preconditions:
setup:
  - "long chat"
stimulus:
  - "read_chat last_n=5"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "transcript"
expected_state:
  - "5 messages"
assertions:
  - "limit"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-READ-005 — Unauthorized read denied

```yaml
id: E2E-READ-005
title: "Unauthorized read denied"
category: response_reading
priority: P0
source_references:
  - "extention-proxy/server.js:read_chat"
  - "requireDirectChild"
requirements:
  - "D-008"
preconditions:
setup:
  - "unauthorized caller"
stimulus:
  - "read_chat"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "forbidden"
expected_state:
  - "denied"
assertions:
  - "scope"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-READ-006 — Ancestor reads descendant chat

```yaml
id: E2E-READ-006
title: "Ancestor reads descendant chat"
category: response_reading
priority: P0
source_references:
  - "docs:D-074"
  - "extention-proxy/server.js:read_chat"
requirements:
  - "D-074"
preconditions:
setup:
  - "nested descendant"
stimulus:
  - "read_chat ancestor"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "transcript"
expected_state:
  - "authorized"
assertions:
  - "read-only"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-READ-007 — Site conversation API with DOM fallback

```yaml
id: E2E-READ-007
title: "Site conversation API with DOM fallback"
category: response_reading
priority: P2
source_references:
  - "extention-proxy/test/read-chat-extraction.test.mjs"
requirements:
  - "D-074"
preconditions:
setup:
  - "ChatGPT"
stimulus:
  - "read_chat"
expected_mcp_calls:
expected_events:
  - "extraction"
expected_state:
  - "transcript"
assertions:
  - "fallback"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-READ-008 — Structured read_chat output

```yaml
id: E2E-READ-008
title: "Structured read_chat output"
category: response_reading
priority: P2
source_references:
  - "extention-proxy/test/read-chat-structured.test.mjs"
requirements:
  - "D-074"
preconditions:
setup:
  - "chat"
stimulus:
  - "read_chat"
expected_mcp_calls:
expected_events:
  - "structured"
expected_state:
  - "schema"
assertions:
  - "validated"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-READ-009 — MCP e2e read_chat transport

```yaml
id: E2E-READ-009
title: "MCP e2e read_chat transport"
category: response_reading
priority: P0
source_references:
  - "extention-proxy/test/read-chat-mcp-e2e.test.mjs"
requirements:
  - "D-074"
preconditions:
setup:
  - "synthetic conversation"
stimulus:
  - "read_chat"
expected_mcp_calls:
expected_events:
  - "transport"
expected_state:
  - "result"
assertions:
  - "end-to-end"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-READ-010 — No transcript archive persisted

```yaml
id: E2E-READ-010
title: "No transcript archive persisted"
category: response_reading
priority: P2
source_references:
  - "extention-proxy/server.js:buildServer comment"
requirements:
  - "D-067"
preconditions:
setup:
  - "read chats"
stimulus:
  - "inspect storage"
expected_mcp_calls:
expected_events:
expected_state:
  - "no archive"
assertions:
  - "privacy"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-001 — Child calls complete_task after work ready

```yaml
id: E2E-COMP-001
title: "Child calls complete_task after work ready"
category: completion
priority: P0
source_references:
  - "extention-proxy/server.js:complete_task"
  - "docs:D-042"
requirements:
  - "D-042"
preconditions:
setup:
  - "child finished"
stimulus:
  - "complete_task"
expected_mcp_calls:
  - "complete_task"
expected_events:
  - "completion_event"
expected_state:
  - "task terminal"
assertions:
  - "no tab close"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-002 — Completion held until descendants finish

```yaml
id: E2E-COMP-002
title: "Completion held until descendants finish"
category: completion
priority: P0
source_references:
  - "docs:D-046"
  - "extention-proxy/server.js:complete_task"
requirements:
  - "D-046"
preconditions:
setup:
  - "parent with unfinished child"
stimulus:
  - "complete_task"
expected_mcp_calls:
  - "complete_task"
expected_events:
  - "held"
expected_state:
  - "not terminal"
assertions:
  - "gate"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-003 — Hybrid completion monitor detects final answer

```yaml
id: E2E-COMP-003
title: "Hybrid completion monitor detects final answer"
category: completion
priority: P0
source_references:
  - "extention/background.js:inspectDueCompletion"
  - "docs:D-042"
requirements:
  - "D-042"
preconditions:
setup:
  - "child final answer"
stimulus:
  - "monitor"
expected_mcp_calls:
expected_events:
  - "completion_detected"
expected_state:
  - "task complete"
assertions:
  - "not page settle alone"
failure_injection:
timeout: "90s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-004 — Completion monitor must not treat page settle as answer

```yaml
id: E2E-COMP-004
title: "Completion monitor must not treat page settle as answer"
category: completion
priority: P0
source_references:
  - "extention-proxy/test/da-completion-boundary.test.mjs"
requirements:
  - "D-042"
preconditions:
setup:
  - "settled but no final"
stimulus:
  - "monitor"
expected_mcp_calls:
expected_events:
  - "not complete"
expected_state:
  - "still running"
assertions:
  - "boundary"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-COMP-005 — Parent receives completion notification

```yaml
id: E2E-COMP-005
title: "Parent receives completion notification"
category: completion
priority: P0
source_references:
  - "docs:D-039"
  - "extention/background.js"
requirements:
  - "D-039"
preconditions:
setup:
  - "child complete"
stimulus:
  - "child complete_task"
expected_mcp_calls:
expected_events:
  - "notification"
expected_state:
  - "parent notified"
assertions:
  - "automatic"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-006 — Parent pulls full chat via read_chat

```yaml
id: E2E-COMP-006
title: "Parent pulls full chat via read_chat"
category: completion
priority: P0
source_references:
  - "docs:D-039"
requirements:
  - "D-039"
preconditions:
setup:
  - "notification"
stimulus:
  - "read_chat"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "transcript"
expected_state:
  - "full content"
assertions:
  - "not in notification"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-007 — Parent reviews and closes child

```yaml
id: E2E-COMP-007
title: "Parent reviews and closes child"
category: completion
priority: P0
source_references:
  - "docs:D-045"
  - "extention-proxy/server.js:close_worker"
requirements:
  - "D-045"
preconditions:
setup:
  - "child terminal"
stimulus:
  - "close_worker"
expected_mcp_calls:
  - "review_task"
  - "close_worker"
expected_events:
  - "reviewed"
  - "closed"
expected_state:
  - "tab closed"
assertions:
  - "explicit"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-008 — Review task gate releases next independent task

```yaml
id: E2E-COMP-008
title: "Review task gate releases next independent task"
category: completion
priority: P1
source_references:
  - "extention-proxy/test/lc16-review-task-gate.test.mjs"
requirements:
  - "D-075"
preconditions:
setup:
  - "queued task"
stimulus:
  - "review_task"
expected_mcp_calls:
  - "review_task"
expected_events:
  - "released"
expected_state:
  - "next task starts"
assertions:
  - "gate"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-COMP-009 — Parent reassigns instead of closing

```yaml
id: E2E-COMP-009
title: "Parent reassigns instead of closing"
category: completion
priority: P1
source_references:
  - "docs:D-045"
requirements:
  - "D-045"
preconditions:
setup:
  - "child complete"
stimulus:
  - "send_to_tab followup"
expected_mcp_calls:
  - "send_to_tab"
expected_events:
  - "reassigned"
expected_state:
  - "not closed"
assertions:
  - "reuse"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-010 — Completion status monitoring reload retry

```yaml
id: E2E-COMP-010
title: "Completion status monitoring reload retry"
category: completion
priority: P2
source_references:
  - "docs:D-044"
  - "extention/background.js:completionMonitorSettings"
requirements:
  - "D-044"
preconditions:
setup:
  - "stuck page"
stimulus:
  - "manual reload"
expected_mcp_calls:
expected_events:
  - "recheck"
expected_state:
  - "status"
assertions:
  - "user intervention"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-COMP-011 — Manual status fallback

```yaml
id: E2E-COMP-011
title: "Manual status fallback"
category: completion
priority: P2
source_references:
  - "docs:D-044"
requirements:
  - "D-044"
preconditions:
setup:
  - "monitor uncertain"
stimulus:
  - "get_result"
expected_mcp_calls:
  - "get_result"
expected_events:
  - "status"
expected_state:
  - "result or running"
assertions:
  - "no false terminal"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-COMP-012 — get_result wait_seconds max 50

```yaml
id: E2E-COMP-012
title: "get_result wait_seconds max 50"
category: completion
priority: P2
source_references:
  - "extention-proxy/server.js:get_result"
requirements:
  - "D-044"
preconditions:
setup:
  - "running task"
stimulus:
  - "get_result wait_seconds=50"
expected_mcp_calls:
  - "get_result"
expected_events:
  - "wait"
expected_state:
  - "response within 55s"
assertions:
  - "bounded"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-001 — Child-to-parent message enters FIFO queue

```yaml
id: E2E-EVT-001
title: "Child-to-parent message enters FIFO queue"
category: event_queues
priority: P0
source_references:
  - "extention-proxy/server.js:send_to_tab"
  - "direct-parent-queue.test.mjs"
requirements:
  - "D-049"
  - "D-073"
preconditions:
setup:
  - "child paired"
stimulus:
  - "send_to_tab to parent"
expected_mcp_calls:
  - "send_to_tab"
expected_events:
  - "queued event_id"
expected_state:
  - "QUEUED"
assertions:
  - "ordered"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-002 — FIFO delivery preserves order

```yaml
id: E2E-EVT-002
title: "FIFO delivery preserves order"
category: event_queues
priority: P0
source_references:
  - "extention-proxy/private-coordination-mcp.test.mjs"
requirements:
  - "D-049"
preconditions:
setup:
  - "multiple events"
stimulus:
  - "enqueue 3"
expected_mcp_calls:
  - "coordination_status_request x3"
expected_events:
  - "ordered"
expected_state:
  - "seq order"
assertions:
  - "no reorder"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-003 — Manager registration per credential

```yaml
id: E2E-EVT-003
title: "Manager registration per credential"
category: event_queues
priority: P0
source_references:
  - "extention-proxy/server.js:coordination_register_manager"
requirements:
  - "D-049"
preconditions:
setup:
  - "parent paired"
stimulus:
  - "register manager"
expected_mcp_calls:
  - "coordination_register_manager"
expected_events:
  - "registered"
expected_state:
  - "scope"
assertions:
  - "no global manager"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-004 — Status request queued without chat prompt

```yaml
id: E2E-EVT-004
title: "Status request queued without chat prompt"
category: event_queues
priority: P1
source_references:
  - "extention-proxy/server.js:coordination_status_request"
requirements:
  - "D-049"
preconditions:
setup:
  - "manager registered"
stimulus:
  - "status request"
expected_mcp_calls:
  - "coordination_status_request"
expected_events:
  - "queued"
expected_state:
  - "barrier"
assertions:
  - "no prompt"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-005 — Delivery arms and dispatches batch

```yaml
id: E2E-EVT-005
title: "Delivery arms and dispatches batch"
category: event_queues
priority: P0
source_references:
  - "extention-proxy/server.js:coordination_start_delivery"
  - "pumpPrivateQueue"
requirements:
  - "D-049"
preconditions:
setup:
  - "armed manager"
stimulus:
  - "start delivery"
expected_mcp_calls:
  - "coordination_start_delivery"
expected_events:
  - "batch dispatched"
expected_state:
  - "DELIVERED"
assertions:
  - "once"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-006 — Pause delivery stops new batches

```yaml
id: E2E-EVT-006
title: "Pause delivery stops new batches"
category: event_queues
priority: P1
source_references:
  - "extention-proxy/server.js:coordination_pause_delivery"
requirements:
  - "D-049"
preconditions:
setup:
  - "armed"
stimulus:
  - "pause"
expected_mcp_calls:
  - "coordination_pause_delivery"
expected_events:
  - "paused"
expected_state:
  - "armed false"
assertions:
  - "existing remains"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-007 — Explicit ACK records processed

```yaml
id: E2E-EVT-007
title: "Explicit ACK records processed"
category: event_queues
priority: P0
source_references:
  - "extention-proxy/server.js:coordination_ack_batch"
requirements:
  - "D-049"
preconditions:
setup:
  - "delivered batch"
stimulus:
  - "ack batch"
expected_mcp_calls:
  - "coordination_ack_batch"
expected_events:
  - "PROCESSED"
expected_state:
  - "queue advances"
assertions:
  - "explicit"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-008 — Unacked delivered head blocks queue

```yaml
id: E2E-EVT-008
title: "Unacked delivered head blocks queue"
category: event_queues
priority: P0
source_references:
  - "extention-proxy/server.js:coordination_pending"
requirements:
  - "D-049"
preconditions:
setup:
  - "delivered head"
stimulus:
  - "read pending"
expected_mcp_calls:
  - "coordination_pending"
expected_events:
  - "queue_blocked"
expected_state:
  - "age"
assertions:
  - "no auto skip"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-009 — Auto reconcile delivered after min age

```yaml
id: E2E-EVT-009
title: "Auto reconcile delivered after min age"
category: event_queues
priority: P1
source_references:
  - "extention-proxy/test/auto-reconcile-delivered.test.mjs"
requirements:
  - "D-049"
preconditions:
setup:
  - "stuck delivered"
stimulus:
  - "wait"
expected_mcp_calls:
expected_events:
  - "auto_reconcile"
expected_state:
  - "unblocked"
assertions:
  - "cooldown"
failure_injection:
timeout: "90s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-010 — Oversized event stored intact

```yaml
id: E2E-EVT-010
title: "Oversized event stored intact"
category: event_queues
priority: P1
source_references:
  - "extention-proxy/test/fifo-oversized-event.test.mjs"
requirements:
  - "D-049"
preconditions:
setup:
  - "large summary"
stimulus:
  - "enqueue"
expected_mcp_calls:
expected_events:
  - "stored"
expected_state:
  - "no truncation"
assertions:
  - "budget"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-011 — Private report read immutable

```yaml
id: E2E-EVT-011
title: "Private report read immutable"
category: event_queues
priority: P2
source_references:
  - "extention-proxy/server.js:coordination_get_report"
requirements:
  - "D-074"
preconditions:
setup:
  - "event delivered"
stimulus:
  - "get report"
expected_mcp_calls:
  - "coordination_get_report"
expected_events:
  - "report"
expected_state:
  - "bytes"
assertions:
  - "no mutation"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EVT-012 — Child tab lost event

```yaml
id: E2E-EVT-012
title: "Child tab lost event"
category: event_queues
priority: P1
source_references:
  - "extention-proxy/server.js"
  - "extention/background.js:reportLostWorker"
requirements:
  - "D-049"
preconditions:
setup:
  - "child tab closes"
stimulus:
  - "close child"
expected_mcp_calls:
expected_events:
  - "CHILD_TAB_LOST"
expected_state:
  - "reopen_child available"
assertions:
  - "task id"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-EVT-013 — Reopen lost child conversation

```yaml
id: E2E-EVT-013
title: "Reopen lost child conversation"
category: event_queues
priority: P1
source_references:
  - "extention-proxy/server.js:reopen_child"
requirements:
  - "D-049"
preconditions:
setup:
  - "lost child"
stimulus:
  - "reopen_child"
expected_mcp_calls:
  - "reopen_child"
expected_events:
  - "reattached"
expected_state:
  - "new tab"
assertions:
  - "execution not resumed"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-EVT-014 — Request parent context queues to parent

```yaml
id: E2E-EVT-014
title: "Request parent context queues to parent"
category: event_queues
priority: P1
source_references:
  - "extention-proxy/server.js:request_parent_context"
requirements:
  - "D-072"
preconditions:
setup:
  - "child needs context"
stimulus:
  - "request_parent_context"
expected_mcp_calls:
  - "request_parent_context"
expected_events:
  - "queued"
expected_state:
  - "parent notified"
assertions:
  - "child retains task"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-001 — Interrupted ACK leaves batch deliverable

```yaml
id: E2E-FIFO-001
title: "Interrupted ACK leaves batch deliverable"
category: fifo_acks
priority: P0
source_references:
  - "extention-proxy/test/recovery-rc13-interrupted-ack.test.mjs"
requirements:
  - "D-049"
preconditions:
setup:
  - "batch delivered"
stimulus:
  - "interrupt ack"
expected_mcp_calls:
expected_events:
  - "not partial"
expected_state:
  - "batch redeliverable"
assertions:
  - "atomic"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-002 — ACK idempotency

```yaml
id: E2E-FIFO-002
title: "ACK idempotency"
category: fifo_acks
priority: P1
source_references:
  - "extention-proxy/server.js:coordination_ack_batch"
requirements:
  - "D-034"
preconditions:
setup:
  - "ack sent"
stimulus:
  - "retry ack"
expected_mcp_calls:
  - "coordination_ack_batch"
expected_events:
  - "replay"
expected_state:
  - "same result"
assertions:
  - "no duplicate"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-003 — ACK wrong event ids rejected

```yaml
id: E2E-FIFO-003
title: "ACK wrong event ids rejected"
category: fifo_acks
priority: P1
source_references:
  - "extention-proxy/server.js:coordination_ack_batch"
requirements:
  - "D-049"
preconditions:
setup:
  - "delivered batch"
stimulus:
  - "ack wrong ids"
expected_mcp_calls:
  - "coordination_ack_batch"
expected_events:
  - "error"
expected_state:
  - "rejected"
assertions:
  - "validation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-004 — ACK without manager registration denied

```yaml
id: E2E-FIFO-004
title: "ACK without manager registration denied"
category: fifo_acks
priority: P0
source_references:
  - "extention-proxy/server.js:coordination_ack_batch"
requirements:
  - "D-049"
preconditions:
setup:
  - "unregistered"
stimulus:
  - "ack"
expected_mcp_calls:
  - "coordination_ack_batch"
expected_events:
  - "forbidden"
expected_state:
  - "denied"
assertions:
  - "scope"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-005 — Cross-principal ACK denied

```yaml
id: E2E-FIFO-005
title: "Cross-principal ACK denied"
category: fifo_acks
priority: P0
source_references:
  - "extention-proxy/server.js:privateManagerScope"
requirements:
  - "D-038"
preconditions:
setup:
  - "two managers"
stimulus:
  - "cross ack"
expected_mcp_calls:
  - "coordination_ack_batch"
expected_events:
  - "forbidden"
expected_state:
  - "denied"
assertions:
  - "isolation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-006 — Batch size max 16 events

```yaml
id: E2E-FIFO-006
title: "Batch size max 16 events"
category: fifo_acks
priority: P2
source_references:
  - "extention-proxy/server.js:coordination_ack_batch"
requirements:
  - "D-049"
preconditions:
setup:
  - "17 events"
stimulus:
  - "ack 17"
expected_mcp_calls:
  - "coordination_ack_batch"
expected_events:
  - "validation"
expected_state:
  - "rejected"
assertions:
  - "limit"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-007 — Processed event not redelivered

```yaml
id: E2E-FIFO-007
title: "Processed event not redelivered"
category: fifo_acks
priority: P0
source_references:
  - "extention-proxy/private-coordination-mcp.test.mjs"
requirements:
  - "D-049"
preconditions:
setup:
  - "acked event"
stimulus:
  - "pump"
expected_mcp_calls:
expected_events:
  - "no redelivery"
expected_state:
  - "PROCESSED stays"
assertions:
  - "terminal"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-008 — UNCERTAIN items not auto-replayed

```yaml
id: E2E-FIFO-008
title: "UNCERTAIN items not auto-replayed"
category: fifo_acks
priority: P0
source_references:
  - "docs:D-031"
  - "extention-proxy/server.js"
requirements:
  - "D-031"
preconditions:
setup:
  - "uncertain item"
stimulus:
  - "pump"
expected_mcp_calls:
expected_events:
  - "held"
expected_state:
  - "no replay"
assertions:
  - "fail closed"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-009 — Reconcile predecessors quarantines history

```yaml
id: E2E-FIFO-009
title: "Reconcile predecessors quarantines history"
category: fifo_acks
priority: P1
source_references:
  - "extention-proxy/test/reconcile-predecessors-lce7.test.mjs"
requirements:
  - "D-026"
preconditions:
setup:
  - "historical recipients"
stimulus:
  - "reconcile"
expected_mcp_calls:
  - "coordination_reconcile_predecessors"
expected_events:
  - "quarantined"
expected_state:
  - "snapshot digest required"
assertions:
  - "auditable"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-010 — Reconcile requires confirmation literal

```yaml
id: E2E-FIFO-010
title: "Reconcile requires confirmation literal"
category: fifo_acks
priority: P1
source_references:
  - "extention-proxy/server.js:coordination_reconcile_predecessors"
requirements:
  - "D-026"
preconditions:
setup:
  - "reconcile"
stimulus:
  - "wrong confirmation"
expected_mcp_calls:
  - "coordination_reconcile_predecessors"
expected_events:
  - "error"
expected_state:
  - "rejected"
assertions:
  - "validation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-011 — Incarnation conflicts inspection

```yaml
id: E2E-FIFO-011
title: "Incarnation conflicts inspection"
category: fifo_acks
priority: P2
source_references:
  - "extention-proxy/server.js:coordination_incarnation_conflicts"
requirements:
  - "D-026"
preconditions:
setup:
  - "historical recipients"
stimulus:
  - "inspect"
expected_mcp_calls:
  - "coordination_incarnation_conflicts"
expected_events:
  - "conflicts"
expected_state:
  - "read-only"
assertions:
  - "no replay"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-FIFO-012 — Predecessor event read-only

```yaml
id: E2E-FIFO-012
title: "Predecessor event read-only"
category: fifo_acks
priority: P2
source_references:
  - "extention-proxy/server.js:coordination_get_predecessor_event"
requirements:
  - "D-026"
preconditions:
setup:
  - "historical event"
stimulus:
  - "get predecessor"
expected_mcp_calls:
  - "coordination_get_predecessor_event"
expected_events:
  - "event"
expected_state:
  - "no mutation"
assertions:
  - "read-only"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-001 — Browser session id generated and persisted

```yaml
id: E2E-SESS-001
title: "Browser session id generated and persisted"
category: session_incarnation
priority: P1
source_references:
  - "extention/background.js:browserSessionId"
requirements:
  - "D-006"
preconditions:
setup:
  - "extension start"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "session_id"
expected_state:
  - "uuid"
assertions:
  - "stable"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-SESS-002 — Incarnation id unique per tab

```yaml
id: E2E-SESS-002
title: "Incarnation id unique per tab"
category: session_incarnation
priority: P1
source_references:
  - "extention/background.js"
  - "extention-proxy/tab-registry.mjs"
requirements:
  - "D-006"
preconditions:
setup:
  - "tab open"
stimulus:
  - "open tab"
expected_mcp_calls:
expected_events:
  - "incarnation"
expected_state:
  - "uuid"
assertions:
  - "unique"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-SESS-003 — Same tab id not reused after close

```yaml
id: E2E-SESS-003
title: "Same tab id not reused after close"
category: session_incarnation
priority: P1
source_references:
  - "extention-proxy/test/task-lifecycle-regression.test.mjs"
requirements:
  - "D-009"
preconditions:
setup:
  - "close tab"
stimulus:
  - "reopen"
expected_mcp_calls:
expected_events:
  - "new tab id"
expected_state:
  - "monotonic"
assertions:
  - "no reuse"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-004 — Incarnation mismatch rejects pairing

```yaml
id: E2E-SESS-004
title: "Incarnation mismatch rejects pairing"
category: session_incarnation
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-037"
preconditions:
setup:
  - "pairing"
stimulus:
  - "mutate incarnation"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "error"
expected_state:
  - "mismatch"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-005 — Route hash mismatch rejects pairing

```yaml
id: E2E-SESS-005
title: "Route hash mismatch rejects pairing"
category: session_incarnation
priority: P0
source_references:
  - "extention-proxy/server.js:pair_conversation"
requirements:
  - "D-037"
preconditions:
setup:
  - "pairing"
stimulus:
  - "mutate route"
expected_mcp_calls:
  - "pair_conversation"
expected_events:
  - "error"
expected_state:
  - "route mismatch"
assertions:
  - "denied"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-006 — Tab registry validates schema on load

```yaml
id: E2E-SESS-006
title: "Tab registry validates schema on load"
category: session_incarnation
priority: P2
source_references:
  - "extention-proxy/tab-registry.mjs:load"
requirements:
  - "D-025"
preconditions:
setup:
  - "corrupt registry"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "error"
expected_state:
  - "manual recovery"
assertions:
  - "fail closed"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-007 — Tab registry max 200 entries

```yaml
id: E2E-SESS-007
title: "Tab registry max 200 entries"
category: session_incarnation
priority: P2
source_references:
  - "extention-proxy/tab-registry.mjs"
requirements:
  - "D-041"
preconditions:
setup:
  - "200 tabs"
stimulus:
  - "register 201"
expected_mcp_calls:
expected_events:
  - "rejected"
expected_state:
  - "limit"
assertions:
  - "bounded"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-008 — Reconcile root after refresh

```yaml
id: E2E-SESS-008
title: "Reconcile root after refresh"
category: session_incarnation
priority: P1
source_references:
  - "extention-proxy/tab-registry.mjs:reconcileRoot"
requirements:
  - "D-006"
preconditions:
setup:
  - "refreshed tab"
stimulus:
  - "reconcileRoot"
expected_mcp_calls:
expected_events:
  - "reconciled"
expected_state:
  - "same root"
assertions:
  - "continuity"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-009 — Replace closed agent preserves subtree

```yaml
id: E2E-SESS-009
title: "Replace closed agent preserves subtree"
category: session_incarnation
priority: P1
source_references:
  - "extention-proxy/tab-registry.mjs:replaceClosedAgent"
requirements:
  - "D-009"
preconditions:
setup:
  - "accident restore"
stimulus:
  - "replaceClosedAgent"
expected_mcp_calls:
expected_events:
  - "replaced"
expected_state:
  - "descendants depth"
assertions:
  - "rewire"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-010 — Detach subtree removes all descendants

```yaml
id: E2E-SESS-010
title: "Detach subtree removes all descendants"
category: session_incarnation
priority: P1
source_references:
  - "extention-proxy/tab-registry.mjs:detachSubtree"
requirements:
  - "D-011"
preconditions:
setup:
  - "cancel closure"
stimulus:
  - "detachSubtree"
expected_mcp_calls:
expected_events:
  - "detached"
expected_state:
  - "removed list"
assertions:
  - "cleanup"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-011 — Phase transitions validated

```yaml
id: E2E-SESS-011
title: "Phase transitions validated"
category: session_incarnation
priority: P2
source_references:
  - "extention-proxy/tab-registry.mjs:setPhase"
requirements:
  - "D-042"
preconditions:
setup:
  - "worker"
stimulus:
  - "setPhase"
expected_mcp_calls:
expected_events:
  - "phase"
expected_state:
  - "allowed transitions"
assertions:
  - "validation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SESS-012 — within ancestry check

```yaml
id: E2E-SESS-012
title: "within ancestry check"
category: session_incarnation
priority: P1
source_references:
  - "extention-proxy/tab-registry.mjs:within"
requirements:
  - "D-073"
preconditions:
setup:
  - "nested tree"
stimulus:
  - "within"
expected_mcp_calls:
expected_events:
  - "boolean"
expected_state:
  - "ancestry"
assertions:
  - "authorization"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NEST-001 — Child spawns grandchild

```yaml
id: E2E-NEST-001
title: "Child spawns grandchild"
category: nested_delegation
priority: P0
source_references:
  - "docs:D-040"
  - "extention/background.js:startTask"
requirements:
  - "D-040"
preconditions:
setup:
  - "paired child"
stimulus:
  - "spawn_worker"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "grandchild"
expected_state:
  - "nested"
assertions:
  - "allowed"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-NEST-002 — Grandchild completion propagates to child

```yaml
id: E2E-NEST-002
title: "Grandchild completion propagates to child"
category: nested_delegation
priority: P0
source_references:
  - "docs:D-046"
  - "extention/background.js"
requirements:
  - "D-046"
preconditions:
setup:
  - "grandchild complete"
stimulus:
  - "complete_task"
expected_mcp_calls:
expected_events:
  - "propagation"
expected_state:
  - "child held until grandchild"
assertions:
  - "hierarchical"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-NEST-003 — Parent completion waits for all descendants

```yaml
id: E2E-NEST-003
title: "Parent completion waits for all descendants"
category: nested_delegation
priority: P0
source_references:
  - "docs:D-046"
requirements:
  - "D-046"
preconditions:
setup:
  - "nested tree"
stimulus:
  - "complete_task parent"
expected_mcp_calls:
  - "complete_task"
expected_events:
  - "held"
expected_state:
  - "not terminal"
assertions:
  - "gate"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-NEST-004 — Close child blocked with descendants

```yaml
id: E2E-NEST-004
title: "Close child blocked with descendants"
category: nested_delegation
priority: P0
source_references:
  - "docs:D-047"
  - "extention-proxy/server.js:close_worker"
requirements:
  - "D-047"
preconditions:
setup:
  - "child with grandchild"
stimulus:
  - "close_worker"
expected_mcp_calls:
  - "close_worker"
expected_events:
  - "blocked"
expected_state:
  - "error"
assertions:
  - "not closed"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NEST-005 — Close grandchild then child succeeds

```yaml
id: E2E-NEST-005
title: "Close grandchild then child succeeds"
category: nested_delegation
priority: P1
source_references:
  - "docs:D-047"
requirements:
  - "D-047"
preconditions:
setup:
  - "grandchild terminal"
stimulus:
  - "close grandchild then child"
expected_mcp_calls:
  - "close_worker x2"
expected_events:
  - "closed"
expected_state:
  - "both closed"
assertions:
  - "order"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-NEST-006 — Ancestor read-only access depth

```yaml
id: E2E-NEST-006
title: "Ancestor read-only access depth"
category: nested_delegation
priority: P1
source_references:
  - "docs:D-074"
requirements:
  - "D-074"
preconditions:
setup:
  - "3 levels"
stimulus:
  - "read_chat root"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "transcript"
expected_state:
  - "authorized"
assertions:
  - "read-only"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-NEST-007 — Direct owner result delivery

```yaml
id: E2E-NEST-007
title: "Direct owner result delivery"
category: nested_delegation
priority: P1
source_references:
  - "docs:D-040"
requirements:
  - "D-040"
preconditions:
setup:
  - "nested"
stimulus:
  - "completion"
expected_mcp_calls:
expected_events:
  - "notification to direct parent"
expected_state:
  - "not sibling"
assertions:
  - "ownership"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-NEST-008 — Request parent context from grandchild to child

```yaml
id: E2E-NEST-008
title: "Request parent context from grandchild to child"
category: nested_delegation
priority: P2
source_references:
  - "docs:D-072"
requirements:
  - "D-072"
preconditions:
setup:
  - "grandchild"
stimulus:
  - "request_parent_context"
expected_mcp_calls:
  - "request_parent_context"
expected_events:
  - "queued to direct parent"
expected_state:
  - "child notified"
assertions:
  - "not root"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NEST-009 — Task idempotency across nested spawn

```yaml
id: E2E-NEST-009
title: "Task idempotency across nested spawn"
category: nested_delegation
priority: P2
source_references:
  - "docs:D-032"
requirements:
  - "D-032"
preconditions:
setup:
  - "retry spawn"
stimulus:
  - "retry"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "deduped"
expected_state:
  - "one task"
assertions:
  - "idempotency"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-NEST-010 — Nested descendant count in status

```yaml
id: E2E-NEST-010
title: "Nested descendant count in status"
category: nested_delegation
priority: P2
source_references:
  - "docs:D-041"
requirements:
  - "D-041"
preconditions:
setup:
  - "nested"
stimulus:
  - "list"
expected_mcp_calls:
expected_events:
  - "counts"
expected_state:
  - "status"
assertions:
  - "visibility"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-MULTI-001 — Two parents in same browser profile

```yaml
id: E2E-MULTI-001
title: "Two parents in same browser profile"
category: multi_parent
priority: P1
source_references:
  - "extention/background.js"
  - "extention-proxy/tab-registry.mjs"
requirements:
  - "D-005"
preconditions:
setup:
  - "two approved tabs"
stimulus:
  - "register both"
expected_mcp_calls:
expected_events:
  - "two roots"
expected_state:
  - "separate scopes"
assertions:
  - "isolation"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-MULTI-002 — Child belongs to correct parent

```yaml
id: E2E-MULTI-002
title: "Child belongs to correct parent"
category: multi_parent
priority: P0
source_references:
  - "extention-proxy/server.js:requireDirectChild"
requirements:
  - "D-073"
preconditions:
setup:
  - "two parents"
stimulus:
  - "spawn from parent A"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "child under A"
expected_state:
  - "parent A"
assertions:
  - "no cross"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-MULTI-003 — Cross-parent read denied

```yaml
id: E2E-MULTI-003
title: "Cross-parent read denied"
category: multi_parent
priority: P0
source_references:
  - "extention-proxy/server.js:read_chat"
requirements:
  - "D-008"
preconditions:
setup:
  - "two parents"
stimulus:
  - "read child of other"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "forbidden"
expected_state:
  - "denied"
assertions:
  - "scope"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MULTI-004 — Cross-parent send denied

```yaml
id: E2E-MULTI-004
title: "Cross-parent send denied"
category: multi_parent
priority: P0
source_references:
  - "extention-proxy/server.js:send_to_tab"
requirements:
  - "D-073"
preconditions:
setup:
  - "two parents"
stimulus:
  - "send to other child"
expected_mcp_calls:
  - "send_to_tab"
expected_events:
  - "forbidden"
expected_state:
  - "denied"
assertions:
  - "scope"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MULTI-005 — Whole browser window close prompts per parent

```yaml
id: E2E-MULTI-005
title: "Whole browser window close prompts per parent"
category: multi_parent
priority: P1
source_references:
  - "docs:D-020"
  - "extention/background.js:reconcileMissedParentClosures"
requirements:
  - "D-020"
preconditions:
setup:
  - "two parents"
stimulus:
  - "close window"
expected_mcp_calls:
expected_events:
  - "per-parent prompts"
expected_state:
  - "each subtree"
assertions:
  - "separate"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-MULTI-006 — Per-parent accident restore

```yaml
id: E2E-MULTI-006
title: "Per-parent accident restore"
category: multi_parent
priority: P1
source_references:
  - "docs:D-021"
requirements:
  - "D-021"
preconditions:
setup:
  - "two parents closed"
stimulus:
  - "accident both"
expected_mcp_calls:
expected_events:
  - "restore both"
expected_state:
  - "descendants reused"
assertions:
  - "rewire"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-MULTI-007 — Manager scopes isolated per credential

```yaml
id: E2E-MULTI-007
title: "Manager scopes isolated per credential"
category: multi_parent
priority: P0
source_references:
  - "extention-proxy/server.js:privateManagerScope"
requirements:
  - "D-049"
preconditions:
setup:
  - "two managers"
stimulus:
  - "register both"
expected_mcp_calls:
  - "coordination_register_manager"
expected_events:
  - "scopes"
expected_state:
  - "isolated"
assertions:
  - "no cross"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-MULTI-008 — Multi-profile browser sessions

```yaml
id: E2E-MULTI-008
title: "Multi-profile browser sessions"
category: multi_parent
priority: P2
source_references:
  - "extention-proxy/server.js:browserSessionInput"
requirements:
  - "D-002"
preconditions:
setup:
  - "two profiles"
stimulus:
  - "list_tabs"
expected_mcp_calls:
  - "list_tabs"
expected_events:
  - "tabs grouped"
expected_state:
  - "session id"
assertions:
  - "scope"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CONC-001 — Concurrent spawn same seat serialized

```yaml
id: E2E-CONC-001
title: "Concurrent spawn same seat serialized"
category: concurrency
priority: P1
source_references:
  - "extention/background.js:roleSeatReservations"
requirements:
  - "D-045"
preconditions:
setup:
  - "same seat"
stimulus:
  - "concurrent spawn"
expected_mcp_calls:
  - "spawn_worker x2"
expected_events:
  - "serialized"
expected_state:
  - "one tab"
assertions:
  - "no duplicate"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CONC-002 — Concurrent spawn different seats

```yaml
id: E2E-CONC-002
title: "Concurrent spawn different seats"
category: concurrency
priority: P2
source_references:
  - "extention/background.js:workerSlotReservations"
requirements:
  - "D-041"
preconditions:
setup:
  - "capacity"
stimulus:
  - "concurrent spawn"
expected_mcp_calls:
  - "spawn_worker xN"
expected_events:
  - "N tabs"
expected_state:
  - "all created"
assertions:
  - "limits"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CONC-003 — Concurrent idempotency keys distinct

```yaml
id: E2E-CONC-003
title: "Concurrent idempotency keys distinct"
category: concurrency
priority: P1
source_references:
  - "extention-proxy/durable-idempotency.mjs"
requirements:
  - "D-035"
preconditions:
setup:
  - "paired"
stimulus:
  - "concurrent calls"
expected_mcp_calls:
  - "list_tabs x2"
expected_events:
  - "distinct"
expected_state:
  - "two responses"
assertions:
  - "no collision"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CONC-004 — Concurrent ACK different batches

```yaml
id: E2E-CONC-004
title: "Concurrent ACK different batches"
category: concurrency
priority: P2
source_references:
  - "extention-proxy/server.js:coordination_ack_batch"
requirements:
  - "D-049"
preconditions:
setup:
  - "two batches"
stimulus:
  - "concurrent ack"
expected_mcp_calls:
  - "coordination_ack_batch x2"
expected_events:
  - "processed"
expected_state:
  - "both"
assertions:
  - "atomic"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CONC-005 — Concurrent manager registrations

```yaml
id: E2E-CONC-005
title: "Concurrent manager registrations"
category: concurrency
priority: P2
source_references:
  - "extention-proxy/server.js:coordination_register_manager"
requirements:
  - "D-049"
preconditions:
setup:
  - "same tab"
stimulus:
  - "concurrent register"
expected_mcp_calls:
  - "coordination_register_manager x2"
expected_events:
  - "one"
expected_state:
  - "idempotent"
assertions:
  - "no duplicate scope"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CONC-006 — Queue pump single flight

```yaml
id: E2E-CONC-006
title: "Queue pump single flight"
category: concurrency
priority: P2
source_references:
  - "extention-proxy/server.js:pumpPrivateQueue"
requirements:
  - "D-049"
preconditions:
setup:
  - "events"
stimulus:
  - "trigger pump twice"
expected_mcp_calls:
expected_events:
  - "single"
expected_state:
  - "no duplicate dispatch"
assertions:
  - "lock"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CONC-007 — Dashboard refresh single flight

```yaml
id: E2E-CONC-007
title: "Dashboard refresh single flight"
category: concurrency
priority: P2
source_references:
  - "extention-proxy/server.js:dashboardRefreshInFlight"
requirements:
  - "D-050"
preconditions:
setup:
  - "dashboard"
stimulus:
  - "refresh twice"
expected_mcp_calls:
expected_events:
  - "single"
expected_state:
  - "no duplicate"
assertions:
  - "lock"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CONC-008 — Extension socket pending fail all

```yaml
id: E2E-CONC-008
title: "Extension socket pending fail all"
category: concurrency
priority: P1
source_references:
  - "extention-proxy/server.js:failAllPending"
requirements:
  - "D-029"
preconditions:
setup:
  - "pending calls"
stimulus:
  - "disconnect"
expected_mcp_calls:
expected_events:
  - "failed"
expected_state:
  - "reason"
assertions:
  - "cleanup"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CONC-009 — Worker slot reservation release on failure

```yaml
id: E2E-CONC-009
title: "Worker slot reservation release on failure"
category: concurrency
priority: P1
source_references:
  - "extention/background.js:workerSlotReservations"
requirements:
  - "D-041"
preconditions:
setup:
  - "spawn fails"
stimulus:
  - "spawn then fail"
expected_mcp_calls:
  - "spawn_worker"
expected_events:
  - "slot released"
expected_state:
  - "capacity restored"
assertions:
  - "no leak"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CONC-010 — Completion checks in flight dedup

```yaml
id: E2E-CONC-010
title: "Completion checks in flight dedup"
category: concurrency
priority: P2
source_references:
  - "extention/background.js:completionChecksInFlight"
requirements:
  - "D-042"
preconditions:
setup:
  - "monitor"
stimulus:
  - "duplicate check"
expected_mcp_calls:
expected_events:
  - "deduped"
expected_state:
  - "one check"
assertions:
  - "no duplicate"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CONC-011 — Tab mutation serialized

```yaml
id: E2E-CONC-011
title: "Tab mutation serialized"
category: concurrency
priority: P2
source_references:
  - "extention-proxy/tab-registry.mjs:mutate"
requirements:
  - "D-006"
preconditions:
setup:
  - "concurrent register"
stimulus:
  - "register same tab"
expected_mcp_calls:
expected_events:
  - "serialized"
expected_state:
  - "consistent"
assertions:
  - "no corruption"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CONC-012 — Journal write atomic rename

```yaml
id: E2E-CONC-012
title: "Journal write atomic rename"
category: concurrency
priority: P2
source_references:
  - "extention-proxy/agent-binding-store.mjs:save"
requirements:
  - "D-024"
preconditions:
setup:
  - "concurrent save"
stimulus:
  - "save twice"
expected_mcp_calls:
expected_events:
  - "atomic"
expected_state:
  - "no partial"
assertions:
  - "fsync"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REFRESH-001 — Browser refresh preserves parent role

```yaml
id: E2E-REFRESH-001
title: "Browser refresh preserves parent role"
category: browser_refresh_closure
priority: P0
source_references:
  - "docs:D-006"
  - "docs:A-002"
requirements:
  - "D-006"
preconditions:
setup:
  - "registered parent"
stimulus:
  - "refresh tab"
expected_mcp_calls:
expected_events:
  - "role_preserved"
expected_state:
  - "same agent"
assertions:
  - "continuity"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-002 — Server-side task continuation across refresh

```yaml
id: E2E-REFRESH-002
title: "Server-side task continuation across refresh"
category: browser_refresh_closure
priority: P1
source_references:
  - "docs:A-002"
requirements:
  - "A-002"
preconditions:
setup:
  - "running child"
stimulus:
  - "refresh child"
expected_mcp_calls:
expected_events:
  - "continues"
expected_state:
  - "task running"
assertions:
  - "documented assumption"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-003 — Parent closure popup accident restores new tab

```yaml
id: E2E-REFRESH-003
title: "Parent closure popup accident restores new tab"
category: browser_refresh_closure
priority: P0
source_references:
  - "docs:D-009"
  - "extention/background.js:verifiedPendingClosure"
requirements:
  - "D-009"
preconditions:
setup:
  - "close parent"
stimulus:
  - "close tab"
expected_mcp_calls:
expected_events:
  - "popup"
expected_state:
  - "Accident/Yes/Cancel"
assertions:
  - "5s disable"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-004 — Accident button restores parent and rewires children

```yaml
id: E2E-REFRESH-004
title: "Accident button restores parent and rewires children"
category: browser_refresh_closure
priority: P0
source_references:
  - "docs:D-009"
  - "extention-proxy/tab-registry.mjs:replaceClosedAgent"
requirements:
  - "D-009"
preconditions:
setup:
  - "closed parent"
stimulus:
  - "click Accident"
expected_mcp_calls:
expected_events:
  - "restored"
expected_state:
  - "new tab id, children rewired"
assertions:
  - "no replay submissions"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-005 — Yes closes all descendant tabs immediately

```yaml
id: E2E-REFRESH-005
title: "Yes closes all descendant tabs immediately"
category: browser_refresh_closure
priority: P0
source_references:
  - "docs:D-012"
requirements:
  - "D-012"
preconditions:
setup:
  - "active children"
stimulus:
  - "click Yes"
expected_mcp_calls:
expected_events:
  - "tabs_closed"
expected_state:
  - "all descendants"
assertions:
  - "interrupts"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-006 — Cancel leaves child tabs and shows orphan notice

```yaml
id: E2E-REFRESH-006
title: "Cancel leaves child tabs and shows orphan notice"
category: browser_refresh_closure
priority: P0
source_references:
  - "docs:D-010"
  - "docs:D-011"
requirements:
  - "D-010"
  - "D-011"
preconditions:
setup:
  - "active children"
stimulus:
  - "click Cancel"
expected_mcp_calls:
expected_events:
  - "notice"
expected_state:
  - "orphaned"
assertions:
  - "no interrupt"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-007 — Cancel detaches and denies future MCP calls 403

```yaml
id: E2E-REFRESH-007
title: "Cancel detaches and denies future MCP calls 403"
category: browser_refresh_closure
priority: P0
source_references:
  - "docs:D-011"
  - "docs:D-012"
requirements:
  - "D-011"
  - "D-012"
preconditions:
setup:
  - "orphaned child"
stimulus:
  - "call tool"
expected_mcp_calls:
expected_events:
  - "forbidden"
expected_state:
  - "403 or tool error"
assertions:
  - "scoped"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-REFRESH-008 — Popup countdown only enables buttons

```yaml
id: E2E-REFRESH-008
title: "Popup countdown only enables buttons"
category: browser_refresh_closure
priority: P1
source_references:
  - "docs:D-009"
requirements:
  - "D-009"
preconditions:
setup:
  - "popup"
stimulus:
  - "wait 5s"
expected_mcp_calls:
expected_events:
  - "buttons_enabled"
expected_state:
  - "no default action"
assertions:
  - "indefinite wait"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-009 — Child closure uses same recovery workflow

```yaml
id: E2E-REFRESH-009
title: "Child closure uses same recovery workflow"
category: browser_refresh_closure
priority: P1
source_references:
  - "docs:D-068"
requirements:
  - "D-068"
preconditions:
setup:
  - "managed child closes"
stimulus:
  - "close child"
expected_mcp_calls:
expected_events:
  - "popup"
expected_state:
  - "target parent notified"
assertions:
  - "subtree"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REFRESH-010 — Orphaned child new spawn unmanaged

```yaml
id: E2E-REFRESH-010
title: "Orphaned child new spawn unmanaged"
category: browser_refresh_closure
priority: P1
source_references:
  - "docs:D-017"
requirements:
  - "D-017"
preconditions:
setup:
  - "orphaned child"
stimulus:
  - "spawn after cancel"
expected_mcp_calls:
expected_events:
  - "unmanaged"
expected_state:
  - "denied or not managed"
assertions:
  - "no auto manage"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROXY-001 — Graceful proxy shutdown releases journal lock

```yaml
id: E2E-PROXY-001
title: "Graceful proxy shutdown releases journal lock"
category: proxy_restart
priority: P0
source_references:
  - "extention-proxy/test/graceful-journal-shutdown.test.mjs"
  - "desktop/main.mjs:691-712"
requirements:
  - "D-024"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "graceful quit"
expected_mcp_calls:
expected_events:
  - "stopped"
expected_state:
  - "lock released"
assertions:
  - "phase stopped"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROXY-002 — Force kill leaves lock and recovery

```yaml
id: E2E-PROXY-002
title: "Force kill leaves lock and recovery"
category: proxy_restart
priority: P0
source_references:
  - "docs:E2E guide sec5"
requirements:
  - "D-024"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "taskkill /F"
expected_mcp_calls:
expected_events:
  - "lock remains"
expected_state:
  - "recovery required"
assertions:
  - "manual reconcile"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-PROXY-003 — Proxy restart preserves unresolved parent closure

```yaml
id: E2E-PROXY-003
title: "Proxy restart preserves unresolved parent closure"
category: proxy_restart
priority: P0
source_references:
  - "docs:D-024"
  - "extention/background.js:persistedClosureDecisions"
requirements:
  - "D-024"
preconditions:
setup:
  - "pending closure"
stimulus:
  - "restart proxy"
expected_mcp_calls:
expected_events:
  - "persisted"
expected_state:
  - "popup reappears"
assertions:
  - "survives"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROXY-004 — Proxy restart restores approved parents

```yaml
id: E2E-PROXY-004
title: "Proxy restart restores approved parents"
category: proxy_restart
priority: P0
source_references:
  - "docs:D-025"
  - "extention/background.js:preserveOnProxyReconnect"
requirements:
  - "D-025"
preconditions:
setup:
  - "approved parents"
stimulus:
  - "restart proxy"
expected_mcp_calls:
expected_events:
  - "restored"
expected_state:
  - "relationships"
assertions:
  - "verify live tabs"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROXY-005 — Reconstruct missing parent closure after outage

```yaml
id: E2E-PROXY-005
title: "Reconstruct missing parent closure after outage"
category: proxy_restart
priority: P1
source_references:
  - "docs:D-026"
requirements:
  - "D-026"
preconditions:
setup:
  - "proxy offline during close"
stimulus:
  - "restart"
expected_mcp_calls:
expected_events:
  - "reconstructed"
expected_state:
  - "prompt"
assertions:
  - "verified absence"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROXY-006 — FIFO receipts survive proxy restart

```yaml
id: E2E-PROXY-006
title: "FIFO receipts survive proxy restart"
category: proxy_restart
priority: P0
source_references:
  - "docs:D-024"
  - "extention-proxy/private-journal.test.mjs"
requirements:
  - "D-024"
preconditions:
setup:
  - "events queued"
stimulus:
  - "restart proxy"
expected_mcp_calls:
expected_events:
  - "replayed"
expected_state:
  - "queue state"
assertions:
  - "durable"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROXY-007 — Idempotency durable across restart

```yaml
id: E2E-PROXY-007
title: "Idempotency durable across restart"
category: proxy_restart
priority: P1
source_references:
  - "extention-proxy/durable-idempotency.mjs"
requirements:
  - "D-034"
preconditions:
setup:
  - "call made"
stimulus:
  - "restart then retry same key"
expected_mcp_calls:
expected_events:
  - "replay"
expected_state:
  - "same response"
assertions:
  - "durable"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROXY-008 — Agent bindings restored after restart

```yaml
id: E2E-PROXY-008
title: "Agent bindings restored after restart"
category: proxy_restart
priority: P1
source_references:
  - "extention-proxy/agent-binding-store.mjs"
requirements:
  - "D-037"
preconditions:
setup:
  - "paired"
stimulus:
  - "restart"
expected_mcp_calls:
expected_events:
  - "restored"
expected_state:
  - "credential"
assertions:
  - "verify live"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROXY-009 — Manager registration not auto-replayed

```yaml
id: E2E-PROXY-009
title: "Manager registration not auto-replayed"
category: proxy_restart
priority: P1
source_references:
  - "docs:D-025"
  - "extention-proxy/server.js:coordination_register_manager"
requirements:
  - "D-025"
preconditions:
setup:
  - "manager registered"
stimulus:
  - "restart"
expected_mcp_calls:
expected_events:
  - "not auto"
expected_state:
  - "re-register required"
assertions:
  - "documented"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PROXY-010 — No recovered UNCERTAIN replay

```yaml
id: E2E-PROXY-010
title: "No recovered UNCERTAIN replay"
category: proxy_restart
priority: P0
source_references:
  - "docs:D-031"
  - "extention-proxy/server.js"
requirements:
  - "D-031"
preconditions:
setup:
  - "uncertain item"
stimulus:
  - "restart"
expected_mcp_calls:
expected_events:
  - "held"
expected_state:
  - "no replay"
assertions:
  - "fail closed"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROXY-011 — Journal replay succeeds on startup

```yaml
id: E2E-PROXY-011
title: "Journal replay succeeds on startup"
category: proxy_restart
priority: P0
source_references:
  - "extention-proxy/server.js:replayPrivateJournal"
requirements:
  - "D-024"
preconditions:
setup:
  - "journal exists"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "replayed"
expected_state:
  - "storageReady"
assertions:
  - "success"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PROXY-012 — Proxy port ephemeral in tests

```yaml
id: E2E-PROXY-012
title: "Proxy port ephemeral in tests"
category: proxy_restart
priority: P2
source_references:
  - "extention-proxy/test/recovery-rc-scenarios.test.mjs"
requirements:
  - "D-001"
preconditions:
setup:
  - "PORT=0"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "ephemeral"
expected_state:
  - "health"
assertions:
  - "isolated"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-EXTRELOAD-001 — Extension reload preserves storage session

```yaml
id: E2E-EXTRELOAD-001
title: "Extension reload preserves storage session"
category: extension_reload
priority: P2
source_references:
  - "extention/background.js:saveState"
requirements:
  - "D-006"
preconditions:
setup:
  - "managed tabs"
stimulus:
  - "reload extension"
expected_mcp_calls:
expected_events:
  - "session restored"
expected_state:
  - "tasks"
assertions:
  - "storage"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXTRELOAD-002 — Extension reload reconnects to proxy

```yaml
id: E2E-EXTRELOAD-002
title: "Extension reload reconnects to proxy"
category: extension_reload
priority: P1
source_references:
  - "extention/background.js:connect"
requirements:
  - "D-028"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "reload extension"
expected_mcp_calls:
expected_events:
  - "reconnect"
expected_state:
  - "bridge"
assertions:
  - "no duplicate"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXTRELOAD-003 — Pairing offers invalidated on reload

```yaml
id: E2E-EXTRELOAD-003
title: "Pairing offers invalidated on reload"
category: extension_reload
priority: P1
source_references:
  - "extention-proxy/caller-identity.mjs:offers"
requirements:
  - "D-037"
preconditions:
setup:
  - "offer generated"
stimulus:
  - "reload extension"
expected_mcp_calls:
expected_events:
  - "invalidated"
expected_state:
  - "pair again"
assertions:
  - "security"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-EXTRELOAD-004 — Established credentials remain after reload

```yaml
id: E2E-EXTRELOAD-004
title: "Established credentials remain after reload"
category: extension_reload
priority: P1
source_references:
  - "extention-proxy/caller-identity.mjs:tabs"
requirements:
  - "D-037"
preconditions:
setup:
  - "paired"
stimulus:
  - "reload extension"
expected_mcp_calls:
expected_events:
  - "credentials"
expected_state:
  - "still valid until verify"
assertions:
  - "live check"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXTRELOAD-005 — Content script reinjected after reload

```yaml
id: E2E-EXTRELOAD-005
title: "Content script reinjected after reload"
category: extension_reload
priority: P2
source_references:
  - "extention/content.js"
requirements:
  - "D-004"
preconditions:
setup:
  - "open tab"
stimulus:
  - "reload extension"
expected_mcp_calls:
expected_events:
  - "reinjected"
expected_state:
  - "indicator"
assertions:
  - "no duplicate"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXTRELOAD-006 — Managed tab removals during reload handled

```yaml
id: E2E-EXTRELOAD-006
title: "Managed tab removals during reload handled"
category: extension_reload
priority: P2
source_references:
  - "extention/background.js:managedTabRemovals"
requirements:
  - "D-009"
preconditions:
setup:
  - "reload"
stimulus:
  - "close tab"
expected_mcp_calls:
expected_events:
  - "handled"
expected_state:
  - "no crash"
assertions:
  - "robust"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXTRELOAD-007 — Anti-freeze restored after reload

```yaml
id: E2E-EXTRELOAD-007
title: "Anti-freeze restored after reload"
category: extension_reload
priority: P2
source_references:
  - "extention/background.js:enableManagedAntiFreeze"
requirements:
  - "D-052"
preconditions:
setup:
  - "managed unfocused"
stimulus:
  - "reload"
expected_mcp_calls:
expected_events:
  - "restored"
expected_state:
  - "anti-freeze"
assertions:
  - "continuity"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-EXTRELOAD-008 — Settings re-pushed after reconnect

```yaml
id: E2E-EXTRELOAD-008
title: "Settings re-pushed after reconnect"
category: extension_reload
priority: P2
source_references:
  - "extention-proxy/server.js:sendExtensionSettings"
requirements:
  - "D-048"
preconditions:
setup:
  - "settings"
stimulus:
  - "reload"
expected_mcp_calls:
expected_events:
  - "settings_push"
expected_state:
  - "updated"
assertions:
  - "sync"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-REC-001 — Empty journal stale lock archive flow

```yaml
id: E2E-REC-001
title: "Empty journal stale lock archive flow"
category: recovery
priority: P0
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:inspectJournalRecovery"
  - "desktop/main.mjs:917-936"
requirements:
  - "D-024"
preconditions:
setup:
  - "dead owner empty journal"
stimulus:
  - "archive"
expected_mcp_calls:
expected_events:
  - "archived"
expected_state:
  - "lock renamed"
assertions:
  - "snapshot verified"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REC-002 — Non-empty journal requires manual reconcile

```yaml
id: E2E-REC-002
title: "Non-empty journal requires manual reconcile"
category: recovery
priority: P0
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:inspectJournalRecovery"
requirements:
  - "D-024"
preconditions:
setup:
  - "dead owner non-empty"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "blocked"
expected_state:
  - "JOURNAL_NOT_EMPTY"
assertions:
  - "no auto delete"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-REC-003 — Malformed lock treated as unverified

```yaml
id: E2E-REC-003
title: "Malformed lock treated as unverified"
category: recovery
priority: P1
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:readLockOwner"
requirements:
  - "D-024"
preconditions:
setup:
  - "corrupt lock"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "ownerUnknown"
expected_state:
  - "manual"
assertions:
  - "fail closed"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REC-004 — Recovery marker detection

```yaml
id: E2E-REC-004
title: "Recovery marker detection"
category: recovery
priority: P2
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:inspectPrivateJournal"
requirements:
  - "D-024"
preconditions:
setup:
  - "marker exists"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "requiresManualOwnerCheck"
expected_state:
  - "true"
assertions:
  - "marker"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REC-005 — Snapshot mismatch blocks archive

```yaml
id: E2E-REC-005
title: "Snapshot mismatch blocks archive"
category: recovery
priority: P1
source_references:
  - "desktop/main.mjs:921-922"
requirements:
  - "D-024"
preconditions:
setup:
  - "changing lock"
stimulus:
  - "archive"
expected_mcp_calls:
expected_events:
  - "error"
expected_state:
  - "conditions changed"
assertions:
  - "snapshot"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-REC-006 — Recovery only when proxy stopped

```yaml
id: E2E-REC-006
title: "Recovery only when proxy stopped"
category: recovery
priority: P1
source_references:
  - "desktop/main.mjs:919"
requirements:
  - "D-024"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "archive"
expected_mcp_calls:
expected_events:
  - "error"
expected_state:
  - "stop first"
assertions:
  - "safety"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-REC-007 — RC scenario recovery tests

```yaml
id: E2E-REC-007
title: "RC scenario recovery tests"
category: recovery
priority: P1
source_references:
  - "extention-proxy/test/recovery-rc-scenarios.test.mjs"
requirements:
  - "D-024"
preconditions:
setup:
  - "isolated proxy"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "recovery"
assertions:
  - "isolated"
failure_injection:
timeout: "120s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REC-008 — RC13 interrupted ack recovery

```yaml
id: E2E-REC-008
title: "RC13 interrupted ack recovery"
category: recovery
priority: P1
source_references:
  - "extention-proxy/test/recovery-rc13-interrupted-ack.test.mjs"
requirements:
  - "D-049"
preconditions:
setup:
  - "interrupted"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "atomic"
assertions:
  - "recovery"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REC-009 — RC10 pairing reconciliation

```yaml
id: E2E-REC-009
title: "RC10 pairing reconciliation"
category: recovery
priority: P1
source_references:
  - "extention-proxy/test/rc10-pairing-reconciliation.test.mjs"
requirements:
  - "D-042"
preconditions:
setup:
  - "hidden user turn"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "reconciled"
assertions:
  - "proof"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REC-010 — RC02/ST03 transport outage

```yaml
id: E2E-REC-010
title: "RC02/ST03 transport outage"
category: recovery
priority: P1
source_references:
  - "extention-proxy/test/transport-rc02-st03.test.mjs"
requirements:
  - "D-029"
preconditions:
setup:
  - "outage"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "held calls"
assertions:
  - "recovery"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REC-011 — Transport outage test

```yaml
id: E2E-REC-011
title: "Transport outage test"
category: recovery
priority: P2
source_references:
  - "extention-proxy/test/transport-outage.test.mjs"
requirements:
  - "D-029"
preconditions:
setup:
  - "outage"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "recovery"
assertions:
  - "isolated"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-REC-012 — Endurance 50 cycles

```yaml
id: E2E-REC-012
title: "Endurance 50 cycles"
category: recovery
priority: P2
source_references:
  - "extention-proxy/test/endurance-st05.test.mjs"
requirements:
  - "D-046"
preconditions:
setup:
  - "isolated"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "no leak/bloat"
assertions:
  - "endurance"
failure_injection:
timeout: "300s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-LOCK-001 — Journal lock file exact schema

```yaml
id: E2E-LOCK-001
title: "Journal lock file exact schema"
category: locks
priority: P1
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:readLockOwner"
requirements:
  - "D-024"
preconditions:
setup:
  - "lock exists"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "schema"
expected_state:
  - "version pid hostname nonce"
assertions:
  - "validation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-LOCK-002 — Lock size bounds

```yaml
id: E2E-LOCK-002
title: "Lock size bounds"
category: locks
priority: P2
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:readLockOwner"
requirements:
  - "D-024"
preconditions:
setup:
  - "lock"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "size"
expected_state:
  - "1-1024"
assertions:
  - "bounds"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-LOCK-003 — Lock hostname must match

```yaml
id: E2E-LOCK-003
title: "Lock hostname must match"
category: locks
priority: P1
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:readLockOwner"
requirements:
  - "D-024"
preconditions:
setup:
  - "foreign lock"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "ownerUnknown"
expected_state:
  - "rejected"
assertions:
  - "security"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-LOCK-004 — Lock nonce UUID v4

```yaml
id: E2E-LOCK-004
title: "Lock nonce UUID v4"
category: locks
priority: P1
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:readLockOwner"
requirements:
  - "D-024"
preconditions:
setup:
  - "lock"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "nonce"
expected_state:
  - "uuid v4"
assertions:
  - "validation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-LOCK-005 — Journal max 32MB

```yaml
id: E2E-LOCK-005
title: "Journal max 32MB"
category: locks
priority: P2
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:PRIVATE_JOURNAL_MAX_BYTES"
requirements:
  - "D-024"
preconditions:
setup:
  - "large journal"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "error"
expected_state:
  - "too large"
assertions:
  - "bounds"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-LOCK-006 — Prepare journal creates if missing

```yaml
id: E2E-LOCK-006
title: "Prepare journal creates if missing"
category: locks
priority: P2
source_references:
  - "extention-proxy/desktop/coordination-storage.mjs:preparePrivateJournal"
requirements:
  - "D-024"
preconditions:
setup:
  - "no journal"
stimulus:
  - "prepare"
expected_mcp_calls:
expected_events:
  - "created"
expected_state:
  - "file"
assertions:
  - "idempotent"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-LOCK-007 — No automatic lock deletion

```yaml
id: E2E-LOCK-007
title: "No automatic lock deletion"
category: locks
priority: P0
source_references:
  - "docs:E2E guide sec5"
requirements:
  - "D-024"
preconditions:
setup:
  - "stale lock"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "blocked"
expected_state:
  - "manual only"
assertions:
  - "safety"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-LOCK-008 — Journal not truncated on recovery

```yaml
id: E2E-LOCK-008
title: "Journal not truncated on recovery"
category: locks
priority: P0
source_references:
  - "docs:E2E guide sec5"
requirements:
  - "D-024"
preconditions:
setup:
  - "non-empty journal"
stimulus:
  - "inspect"
expected_mcp_calls:
expected_events:
  - "preserved"
expected_state:
  - "bytes unchanged"
assertions:
  - "evidence"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-UI-001 — Desktop dashboard shows connection state

```yaml
id: E2E-UI-001
title: "Desktop dashboard shows connection state"
category: ui
priority: P1
source_references:
  - "extention-proxy/desktop/renderer.js"
  - "docs:D-050"
requirements:
  - "D-050"
preconditions:
setup:
  - "proxy running"
stimulus:
  - "open UI"
expected_mcp_calls:
expected_events:
  - "rendered"
expected_state:
  - "connected/disconnected"
assertions:
  - "visual"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-UI-002 — Queue depth and blocked state visible

```yaml
id: E2E-UI-002
title: "Queue depth and blocked state visible"
category: ui
priority: P1
source_references:
  - "extention-proxy/test/queue-recovery-ui.test.mjs"
requirements:
  - "D-050"
preconditions:
setup:
  - "queue"
stimulus:
  - "open UI"
expected_mcp_calls:
expected_events:
  - "rendered"
expected_state:
  - "queue_blocked"
assertions:
  - "actionable"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-UI-003 — UI assets load

```yaml
id: E2E-UI-003
title: "UI assets load"
category: ui
priority: P2
source_references:
  - "extention-proxy/test/ui-assets.test.mjs"
requirements:
  - "D-050"
preconditions:
setup:
  - "desktop"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "assets"
expected_state:
  - "no 404"
assertions:
  - "load"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-UI-004 — UI redesign contract

```yaml
id: E2E-UI-004
title: "UI redesign contract"
category: ui
priority: P2
source_references:
  - "extention-proxy/test/ui-redesign-contract.test.mjs"
requirements:
  - "D-050"
preconditions:
setup:
  - "desktop"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "contract"
assertions:
  - "visual"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-UI-005 — Tab presence renderer

```yaml
id: E2E-UI-005
title: "Tab presence renderer"
category: ui
priority: P2
source_references:
  - "extention-proxy/test/tab-presence-renderer.test.mjs"
requirements:
  - "D-050"
preconditions:
setup:
  - "tabs"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "presence"
assertions:
  - "presentation only"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-UI-006 — Orphan notice display

```yaml
id: E2E-UI-006
title: "Orphan notice display"
category: ui
priority: P1
source_references:
  - "docs:D-010"
requirements:
  - "D-010"
preconditions:
setup:
  - "cancel"
stimulus:
  - "observe UI"
expected_mcp_calls:
expected_events:
  - "notice"
expected_state:
  - "text"
assertions:
  - "informational"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-UI-007 — Tray connection setup

```yaml
id: E2E-UI-007
title: "Tray connection setup"
category: ui
priority: P2
source_references:
  - "extention-proxy/test/tray-connection-setup.test.mjs"
requirements:
  - "D-050"
preconditions:
setup:
  - "tray"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "setup"
assertions:
  - "ui"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-UI-008 — Tray lifecycle

```yaml
id: E2E-UI-008
title: "Tray lifecycle"
category: ui
priority: P2
source_references:
  - "extention-proxy/test/tray-lifecycle.test.mjs"
requirements:
  - "D-062"
preconditions:
setup:
  - "tray"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "exit behavior"
assertions:
  - "settings"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-UI-009 — X button minimize to tray setting

```yaml
id: E2E-UI-009
title: "X button minimize to tray setting"
category: ui
priority: P2
source_references:
  - "docs:D-061"
requirements:
  - "D-061"
preconditions:
setup:
  - "setting"
stimulus:
  - "close window"
expected_mcp_calls:
expected_events:
  - "minimized"
expected_state:
  - "tray"
assertions:
  - "persisted"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-UI-010 — Explicit exit asks keep/close browser

```yaml
id: E2E-UI-010
title: "Explicit exit asks keep/close browser"
category: ui
priority: P2
source_references:
  - "docs:D-062"
requirements:
  - "D-062"
preconditions:
setup:
  - "exit"
stimulus:
  - "tray exit"
expected_mcp_calls:
expected_events:
  - "prompt"
expected_state:
  - "options"
assertions:
  - "user choice"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-SEC-001 — No guessed agent identity from focus

```yaml
id: E2E-SEC-001
title: "No guessed agent identity from focus"
category: security
priority: P0
source_references:
  - "docs:D-008"
  - "extention-proxy/server.js:attachProfile"
requirements:
  - "D-008"
preconditions:
setup:
  - "focus changes"
stimulus:
  - "MCP call"
expected_mcp_calls:
expected_events:
  - "no auto manager"
expected_state:
  - "denied without credential"
assertions:
  - "trust boundary"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-002 — Caller supplied caller_tab_id is assertion only

```yaml
id: E2E-SEC-002
title: "Caller supplied caller_tab_id is assertion only"
category: security
priority: P0
source_references:
  - "extention-proxy/server.js:callerTabInput"
requirements:
  - "D-008"
preconditions:
setup:
  - "paired"
stimulus:
  - "call with wrong tab id"
expected_mcp_calls:
expected_events:
  - "verification"
expected_state:
  - "mismatch error"
assertions:
  - "not authority"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-003 — Owner ACL profile-local tasks

```yaml
id: E2E-SEC-003
title: "Owner ACL profile-local tasks"
category: security
priority: P0
source_references:
  - "extention-proxy/test/owner-acl.test.mjs"
requirements:
  - "D-038"
preconditions:
setup:
  - "two owners"
stimulus:
  - "access other"
expected_mcp_calls:
expected_events:
  - "denied"
expected_state:
  - "forbidden"
assertions:
  - "isolation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-004 — Public MCP cannot access private queue

```yaml
id: E2E-SEC-004
title: "Public MCP cannot access private queue"
category: security
priority: P0
source_references:
  - "extention-proxy/test/public-mcp-isolation.test.mjs"
requirements:
  - "D-038"
preconditions:
setup:
  - "public token"
stimulus:
  - "call private tool"
expected_mcp_calls:
expected_events:
  - "not present"
expected_state:
  - "denied"
assertions:
  - "boundary"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-005 — Rate limiting on public port

```yaml
id: E2E-SEC-005
title: "Rate limiting on public port"
category: security
priority: P2
source_references:
  - "extention-proxy/server.js:publicRateLimited"
requirements:
  - "D-038"
preconditions:
setup:
  - "flood"
stimulus:
  - "many requests"
expected_mcp_calls:
expected_events:
  - "429"
expected_state:
  - "rate limited"
assertions:
  - "protection"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-006 — Extension profile token auth

```yaml
id: E2E-SEC-006
title: "Extension profile token auth"
category: security
priority: P1
source_references:
  - "extention-proxy/test/profile-token-auth.test.mjs"
requirements:
  - "D-004"
preconditions:
setup:
  - "token"
stimulus:
  - "connect"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "auth"
assertions:
  - "profile"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-007 — Agent binding encryption at rest

```yaml
id: E2E-SEC-007
title: "Agent binding encryption at rest"
category: security
priority: P2
source_references:
  - "extention-proxy/agent-binding-store.mjs"
requirements:
  - "D-037"
preconditions:
setup:
  - "paired"
stimulus:
  - "inspect file"
expected_mcp_calls:
expected_events:
  - "encrypted"
expected_state:
  - "not plaintext"
assertions:
  - "AES-GCM"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-008 — No credential in logs

```yaml
id: E2E-SEC-008
title: "No credential in logs"
category: security
priority: P1
source_references:
  - "extention-proxy/diagnostics.mjs"
requirements:
  - "D-008"
preconditions:
setup:
  - "operations"
stimulus:
  - "inspect logs"
expected_mcp_calls:
expected_events:
  - "redacted"
expected_state:
  - "no credential"
assertions:
  - "privacy"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-SEC-009 — Cross-principal denial

```yaml
id: E2E-SEC-009
title: "Cross-principal denial"
category: security
priority: P0
source_references:
  - "extention-proxy/test/private-coordination-mcp.test.mjs"
requirements:
  - "D-038"
preconditions:
setup:
  - "two principals"
stimulus:
  - "cross call"
expected_mcp_calls:
expected_events:
  - "forbidden"
expected_state:
  - "denied"
assertions:
  - "isolation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-010 — Revoked agent cannot call

```yaml
id: E2E-SEC-010
title: "Revoked agent cannot call"
category: security
priority: P0
source_references:
  - "extention-proxy/caller-identity.mjs:revoke"
requirements:
  - "D-008"
preconditions:
setup:
  - "revoked"
stimulus:
  - "call"
expected_mcp_calls:
expected_events:
  - "denied"
expected_state:
  - "missing credential"
assertions:
  - "revocation"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-SEC-011 — Detached orphan calls denied

```yaml
id: E2E-SEC-011
title: "Detached orphan calls denied"
category: security
priority: P0
source_references:
  - "docs:D-012"
requirements:
  - "D-012"
preconditions:
setup:
  - "orphaned child"
stimulus:
  - "call"
expected_mcp_calls:
expected_events:
  - "403/tool error"
expected_state:
  - "denied"
assertions:
  - "scoped"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-SEC-012 — Idempotency scope includes credential

```yaml
id: E2E-SEC-012
title: "Idempotency scope includes credential"
category: security
priority: P1
source_references:
  - "extention-proxy/server.js:durableIdempotency"
requirements:
  - "D-034"
preconditions:
setup:
  - "two agents"
stimulus:
  - "same key different creds"
expected_mcp_calls:
expected_events:
  - "distinct"
expected_state:
  - "not shared"
assertions:
  - "scope"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CLEAN-001 — close_worker requires terminal history

```yaml
id: E2E-CLEAN-001
title: "close_worker requires terminal history"
category: cleanup
priority: P0
source_references:
  - "extention-proxy/server.js:close_worker"
requirements:
  - "D-045"
preconditions:
setup:
  - "running child"
stimulus:
  - "close_worker"
expected_mcp_calls:
  - "close_worker"
expected_events:
  - "blocked"
expected_state:
  - "error"
assertions:
  - "no close"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CLEAN-002 — close_worker requires processed receipts

```yaml
id: E2E-CLEAN-002
title: "close_worker requires processed receipts"
category: cleanup
priority: P0
source_references:
  - "extention-proxy/server.js:close_worker"
requirements:
  - "D-045"
preconditions:
setup:
  - "unacked event"
stimulus:
  - "close_worker"
expected_mcp_calls:
  - "close_worker"
expected_events:
  - "blocked"
expected_state:
  - "error"
assertions:
  - "receipts"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CLEAN-003 — Explicit close removes tab registry entry

```yaml
id: E2E-CLEAN-003
title: "Explicit close removes tab registry entry"
category: cleanup
priority: P1
source_references:
  - "extention-proxy/server.js:close_worker"
requirements:
  - "D-045"
preconditions:
setup:
  - "terminal child"
stimulus:
  - "close_worker"
expected_mcp_calls:
  - "close_worker"
expected_events:
  - "removed"
expected_state:
  - "registry updated"
assertions:
  - "cleanup"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-CLEAN-004 — No automatic worker closure

```yaml
id: E2E-CLEAN-004
title: "No automatic worker closure"
category: cleanup
priority: P1
source_references:
  - "extention-proxy/server.js:spawn_worker auto_close"
requirements:
  - "D-045"
preconditions:
setup:
  - "completed child"
stimulus:
  - "wait"
expected_mcp_calls:
expected_events:
  - "tab remains"
expected_state:
  - "not auto closed"
assertions:
  - "parent reviews"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CLEAN-005 — Managed browser close on exit option

```yaml
id: E2E-CLEAN-005
title: "Managed browser close on exit option"
category: cleanup
priority: P2
source_references:
  - "docs:D-062"
requirements:
  - "D-062"
preconditions:
setup:
  - "exit"
stimulus:
  - "tray exit"
expected_mcp_calls:
expected_events:
  - "prompt"
expected_state:
  - "keep/close"
assertions:
  - "user choice"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: manual_operator
automation_status: not_automated
```

## E2E-CLEAN-006 — Session storage cleared on reset

```yaml
id: E2E-CLEAN-006
title: "Session storage cleared on reset"
category: cleanup
priority: P2
source_references:
  - "extention/background.js:resetSession"
requirements:
  - "D-001"
preconditions:
setup:
  - "state"
stimulus:
  - "reset"
expected_mcp_calls:
expected_events:
  - "cleared"
expected_state:
  - "storage empty"
assertions:
  - "reset"
failure_injection:
timeout: "10s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CLEAN-007 — Temp session dir cleaned after stop

```yaml
id: E2E-CLEAN-007
title: "Temp session dir cleaned after stop"
category: cleanup
priority: P2
source_references:
  - "desktop/main.mjs:1341-1343"
requirements:
  - "D-024"
preconditions:
setup:
  - "graceful stop"
stimulus:
  - "stop"
expected_mcp_calls:
expected_events:
  - "cleaned"
expected_state:
  - "if no lock"
assertions:
  - "cleanup"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-CLEAN-008 — No stale lock after graceful stop

```yaml
id: E2E-CLEAN-008
title: "No stale lock after graceful stop"
category: cleanup
priority: P0
source_references:
  - "desktop/main.mjs:1341-1343"
requirements:
  - "D-024"
preconditions:
setup:
  - "graceful stop"
stimulus:
  - "stop"
expected_mcp_calls:
expected_events:
  - "lock gone"
expected_state:
  - "phase stopped"
assertions:
  - "restart ready"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PERF-001 — 50 spawn complete review close cycles

```yaml
id: E2E-PERF-001
title: "50 spawn complete review close cycles"
category: performance
priority: P2
source_references:
  - "extention-proxy/test/endurance-st05.test.mjs"
requirements:
  - "D-046"
preconditions:
setup:
  - "isolated"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "pass"
expected_state:
  - "no leak/bloat"
assertions:
  - "endurance"
failure_injection:
timeout: "300s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PERF-002 — Journal bounded under load

```yaml
id: E2E-PERF-002
title: "Journal bounded under load"
category: performance
priority: P2
source_references:
  - "extention-proxy/test/endurance-st05.test.mjs"
requirements:
  - "D-024"
preconditions:
setup:
  - "load"
stimulus:
  - "run"
expected_mcp_calls:
expected_events:
  - "bounded"
expected_state:
  - "journal size"
assertions:
  - "no bloat"
failure_injection:
timeout: "300s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PERF-003 — Completion monitor polling budget

```yaml
id: E2E-PERF-003
title: "Completion monitor polling budget"
category: performance
priority: P2
source_references:
  - "extention/background.js:completionMonitorSettings"
requirements:
  - "D-044"
preconditions:
setup:
  - "many tasks"
stimulus:
  - "monitor"
expected_mcp_calls:
expected_events:
  - "budget"
expected_state:
  - "intervals"
assertions:
  - "configurable"
failure_injection:
timeout: "60s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: not_automated
```

## E2E-PERF-004 — Read chat max 200 messages

```yaml
id: E2E-PERF-004
title: "Read chat max 200 messages"
category: performance
priority: P2
source_references:
  - "extention-proxy/server.js:read_chat"
requirements:
  - "D-074"
preconditions:
setup:
  - "200+ messages"
stimulus:
  - "read_chat"
expected_mcp_calls:
  - "read_chat"
expected_events:
  - "limited"
expected_state:
  - "200 max"
assertions:
  - "bounded"
failure_injection:
timeout: "30s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PERF-005 — Tab registry load performance 200 entries

```yaml
id: E2E-PERF-005
title: "Tab registry load performance 200 entries"
category: performance
priority: P2
source_references:
  - "extention-proxy/tab-registry.mjs"
requirements:
  - "D-025"
preconditions:
setup:
  - "200 entries"
stimulus:
  - "start"
expected_mcp_calls:
expected_events:
  - "loaded"
expected_state:
  - "time"
assertions:
  - "acceptable"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

## E2E-PERF-006 — Event queue memory cap 4096

```yaml
id: E2E-PERF-006
title: "Event queue memory cap 4096"
category: performance
priority: P2
source_references:
  - "extention-proxy/server.js:PRIVATE_EVENT_LIMIT"
requirements:
  - "D-049"
preconditions:
setup:
  - "4096 events"
stimulus:
  - "enqueue 4097"
expected_mcp_calls:
expected_events:
  - "rejected"
expected_state:
  - "cap"
assertions:
  - "bounded"
failure_injection:
timeout: "20s"
cleanup:
browsermcp_boundary: "none"
execution_mode: automated
automation_status: automated
```

