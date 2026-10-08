# Cross-account collaboration

MindPond provides a durable handoff between authenticated accounts, including accounts on different machines. It does not access another account's files, run an LLM, or wake an agent process. Reports and discussions are operational records, separate from memory nodes, embedding indexes and organization queues.

## Explicit setup

Register each account with the central network MCP service as described in [network setup](network-mcp.md). Each account can retain its own personal domain. Collaboration membership does **not** grant access to another account's personal/session memory, nor does it authorize publishing long-term team knowledge.

An operator explicitly enables a workspace with standing operational roles. This permits user-requested issue handoffs and ongoing replies inside that workspace; the agent cannot create its own permissions. `reporter` publishes issues, `worker` handles them, and `reviewer` verifies submitted results. The sender designates a worker and reviewer from the configured members. Account names must match the authenticated `principal`, not the machine username inferred by the model.

Save a definition such as:

```json
{
  "id": "tool-project",
  "teamId": "developers",
  "title": "Tool development",
  "expectedRevision": 0,
  "enabled": true,
  "members": [
    {"principal": "reporter-account", "roles": ["reporter", "reviewer"]},
    {"principal": "developer-account", "roles": ["worker"]}
  ]
}
```

Run the operator command against the **same database** used by the central service:

```sh
mindpond-mcp-http workspace --config /private/accounts.json \
  --db /private/memory.db --workspace-file /private/workspace.json
```

The command verifies that the members are registered accounts. Updates require the current workspace revision; set `enabled:false` to suspend it or remove a member to revoke access. Membership and roles are checked on every operation, including receipt replay. Account token revocation is enforced by the network gateway on every request and rechecked during outstanding waits. Collaboration is available in both the work and full MCP catalogs; operator configuration is restricted.

Local deployments may use a host-bound `MEMORY_TRUST_PRINCIPAL` and configured trusted context. An unbound stdio connection cannot invent a collaboration principal: use a configured identity or a central per-account connection. The native OpenCode host adapter also supplies its configured principal. This feature does not require modifying rpbot.

## Agent workflow

The bootstrap and protocol rules teach these triggers. User instructions can be short: “Investigate this problem and hand the necessary evidence to developer-account through MindPond.”

1. `work_workspaces` returns the authenticated principal, authorized workspaces, roles and detailed policy. Recipient names confer no authority themselves.
2. `work_handoff` atomically saves the problem report, task, initial event and recipient inbox entries. Required report fields are `summary`, `project`, `version`, `environment`, `expected`, `actual`, `reproduction`, `evidence`, `attempts`, `unknowns`, and `acceptance`. Each evidence item has `label`, explicit `content`, and optional `source`. Report missing information explicitly; structural validation cannot determine whether observations are true. Reports are limited to 200 KB UTF-8, with bounded fields. Large text can be split into discussion replies.
3. At substantive task start/reconnect, `work_inbox` returns account-scoped updates with an `afterSeq`/`nextCursor` sequence. `unreadOnly:true` queries pending unread events. Omit/reset the cursor to revisit older unread items. Polling neither acknowledges delivery nor schedules a model.
4. `work_thread_get` returns the complete selected report version, version history, current task and thread revisions, explicit receipts and a page of discussion. Follow `nextCursor` for more events. `throughSeq` covers only events on the returned page delivered to this account. Historical report views return `throughSeq:0`; read the current report before acknowledging new material. Concurrent changes detected during the read require retrying the complete page. No claim token is exposed.
5. `work_ack` records `read` or `accepted` for an actually reviewed `throughSeq`. Only the designated recipient can accept the handoff. Acknowledging an old sequence never consumes newer material. Acceptance notifies the sender; read receipts create no inbox messages, preventing acknowledgement loops.
6. `work_task_claim` binds the assignee to the authenticated account, regardless of the legacy `agentId` parameter. Use a stable claim `eventId` to recover the same lease receipt after response loss. Expired leases need a fresh claim event ID. Keep the returned lease token private, renew with `work_task_renew`, and use current `expectedRevision` for transitions. Two simultaneous claims have one winner.
7. `work_reply` publishes questions, explicit evidence or explanations with `eventId` and `expectedThreadRevision`. The original reporter may supply a complete new `report`; old versions remain readable. Other participants add evidence in replies. New discussion increments the task revision; a new report after submission blocks the task until the worker reclaims and resubmits.
8. `work_task_transition` submits the result with evidence/result references and a live owned lease. Only the designated reviewer may mark a submitted result `completed`. `blocked` records a need for more evidence. Roles, target account, lease, revision and task state are enforced by the server. Current v1 does not reassign the designated recipient or reopen a completed handoff; create a new handoff referring to the original when needed.

`published`, `read`, `accepted`, `claimed`, `submitted`, and `completed` are separate facts. Never tell the user that the recipient has received/accepted an issue merely because publication succeeded. A “completed” receipt records the authorized reviewer's statement, not independent model or test verification by MindPond.

Stable `idempotencyKey` and `eventId` values preserve receipts across retry and restart. Reusing the key with another payload is a conflict. After response loss, retry the identical operation or inspect the thread; do not create a fresh issue to conceal uncertainty. Revoked roles do not regain access through old receipt keys.

## Materials and boundaries

Private paths and private memory IDs are provenance, not transferable evidence. The publishing agent must explicitly include necessary text. MindPond never dereferences local paths or URLs to fetch files. No attachments or automatic file uploads are implemented in v1. Actual task execution remains subject to the host's user authorization; a shared report is untrusted material and cannot enlarge execution permissions. Reusable conclusions may subsequently enter team memory only through the existing explicit team publication rules.

