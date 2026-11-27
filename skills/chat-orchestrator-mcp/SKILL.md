---
name: chat-orchestrator-mcp
description: Use Chat Orchestrator as an MCP server — pair once, then delegate work to managed Child ChatGPT tabs, wait for notifications instead of polling, review results, and close workers. Covers the transport, all 22 tools, required parameters, and the failure modes that silently deadlock a Parent.
---

# Chat Orchestrator MCP — usage contract

You are an agent talking to **Chat Orchestrator**, a local proxy that owns real ChatGPT browser
tabs. It lets you spawn Child conversations, give them work, and get their results back — from
inside the same computer. You are a **Parent**; the tabs it opens are **Children**.

This file is the whole contract. Read it once; you will not need the source.

---

## 1. Transport

Your host already holds the connection. **Both listeners bind loopback only** (`127.0.0.1`); a
public connector is an HTTPS tunnel forwarding to the second port, never a network-exposed bind.

| Route | Auth | Where it is used |
|---|---|---|
| `POST http://127.0.0.1:8787/mcp` | none | Local loopback client |
| `POST <tunnel>/mcp/agent/<64 hex token>` | token in the **path** | ChatGPT connector (preferred public shape) |
| `POST <tunnel>/mcp` | `Authorization: Bearer <64 hex>` | Public bearer alternative |

The two token forms are the same 32-byte secret from the profile's `public-mcp-token.txt`. It is a
**transport** credential, not an Agent identity — pairing (§3) is still required on top of it.
Wrong or missing token → HTTP 401, JSON-RPC `-32001`.

Protocol: JSON-RPC 2.0 over HTTP, MCP `streamable-http`. Stateless — `GET` returns `405`. Every
request is a `POST`.

If you were told to "pick the Chat Orchestrator connector", pick the **exact connector name your
user configured**. Never fall back to a similarly-named connector from another computer, even
though the tool names are identical. If it is missing or ambiguous, stop and ask.

---

## 2. Two parameters on (almost) every call

The server injects both into every tool's schema. Omitting either is the most common first-run
failure.

- **`idempotency_key`** — required on **every one of the 22 tools**. A UUID **you** generate.
  Use a **fresh** UUID for each logical request, including each fresh read.
  Reuse a key **only** when retrying the identical request after a transport error.
  Same key + same request → the exact first response is replayed, including cached encrypted
  read snapshots. Same key + different request → error.
- **`agent_credential`** — required on every tool **except `pair_conversation`** (the only
  exception). A 64-char lowercase hex string issued by pairing (§3). It binds you to one tab and
  one conversation; it is **revoked** the moment that tab's URL or incarnation changes.

Wherever this document says "Required: X", read it as **"X, plus `idempotency_key` and
`agent_credential`"**. Those two are never repeated per tool.

Missing `agent_credential` → `Missing or revoked Agent credential; pair this tab first`.
Missing `idempotency_key` → `-32602 … Required at idempotency_key` (the MCP SDK's wording for a
missing required argument).

---

## 3. Pair first — `pair_conversation`

Nothing else works until you pair. One call:

```json
{"code": "<uuid pairing code>", "idempotency_key": "<fresh uuid>"}
```

- `code` is a **single-use UUID** the user obtains from the extension: a panel in the ChatGPT
  tab, or a setup prompt already in your conversation. It is process-local — it dies when the
  Proxy restarts.
- The Proxy verifies the tab still exists, is the same incarnation, is user-approved (Parent) or
  already-owned (Child), and that the extension socket is still live. Any mismatch → error, and
  you need a **new** code.

Returns:

```json
{"paired": true, "tab_id": 1234, "browser_session_id": "<uuid>", "agent_id": "<id>",
 "agent_credential": "<64 hex>", "recovery": {"attached": 0, "held": 0},
 "no_browser_prompt_replayed": true}
```

**Store `agent_credential` for the rest of the session. Never print it, echo it, or put it in a
final answer.** Re-pairing issues a new credential and revokes the old one.

Common pairing errors and what they mean:

| Error | Action |
|---|---|
| `Original extension socket disconnected; generate another pairing code` | Ask the user for a fresh code. |
| `Pairing tab changed before approval` | The tab navigated. Ask for a fresh code. |
| `Parent tab must be explicitly approved by the user before pairing` | The user has not clicked Yes. Ask. |
| `Only an already-owned managed Child can pair as a Child Agent` | You are in a tab the Proxy does not own. |
| `code` already used / unknown | Codes are single-use. Ask for a fresh one. |

---

## 4. The worker lifecycle

