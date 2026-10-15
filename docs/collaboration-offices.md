# Task offices: HTTP MCP agents and session roles

The collaboration page (`/collaboration`) provides guided setup, independent agents, optional reusable collaboration projects, per-chat seats, text material delivery and an office timeline. Old account-to-account tasks remain in the collapsed legacy section. Operational records do not become memory graph nodes.

## Setup in the UI

1. Log into **user management**. On protected deployments use the operator credential and, if configured, API key. Agent MCP tokens cannot log in here. The browser uses an HttpOnly, SameSite=Strict session; secrets are not saved in localStorage.
2. Save the central Streamable HTTP `/mcp` URL. Other machines cannot reach your `127.0.0.1`; use an appropriate LAN address or HTTPS hostname. Web and MCP processes must use the same database. The displayed instance ID also appears in `work_bootstrap`.
3. Add an agent's display name, account and host. This creates a pending record, not a running agent. Generate its credential, download it once, and move it into the host's secret settings. Downloaded credentials are sensitive files; remove unnecessary copies after setup.
4. Install the generated native HTTP MCP template in the host. Templates contain only secret references. Set the referenced variable through the user's host environment/secret configuration; the template does not create its value. Never paste the token into a chat or ask the model to find it. No stdio proxy is generated.
5. Create an optional collaboration project to reuse allowed agent membership, or create a standalone office. Choose a goal, acceptance criteria, deadline, whole-office iteration budget and seats. A seat is one chat's role; the same registered agent can occupy separate seats in different chats.
6. Click each seat and give its **non-secret startup instruction** to that chat. `work_bootstrap` confirms the authenticated agent; `work_session_open` opens its authorized assignment. The UI separately reports pending configuration, observed MCP initialization and observed bootstrap. An old handshake does not prove the host is still running.

Current authentication is static Bearer. MindPond does **not** implement an OAuth authorization server yet. A template verified against official documentation is not a claim that every client/version has been tested. Configure the host tool timeout above the 55-second maximum wait (templates use 65 seconds).

The browser management server can issue credentials only when `MINDPOND_MCP_ACCOUNTS` points to the same private grant file as the HTTP MCP gateway. Configure the same `MEMORY_DB_PATH`/`--db` for both. Without that setting the UI explains offline provisioning instead of pretending it issued a credential.

For example, an operator can provision a v2 agent offline:

```sh
mindpond-mcp-http grant --config /private/accounts.json \
  --db /private/mindpond.db --principal account-a --agent codex-work \
  --personal account-a --token-file /private/codex-work.token
```

Use `--assignments seat-id` to restrict that credential to specific preauthorized office seats. `--rotate` replaces the old credential; use a new token output path. CLI output contains paths/identity, never the bearer value. Provisioning and file permissions remain operator operations, not MCP tools. The grant file is mode 600 and contains only token digests.

## Identity and isolation

`principal` is the account. `agentId` is the registered host identity. `workSessionId` is a recoverable working context. `assignmentId` is an office seat with a role and binding revision. A transport `Mcp-Session-Id` is neither an authentication credential nor a reliable host chat identifier.

Pass this chat's returned `workSessionId` on office calls and on memory calls made in that working context. Session memory is namespaced by account, agent and work session and survives transport reconnection. It is not shared simply because agents joined the same office. Existing personal/team domain grants remain separate.

The default mode is **explicit context binding**. It prevents normal mixups, but a broad credential can select that agent's other authorized seats. For stronger separation, create separately restricted agent credentials and configure the host so each chat/process sees only its intended connection. Exposing both credentials to both chats does not isolate them. Different seats on one model are not proof of independent review.

Environment-variable references keep token literals out of templates and prompts; they do not protect a token from shell tools that inherit or can read it. A genuine secret boundary requires host credential storage and separate permissions from the model's tool execution environment. The UI does not claim that this boundary was verified automatically.

A seat already in use must be explicitly resumed using its existing workSessionId. Bootstrap lists authorized current candidates but does not guess the most recently active chat. `work_session_open {assignmentId,workSessionId,end:true}` ends a context and fences its active claims; the next chat may open a new one. User changes to seat assignments invalidate previous bindings and leases. Old actors/events are never relabeled.

## MCP-only discovery and workflow

No MindPond local documentation or MCP resources support is required. HTTP MCP initialization includes short instructions; `work_guide_get` returns complete versioned instructions directly in tool responses.

