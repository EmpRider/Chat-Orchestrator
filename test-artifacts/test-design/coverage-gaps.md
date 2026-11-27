# Coverage Gaps

Total scenarios: 268 (P0: 124)

## Category counts

- browser_refresh_closure: 10
- child_creation: 12
- cleanup: 8
- completion: 12
- concurrency: 12
- event_queues: 14
- extension_init: 12
- extension_reload: 8
- fifo_acks: 12
- locks: 8
- mcp_connection: 12
- multi_parent: 8
- nested_delegation: 10
- ngrok: 8
- pairing: 14
- parent_registration: 12
- performance: 6
- prompt_submission: 12
- proxy_restart: 12
- recovery: 12
- response_reading: 10
- security: 12
- session_incarnation: 12
- startup: 10
- ui: 10

## Remaining untested branches/transitions/dependencies

- Windows power-loss directory-entry durability not independently proven (manual reconcile).
- Live Chrome/Edge production extension install and store distribution not exercised.
- ngrok live tunnel production path only manual/operator.
- Browser refresh server-side task continuation is user assumption A-002, not verified.
- Parent unregistration live behavior remains open (D-006 boundary).
- Detached orphan 403 transport representation (HTTP vs MCP error) not finalized.
- Update installer and tray exit flows require interactive operator.
- Performance baselines (memory, journal growth) require long-run measurement.
