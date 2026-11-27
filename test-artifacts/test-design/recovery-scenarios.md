# Recovery / Concurrency / Stress E2E Scenarios

Source-grounded. Priority: P0/P1 release blockers. IDs: RC-xxx.

## RC-01 Proxy restart during active task
- category: recovery
- priority: P0
- source_references: server.js:3526-3702 startServer/stopServer; desktop/main.mjs:532-657 startProxy; caller-identity.mjs reattach
- preconditions: Parent paired, child running
- setup: spawn child task
- stimulus: graceful restart proxy
- expected_state: journal lock released; parent reattaches; child reconstructs; no blind replay
- assertions: /health storageReady true; parent identity survives; no duplicate child
- cleanup: close child

## RC-02 Extension reload during delivery
- category: recovery
- priority: P0
- source_references: background.js:1624-1677 bindExtensionSocket; server.js:1697 wss connection
- preconditions: queue batch in flight
- setup: trigger child result
- stimulus: reload extension
- expected_state: failSocketPending; recovery diagnostics; queue holds
- assertions: no duplicate manager wake; batch remains DELIVERED until ACK
- cleanup: re-ACK

## RC-03 Parent tab refresh
- category: recovery
- priority: P1
- source_references: background.js handleManagedTabRemoved; server.js reattachApprovedAgents
- preconditions: parent paired
- setup: refresh parent tab
- stimulus: page reload
- expected_state: incarnation changes; credential revoked; re-pair required
- assertions: read_chat fails identity_changed; no silent promotion
- cleanup: re-pair

## RC-04 Child tab close unexpectedly
- category: recovery
- priority: P0
- source_references: background.js:3698 handleManagedTabRemoved; server.js closeReviewedWorker
- preconditions: child running
- setup: close child tab
- stimulus: tab removal
- expected_state: CHILD_TAB_LOST event; parent notified
- assertions: no orphaned task; closure decision recorded
- cleanup: resolve closure

## RC-05 Stale lock: dead owner + empty journal
- category: recovery
- priority: P0
- source_references: coordination-storage.mjs:92-134 inspectJournalRecovery; 138-168 archiveEmptyStaleJournalLock
- preconditions: dead PID owns lock; journal 0 bytes
- setup: force-kill proxy (recorded deviation)
- stimulus: startup
- expected_state: EMPTY_STALE_LOCK; archive enabled
- assertions: archive succeeds; proxy starts; storageReady true
- cleanup: none

## RC-06 Stale lock: dead owner + non-empty journal
- category: recovery
- priority: P0
- source_references: coordination-storage.mjs:124-126 JOURNAL_NOT_EMPTY
- preconditions: dead owner; journal >0 bytes
- setup: reconcile deliveries manually
- stimulus: startup
- expected_state: JOURNAL_NOT_EMPTY; archive disabled
- assertions: no auto-delete; manual reconciliation required
- cleanup: reconcile

## RC-07 Corrupt lock
- category: recovery
- priority: P1
- source_references: coordination-storage.mjs:106-119 OWNER_UNVERIFIED
- preconditions: malformed lock JSON
- setup: write bad lock
- stimulus: startup
- expected_state: OWNER_UNVERIFIED
- assertions: fail closed; no auto-recovery
- cleanup: manual reconcile

## RC-08 Partial batch ACK after crash
- category: recovery
- priority: P0
- source_references: server.js reducePrivateQueueEvents; fifo.ack_processed
- preconditions: batch delivered
- setup: crash before ACK
- stimulus: restart
- expected_state: PROCESSED items become UNCERTAIN
- assertions: no blind replay; manual re-ACK required
- cleanup: re-ACK with same lease_nonce

## RC-09 Spawn submission hold reconciliation
- category: recovery
- priority: P0
- source_references: server.js:471,507-533 spawnSubmissionHolds
- preconditions: unverified submission
- setup: submission uncertain
- stimulus: next spawn
- expected_state: spawn blocked until original owner reconciles
- assertions: invalid owner rejects; no prompt replay
- cleanup: reconcile or close child