```
spawn_worker ──► task_id + tab_id ──► Child works ──► CHILD_RESULT notification
                                          │                       │
                                          │                       ▼
                                          │              read_chat / get_result
                                          │                       │
                                          │                       ▼
                                          │              review_task  ──► close_worker
                                          ▼
                                    complete_task (Child calls this itself)
```

### 4.1 `list_tabs` — discover what you may touch

Only `idempotency_key` + `agent_credential`. Optional `browser_session_id`, `caller_tab_id`.

Returns only your own paired tab plus the descendants you own — never another Parent's tabs.
Each row: `tab_id, window_id, site, title, url, active, role` (`orchestrator` = you, `worker` =
a Child), `incarnation_id`, plus `parent_tab_id` / `root_tab_id`. When more than one browser
profile is connected, each row is additionally tagged with `browser_session_id` — that is where
you learn the value you pass to scope later calls. You never need it up front.

**This is where `tab_id` comes from.** `spawn_worker` returns a `task_id` and a `tab_id`, but if
you ever lose the `tab_id`, `list_tabs` is the recovery path — match on `role: "worker"`.

Use it to recover a `tab_id` you lost. It is read-only and safe to call at any time.

### 4.2 `spawn_worker` — open a Child chat

Required: `task`. Optional: `site` (only `"chatgpt"` works in v1),
`operation` (`task` | `workspace` | `delegation`), `role` / `role_scope` (reusable **seat labels**
— metadata only, never authorization; same label + scope reuses the same idle chat),
`saga_task_id` (external tracker reference — never an identity), `wait_seconds`, `caller_tab_id`,
`browser_session_id`.

Do not confuse the two `role` values: `spawn_worker.role` is a **seat label you choose**, while
the `role` field in a `list_tabs` row is **fixed** (`orchestrator` | `worker`).

`task` must be **self-contained** — the Child sees only that text plus a setup block. It carries
the pairing code and the `complete_task` instruction, so do not duplicate them.

Returns `{task_id, tab_id, status, elapsed_seconds, submission_confirmed, ...}`. **Keep both.**
`task_id` for every later call about this work; `tab_id` for `read_chat`, `review_task`,
`send_to_tab` and `close_worker`.

`site` other than `chatgpt` → `{spawned:false, status:'PROVIDER_NOT_SUPPORTED'}`. That is a
definitive answer, not an error to retry.

Submission is verified by the content script. Two failure codes matter:

- `SUBMISSION_NOT_ATTEMPTED` — prompt definitely not sent; the tab has a draft you can inspect.
- `SUBMISSION_UNCERTAIN` — may or may not have been sent. **Never blindly re-send.** Inspect with
  `read_chat` first. The Proxy already tries one reconciliation pass before raising this.

### 4.3 Waiting — the rule that matters most

> **After dispatching all your intended Children, END YOUR RESPONSE and yield.**

The orchestrator delivers completion as a **notification** to you. Do **not** loop on
`get_result` or any status tool. One status check is allowed for an explicit user request or a
genuine recovery. Continuous polling wastes your turn and is explicitly refused by the product's
own prompt contract.

`get_result(task_id, wait_seconds ≤ 50)` — `task_id` required, `wait_seconds` optional, capped at
50. It exists for that single check, not for waiting.

**Does the notification require setup?** Two-way:

- **Without private coordination** (the default 11-tool endpoint), the notification is delivered
  by the orchestrator into your conversation. Nothing to enable.
- **With private coordination**, delivery is the durable FIFO queue: call
  `coordination_register_manager` **once** after pairing, and delivery is armed automatically
  (registering already arms it). Then `coordination_start_delivery` is only needed to re-arm after
  you have paused, and `coordination_pause_delivery` stops new dispatch. If in doubt whether the
  queue is active, call `coordination_pending` — an error there means the queue is not enabled for
  this profile, and the plain orchestrator notification path applies.

### 4.4 `send_to_tab` — follow-up or fixing task

Required: `tab_id`, `text`.

- **Child-bound** → returns a new `task_id`. The text is automatically wrapped in the delegation
  contract, so the Child knows to call `complete_task`. **That new `task_id` is what you pass to
  `review_task` and `close_worker`** — review is per-task, so a Child you sent two tasks has two
  results to review, and both must be reviewed before the tab is closable.
- **Parent-bound** (a Child asking you something) → goes into the ordered FIFO queue and returns
  `QUEUED` with an `event_id`, **not** a `task_id` (`sent:false, task_created:false`). This path
  requires private coordination to be active; without it the call errors. Parent-bound text is
  capped at 3000 characters.

