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

The command verifies that the members are registered accounts. Updates require the current workspace revision; set `enabled:false` to suspend it or remove a member to revoke access. Membership and roles are checked on every operation, including receipt replay. Account token revocation is enforced separately by the network gateway on every request. Collaboration is available in both the work and full MCP catalogs; operator configuration is restricted.

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

Optional host-side polling can call `work_inbox` at task start or on a host-owned schedule. The durable inbox is authoritative and already supports reconnect; automatic model wake-up, push subscriptions, attachment transport and a perpetual agent scheduler are not supplied. No service-side LLM credentials are needed.

## Validation

`npm run verify:collaboration` uses temporary SQLite and real central HTTP MCP clients. It covers account-bound authors, role/recipient guards, rollback of the entire publication, concurrent idempotent saves/claims, lost-response lease replay, full evidence and report history, private-memory isolation, old acknowledgements versus new evidence, submission/reviewer acceptance, late evidence invalidating acceptance, revocation, restart recovery and absence of memory-node pollution. A second suite exercises the operator CLI, signed REST workbench and native host adapter, including task-start inbox hints and rejected identity spoofing. It does not contact a production account or claim that a real LLM supplied a good report.