| Tool | Use |
|---|---|
| `work_bootstrap` | Confirm authenticated agent, instance, seats and recoverable context candidates |
| `work_guide_get` | Read identity/workflow/materials/waiting rules on demand |
| `work_session_open` | Open, explicitly resume or end this chat's assignment |
| `work_office_get` | Read paginated office events, item/material summaries; itemId reads full acceptance, roundId/eventSeq read complete JSON via offset chunks |
| `work_office_exchange` | Send inform/request/final reply, read seat inbox, explicitly ack |
| `work_material` | Begin a text manifest, upload chunks, finalize SHA-256, read finalized chunks |
| `work_office_item` | Create/delegate, claim/renew, submit, verify, propose/accept/reject transfer, cancel |
| `work_office_progress` | Report brief public action/reason and file access observations |
| `work_office_wait` | Bounded wait for inbox, exact request reply or matching iteration |

Workspace membership and seat creation are user management actions, unavailable to agent credentials. v2 agents cannot fall back to v1 account-wide task tools to bypass seat restrictions. Existing v1 accounts keep their legacy tools and exact old session namespace after grant-file migration; active transports may require reconnection when their grant representation changes. No historical memory or task is moved automatically.

A request is satisfied only by its designated recipient's final correlated reply. An informational message does not create a response obligation. Read and accepted receipts do not mean completed work. Responsibility transfer changes the owner only when the target accepts the current proposal; until then the original owner remains responsible. Epoch/revision/lease checks fence previous claims after acceptance.

Worker submission requires a live lease, exact code version and finalized material. The designated reviewer reports the exact round/version with actual evidence. `passed` completes, `changes_requested` allows another claim, `blocked` needs prerequisites. The iteration budget is shared by all work items in the office, including delegated children; new items cannot reset it. Deadlines and paused/cancelled/completed offices prevent further work. Cancellation cannot kill a remote host process.

Waits last 25 seconds by default, at most 55 seconds. Timeout is pending, not failure or verification. Continue with returned resume only within the user's task/runtime budget. Cancellation, revoked credentials, disabled agents/projects and stale assignments end/reject waiting. Both hosts must already be running: MindPond cannot launch or wake an exited agent.

## Files, uniforms and observer behavior

Shared-file conditions are explicitly reported by each work session, never inferred from account, IP or path. Uniform colors summarize a declared shared working-copy group; text-only and unknown conditions are distinct. Reports are labeled as self-reports and become unknown after a day in the overview. Compare the actual version/dirty patch before verification; declarations are not filesystem proofs.

When files are not shared, send necessary UTF-8 text through MCP: reproduction, environment, code/patch, commands and output. Begin a manifest with byte count, chunk count and SHA-256; upload numbered chunks and finalize. Draft/incomplete/digest-mismatched materials cannot be read as published. Limits: 16KB per chunk, 512KB per material, 16MB and 500 materials per office. Binary/base64 file transport is not implemented.

The user can inspect published material text in the frontend without acknowledging it for an agent. Every business event has a durable sequence and actor; the office view animates only new observed events, suppresses historical replay, pauses while hidden and respects reduced motion. Event summaries explicitly advertise detailAvailable for large records; read all offset chunks for their complete JSON, never treat a preview as complete. Items and material manifests have separate cursors. The view polls in a bounded shared browser loop; the agent interface remains HTTP MCP. Agent-local edits/tests are visible only when reported, not automatically observed. Private memory content is never broadcast into the office.

## Verification

```sh
npm run build
npm run verify:office
npm run verify:network-mcp
npm run verify:collaboration
npm run verify:collaboration-wait
npm run verify:trusted-context
```

`verify:office` uses a temporary database, real native HTTP MCP clients and an isolated browser management server. It covers distinct agents on one account, role/context selection, scoped credentials, message correlation, text completeness, exact round validation, responsibility transfer, scoped session memory/reconnection, revocation, secret-free projections and provisioning failure recovery. Real host model behavior and per-chat secret isolation require host-specific acceptance; SDK success is not reported as that acceptance.

Official template references checked 2026-10-15: [Codex](https://learn.chatgpt.com/docs/extend/mcp), [OpenCode](https://opencode.ai/docs/mcp-servers/), [Claude Code](https://code.claude.com/docs/en/mcp).