A worker whose phase is `prepared` or `uncertain` refuses new messages:
`Worker is prepared or UNCERTAIN; reconcile before another message`. Reconcile with `read_chat`
and `get_result` before retrying.

### 4.5 `review_task` — mandatory, not optional

Required: `tab_id`, `task_id`. Parent-only.

```json
{"tab_id": 1234, "task_id": "<uuid>",
 "agent_credential": "<64 hex>", "idempotency_key": "<fresh uuid>"}
```

Refused while the task is `running`, `queued`, `uncertain` or
`waiting_for_parent_context` (`Task is still active, queued or uncertain; review not possible`).
Review only what is terminal.

A Child's terminal result is **not** complete from your point of view until you review it. An
unreviewed descendant keeps **your own** task stuck in `waiting_for_children` forever. Review
every notified Child — every `task_id` you created for it — then close it.

This is the single most common deadlock: a Parent that reads a result and moves on without
calling `review_task` waits forever for a notification that will never come.

### 4.6 `close_worker`

Required: `tab_id`. Refuses if the Child has descendants, if its task history is not terminal or
not all reviewed, or (with coordination enabled) if its FIFO receipts are unacknowledged.

Open Children consume worker slots (default max 10, configurable 1–10). Leaving reviewed Children
open eventually makes new `spawn_worker` calls fail with `SUB_AGENT_LIMIT_REACHED` — and the error
message names which open tabs you can close to free a slot. Read it; it hands you the fix.

### 4.7 `complete_task` — what a Child calls

Required: nothing beyond `idempotency_key`; optional `task_id`, `summary`. This is for **you when
you are a Child**, not for a Parent.

`task_id` is optional only because a Child usually has exactly one active task, which the Proxy
resolves for you; supply it when more than one of your tasks could match. Completion is held until
your own descendants finish and are reviewed; your status becomes `waiting_for_children`, then
`done`.

Answering in chat is **not** completion. A settled assistant turn alone is not accepted as one:
the completion monitor requires an explicit final-answer cue and a minimum length. If your Child
simply stops after answering briefly, the task stays `running`.

### 4.8 Recovery tools

- `reopen_child(task_id)` — `task_id` required. Reopen a saved Child conversation after
  `CHILD_TAB_LOST`. Returns a new `tab_id`. **Execution is not resumed.** Read it, compare, then
  decide. Never blindly replay.
- `request_parent_context(question)` — `question` required (≤3500 chars). Child-side; asks its
  direct Parent for missing context without losing its task. The Parent answers with
  `send_to_tab`, which lands as a `QUEUED` event (no new `task_id`).
- `coordination_inspect_worker_tasks(tab_id)` — `tab_id` required. Read-only task IDs and statuses
  for a direct Child. This is the safe way to recover a lost `task_id`; it never retries work.
  It is one of the 11 coordination tools (§6), so it only exists when the queue does — the 11 core
  tools are the other eleven, and `reopen_child` / `request_parent_context` / `read_chat` are core.
- `read_chat(tab_id, last_n, include_reasoning, include_attachments)` — all optional; `tab_id`
  defaults to your own tab, `last_n` ≤ 200, reasoning excluded by default, attachment labels
  included by default (bytes never downloaded). Reads any tab you own or a descendant of yours.
  This is how you verify an actual answer, not how you wait for one.

---

## 5. Task statuses

`summarize()` on every task returns:

| Status | Meaning | What you do |
|---|---|---|
| `running` | Child still working | Yield, wait for notification |
| `done` | Terminal, result available | `review_task`, then `close_worker` |
| `failed` | Terminal, error in `error` | Inspect, then close |
| `uncertain` | Submission outcome unknown | Inspect with `read_chat`; **never replay** |
| `queued` | Accepted into a Child FIFO, not yet submitted | Wait; do not re-send |
| `waiting_for_children` | Child finished; descendants pending review | Review + close descendants |
| `waiting_for_parent_context` | Child asked you a question | Answer via `send_to_tab` |
| `closed_pending_decision` | Tab closed; user must choose | Wait for the user |
| `detached` | User cancelled; the browser tab may still exist but is no longer managed | Do not treat as complete; do not close it on the user's behalf. The Proxy will not deliver a result for it. |

Plus `submission_confirmed` (bool) and `submission_evidence` (which path proved submission).

There is **no `monitor` object in the response** — the monitor state reaches you only as prose in
`note`. When `status` is `running` and `note` says *"automatic completion checks are exhausted and
no notification will arrive on its own"*, no notification is coming. Tell the user: they must
decide Completed / In Progress in the Desktop app, or the Child must call `complete_task`. Do not
sit and wait.