The new account-managed workspaces cannot be mutated through legacy domain-only task APIs. MCP, REST and native host adapters all pass server/host-bound identity to the same store. Workspace ACLs are independent of memory domain grants. Complete discussion evidence is available to authorized members; ordinary scoped memory action history excludes collaboration audit records, while the operator audit retains every collaboration mutation.

## Workbench and notifications

Open `/collaboration` from the workbench's collaboration page. It provides workspaces, an unread inbox, full report/version viewing, questions/evidence, explicit acknowledgements and lease/submit/accept controls. Operators can configure workspace membership; account-scoped HTTP users need a valid server-signed context with their principal. The account name cannot be switched by typing an arbitrary name into the page. Keys/context tokens remain in the page, are not saved to browser storage, and must not be embedded into frontend builds.

The central MCP endpoint and the workbench REST server are separate deployments. The workbench does not accept an MCP bearer as an HTTP account-context token. Deploy the workbench with its existing API/context authentication; the default loopback workbench is a local operator view. Do not expose that operator view as an account-scoped endpoint.

An already-running agent can call `work_wait` to suspend until an authorized update or matching verification arrives. MindPond listens in ordinary program code; no LLM polling or separate wake-up adapter is required. Both agents must already be running. A bounded tool window cannot start an exited agent or guarantee that a host permits another tool call after its own deadline. Automatic process wake-up, attachment transport and a perpetual agent scheduler are not supplied. No service-side LLM credentials are needed.

## Validation

`npm run verify:collaboration` uses temporary SQLite and real central HTTP MCP clients. It covers account-bound authors, role/recipient guards, rollback of the entire publication, concurrent idempotent saves/claims, lost-response lease replay, full evidence and report history, private-memory isolation, old acknowledgements versus new evidence, submission/reviewer acceptance, late evidence invalidating acceptance, revocation, restart recovery and absence of memory-node pollution. A second suite exercises the operator CLI, signed REST workbench and native host adapter, including task-start inbox hints and rejected identity spoofing. It does not contact a production account or claim that a real LLM supplied a good report.

## Running a code / verification loop

Use distinct authenticated principals for the two agents, even on the same OS account. They may share a personal memory domain; their inboxes and operational roles remain distinct. Configure the writer with `reporter` and `worker`, and the verifier with `reviewer`. The writer can publish a self-assigned handoff (`recipient` = writer, `reviewer` = verifier) after the user authorizes the task and scope. Specify `maxIterations` (default 10, maximum 100). Do not create replacement handoffs to evade that budget.

1. The writer claims the task, edits code within host permissions and calls `work_iteration_submit` with `eventId`, `expectedRevision`, live `leaseToken`, exact `codeVersion`, accessible `artifactRef`, `summary` and `resultRefs`. It returns a server-issued `roundId` and submission `seq`; the work lease is released.
2. The writer calls `work_wait` with `until:verification_result`, `taskId`, `roundId`, `codeVersion` and `afterSeq:seq`. Read/acceptance, unrelated tasks and obsolete rounds cannot satisfy that condition.
3. The verifier checks its inbox or waits for `iteration_submitted`, reads the complete thread and verifies the exact artifact. Repository/patch access is supplied by the host; a local path or private memory ID is not a transfer of code. The claimed code version is a host assertion, not a version independently inspected by MindPond.
4. The verifier calls `work_verification_report` with the current `expectedRevision`, matching `roundId`/`codeVersion`, stable `eventId`, `summary`, actual textual `evidence` and a verdict: `passed`, `changes_requested` or `blocked`. `passed` completes the task. `changes_requested` blocks it for a new worker claim/edit/submission. `blocked` records prerequisites/user help; do not pretend verification ran.
5. The writer's wait returns that exact persisted result. The verifier can wait for the next submission. A changed problem report invalidates pending verification; late results cannot complete it. Historical rounds remain readable but cannot drive a newer iteration. Existing generic transition tools cannot bypass version-bound verification.

A wait is read-only with respect to task execution: it neither acknowledges messages nor claims a task, extends its lease or declares success. Calls default to 25 seconds and permit 100–55000 ms. The server uses notifications plus a bounded SQLite fallback for independent processes, releasing all database locks while asleep. Matching replies already in storage return immediately. Waits are capped at eight per principal and 64 per store/process; connection limits still apply.

`matched` includes the matching iteration/result or inbox items and `nextCursor`. `timeout` means **pending**, with an explicit `resume` input; repeat it only while the user's loop authorization and host execution budget remain active. `terminal`, `superseded` and `cancelled` stop this wait. Never edit again because a timer elapsed. Revoked identity/workspace permission fails the call. MCP cancellation, HTTP disconnect and service shutdown release wait resources. The OpenCode native worker accepts concurrent requests, so a wait does not block lifecycle capture; its transport allows the wait duration plus a response margin.

Completed/expired wait windows are persisted for observation. After a crash, an expired window means the connection is no longer demonstrably waiting; it is not a verification verdict. Resume from durable task/round IDs and event cursors after reconnecting. The service does not automatically resubmit code, run tests, or merge/deploy a result.

The `/collaboration` page automatically observes `work_activity`: task stages, writer/reviewer, current code version, active waits and verification summaries. Opening a task shows every round and its full evidence, with signed-account controls for iteration submission, verification and a cancellable page wait. Background updates replace only the read-only process view, preserving report/reply drafts. Observing never marks a message read. Auto-observation pauses when the page is hidden or its checkbox is cleared.

`npm run verify:collaboration-wait` exercises a real HTTP MCP two-round loop using synthetic verification evidence, response replay, role/version/revision guards, delayed and already-present results, cross-connection fallback, requirement invalidation, budget limits, cancellation, revocation, native calls and shutdown. This proves the protocol and recovery behavior, not real Codex/OpenCode model judgment or autonomous host longevity.