## RC-10 Concurrent multiple parents
- category: concurrency
- priority: P0
- source_references: tab-registry.mjs within/directChild; server.js forward read path
- preconditions: two paired parents
- setup: both spawn children
- stimulus: concurrent operations
- expected_state: cross-parent isolation enforced
- assertions: read_chat across ancestry refused; no tab ID crossing
- cleanup: close all children

## RC-11 Queue saturation and FIFO ordering
- category: stress
- priority: P1
- source_references: server.js fifo.batch_prepared; oversized event handling
- preconditions: queue depth > capacity
- setup: flood events
- stimulus: pump
- expected_state: oldest prefix leased; oversized event manual
- assertions: no duplicate; order preserved
- cleanup: drain queue

## RC-12 Completion monitor manual-required
- category: completion
- priority: P1
- source_references: background.js:823-875 completion monitor; cue vocabulary
- preconditions: child answers short without cue
- setup: spawn task
- stimulus: wait 5+3+1 min
- expected_state: manual_required; desktop panel populated
- assertions: no auto-completion; operator decision required
- cleanup: manual Completed/In Progress

## RC-13 Busy child follow-up queued
- category: lifecycle
- priority: P1
- source_references: background.js startTask throws outstanding task; server.js send_to_tab FIFO
- preconditions: child has running task
- setup: send follow-up
- stimulus: send_to_tab
- expected_state: queued receipt; later delivery
- assertions: no interruption; idempotent retry
- cleanup: review + close

## RC-14 Five-second close dialog gate
- category: ui
- priority: P2
- source_references: desktop close dialog UC-12
- preconditions: closure pending
- setup: trigger close
- stimulus: cancel within 5s
- expected_state: pending-choice authorized calls finish; post-cancel unmanaged child
- assertions: no silent close
- cleanup: resolve

## RC-15 Reconnect waits for extension
- category: recovery
- priority: P1
- source_references: server.js waitForExtensionReconnect; D-029/D-030
- preconditions: extension disconnected
- setup: issue MCP call
- stimulus: disconnect
- expected_state: holds up to 55s then fails; no later execution
- assertions: no orphaned side effect
- cleanup: reconnect

## RC-16 Journal poison on bad tail
- category: recovery
- priority: P0
- source_references: server.js openPrivateEventJournal; poisoned flag
- preconditions: corrupted tail bytes
- setup: append bad bytes
- stimulus: startup
- expected_state: PRIVATE_JOURNAL_RECONCILIATION_REQUIRED
- assertions: no auto-repair; manual reconcile
- cleanup: restore journal

## RC-17 Accident restore nested tabs
- category: recovery
- priority: P1
- source_references: background.js handleManagedTabRemoved; desktop reconcileMissedChildClosures
- preconditions: parent closed with descendants
- setup: close parent
- stimulus: accident restore
- expected_state: explicit Accident/Yes/Cancel decision; no silent close
- assertions: recursive scope; 5s enable
- cleanup: resolve decision

## RC-18 Idempotency same-key replay
- category: security
- priority: P1
- source_references: durable-idempotency.mjs; idempotency ledger
- preconditions: prior call completed
- setup: replay same key+args
- stimulus: repeat call
- expected_state: identical response; no side effect
- assertions: same-key different-args -> conflict
- cleanup: none

## RC-19 Cross-profile isolation
- category: security
- priority: P0
- source_references: server.js:1524-1545 extensionSocketFor; list_tabs browser_session_id
- preconditions: two browser profiles
- setup: pair both
- stimulus: cross-session read
- expected_state: refused; no tab ID crossing
- assertions: list_tabs scoped by session
- cleanup: close both

## RC-20 Resource exhaustion journal
- category: stress
- priority: P2
- source_references: coordination-storage PRIVATE_JOURNAL_MAX_BYTES 32MB; 4096 events
- preconditions: journal near limit
- setup: flood events
- stimulus: append
- expected_state: bounded; no unbounded growth
- assertions: size <= 32MB
- cleanup: reset isolated journal