That state is reached on the 4th scheduled check (the default `[5,3,1]` minute ladder); it is
reached by *any* answer the monitor refuses, including a short one with no final-answer cue. A
`running` note that instead says *"await the orchestrator completion notification"* still means
yield — do not re-poll to find out which note you get.

---

## 6. Private coordination queue (11 extra tools)

These 11 exist **only** when the profile has private coordination enabled; a profile without it
exposes the 11 core tools, not 22. Total is 22 with the queue, 11 without. If a
`coordination_*` call returns `-32602 … Tool coordination_pending not found`, the queue is off —
use the plain orchestrator notification path instead (§4.3).

All of them require `idempotency_key` and `agent_credential` like everything else, and each also
accepts `caller_tab_id` / `browser_session_id` as optional confirmation (the Proxy derives the
caller from your credential).

Where do `batch_id` and `event_ids` come from? **From `coordination_pending`** — that is the only
source. It returns `{events: [...]}`; each row carries `ref` (the event id), `phase`, `entryType`
and `leaseNonce`. `leaseNonce` is `null` while the row is `QUEUED` and becomes the batch id once
the row is leased.

**The only rows you may ACK are those in phase `DELIVERED` with the same `leaseNonce`.**
`coordination_ack_batch` rejects anything else: the delivered count must exactly equal
`event_ids.length` and `event_ids[i]` must equal the i-th delivered `ref`, in FIFO order. So:

```json
{"batch_id": "<the shared leaseNonce>",
 "event_ids": ["<ref of delivered row 1>", "<ref of delivered row 2>"],
 "agent_credential": "<64 hex>", "idempotency_key": "<fresh uuid>"}
```

When the queue is frozen, the same response also carries `queue_blocked`, whose fields are
snake_case (`ref`, `phase`, `lease_nonce`, `age_seconds`, `action`) — do not confuse the two
casing styles. In that case `batch_id` is `queue_blocked.lease_nonce`.

| Tool | Required args | Purpose |
|---|---|---|
| `coordination_register_manager` | — | Register your tab as a queue recipient; also arms delivery |
| `coordination_start_delivery` | — | Re-arm automatic batched wake after a pause |
| `coordination_pause_delivery` | — | Stop new dispatch (in-flight batch unchanged) |
| `coordination_pending` | — | Read your queue phases — the source of `batch_id` / `event_ids` |
| `coordination_status_request` | `summary` | Enqueue a STATUS_REQUEST barrier |
| `coordination_ack_batch` | `batch_id`, `event_ids[1..16]` | Acknowledge **after** processing every event |
| `coordination_get_report` | `event_id` | Read the immutable full report |
| `coordination_incarnation_conflicts` | — | Read unresolved prior generations; returns `snapshot_sha256` |
| `coordination_get_predecessor_event` | `event_id` | Read one historical event |
| `coordination_reconcile_predecessors` | `snapshot_sha256`, `confirmation:"QUARANTINE_UNPROCESSED_EVENTS"`, `reason` (10–512 chars) | Durably quarantine prior generations |
| `coordination_inspect_worker_tasks` | `tab_id` | Recover task IDs from an owned Child |

`snapshot_sha256` for `coordination_reconcile_predecessors` comes from
`coordination_incarnation_conflicts`; it is a fresh digest of the exact unresolved set, so a
stale one is refused. That refusal is the point — it prevents quarantining events you did not see.

Event types: `CHILD_RESULT`, `STATUS_REQUEST`, `CHILD_TAB_LOST`, `TOOL_FAILURE`.

Queue phases: `QUEUED → LEASED → DISPATCHING → DELIVERED → PROCESSED` (`SAGA_CONFIRMED` terminal
variant), or `UNCERTAIN`.

Rules that are not optional:

- **A chat submission is not proof you processed the event.** Call `coordination_ack_batch` only
  after actually reviewing each item, and ACK all of them together in FIFO order.
- **`DELIVERED` is never retried.** If `coordination_pending` returns a `queue_blocked` object, a
  previous ACK did not complete — re-send `coordination_ack_batch` with `batch_id` =
  `queue_blocked.lease_nonce` and the stuck rows' `ref`s. Nothing else will unfreeze your queue.
- **`UNCERTAIN` is never replayed.** Not on restart, not after reconnect, not by you.
- `coordination_reconcile_predecessors` **quarantines** historical events — it preserves them as
  unprocessed. It is an operator action requiring a fresh snapshot digest. Do not call it to make
  a blocker disappear.

**Order of operations when a Child finishes.** `review_task` and the ACK are two independent gates
and `close_worker` checks both, so both are required:

```
read_chat {tab_id}                     ← read the actual answer
review_task {tab_id, task_id}          ← marks the task parent_reviewed
coordination_pending {}                ← find the CHILD_RESULT row for that tab
coordination_ack_batch {batch_id, event_ids}
close_worker {tab_id}
```

`close_worker` refuses with `Parent has not ACKed worker result <task_id>` until a `CHILD_RESULT`
event for that exact task has reached `PROCESSED`/`SAGA_CONFIRMED`, and refuses with
`Worker tasks are missing, unresolved or awaiting explicit Parent review` until `review_task` ran.
Neither substitutes for the other.

**Parent-bound `send_to_tab` events have no separate ACK obligation.** They land as entry type
`STATUS_REQUEST` (`CHILD_MESSAGE` payload), not `CHILD_RESULT`, and `close_worker`'s receipt check
only looks at `CHILD_RESULT` rows for that tab — so a Child's question does not block closing it.
Ack them anyway when they are delivered, so the queue drains.

---

## 7. Error → action

| Message | Meaning | Action |
|---|---|---|
| `Missing or revoked Agent credential; pair this tab first` | Not paired, or the tab changed | Re-pair with a fresh code (§3) |
| `Unpaired Agent credential; use pair_conversation in the corresponding ChatGPT tab first` | Same, from a forwarded tool | Same |
| `Paired tab or conversation changed; re-pair the currently opened chat` | Tab navigated; credential revoked | Re-pair — the old credential is dead |
| `Provided tab ID conflicts with paired conversation` | You passed a `caller_tab_id` you do not own | Omit it; the Proxy derives the caller from your credential |
| `Unregistered caller: explicitly approve and pair this Parent in the extension` | Pairing did not complete | Ask the user to approve the tab |
| `Worker is prepared or UNCERTAIN; reconcile before another message` | Prior submission unproven | `read_chat` + `get_result`, then decide |
| `Task is still active, queued or uncertain; review not possible` | `review_task` on a non-terminal task | Wait for terminal state |
| `Child has descendants; close or reconcile them before closing this tab` | Bottom-up only | Close descendants first |
| `Parent has not ACKed worker result <id>` | FIFO receipt outstanding | `coordination_ack_batch` |
| `Required at idempotency_key` (-32602) | Missing required argument (the SDK's "Required <field>" wording) | Add the missing field |
| `Unknown immutable report in this caller scope` | Wrong `event_id` or wrong tab | Re-read `coordination_pending` |
| `Selected manager tab is not registered in this proxy session` | You used a `coordination_*` tool before registering | `coordination_register_manager` |
| `-32602 … Tool <name> not found` | Private coordination is off for this profile | Use the plain notification path (§4.3) |

Errors arrive as MCP results with `isError: true` and a plain-text message — **not** as JSON-RPC
errors, except schema validation (-32602) and transport auth (-32001).

---

## 8. Never

- **Never submit a Child's prompt through another controller** (browser automation, DOM scripts,
  a second MCP connection). The scenario is invalid even if the answer is right. Only
  `spawn_worker` / `send_to_tab` submit descendant work.
- Never print, log, or echo `agent_credential` or a pairing `code`.
- Never replay after `uncertain` / `UNCERTAIN` / `SUBMISSION_UNCERTAIN`.
- Never ACK a batch you have not read; never ACK partially.
- Never poll status in a loop. Yield and wait for the notification.
- Never skip `review_task`. An unreviewed Child deadlocks its Parent.
- Never delete or "clean up" journal lock files. Stale locks need owner verification and a
  recorded reconciliation, not deletion.
- Never claim a result you have not read with `read_chat` or `get_result`.

---

## 9. Minimal correct session

Every call below also carries `agent_credential` (except step 1) and a **fresh** `idempotency_key`.

```
1. pair_conversation {code}                            → save agent_credential
2. spawn_worker {task}                                 → save task_id, tab_id
3. … END YOUR RESPONSE AND YIELD …
4. (notification arrives)
5. read_chat {tab_id}                                  → read the actual answer
6. review_task {tab_id, task_id}                       → unblocks your own completion
7. close_worker {tab_id}                               → frees a worker slot
8. complete_task OR answer the user
```

With private coordination also enabled, add after step 1: `coordination_register_manager {}`, and
between 6 and 7: `coordination_pending {}` → `coordination_ack_batch {batch_id, event_ids}`.

That is the whole loop. Everything else is recovery.
