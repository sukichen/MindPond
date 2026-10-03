# Task-time memory loop for generic agents

MindPond does not run an LLM or observe host work on its own. The host agent decides when a task needs prior context and whether an observation is true. These tools make that decision cheap and leave enough context for a later review.

1. For substantive work involving a user's preferences, past decisions, project history or reusable experience, call `memory_brief` with the real task and the host's current readable scope. It returns at most eight complete results under a 12 KB UTF-8 result budget by default, plus `recallId` and omitted IDs. The agent must check the original conditions, freshness and source before using a result. Use scoped `memory_search` or an explicit node read for follow-up; do not broaden a domain to improve recall.
2. At a real task milestone, call `memory_use_report` once with a stable `reportId`, the returned `recallId`, and only memories the brief actually delivered. Mark `used` only if the memory materially changed an action, conclusion or answer. Mark `rejected` when the agent checked and found it inapplicable; mark `unassessed` if no check was possible. Include a short reason. Do not treat prompt inclusion as use.
3. If the task exposed an incorrect, outdated, incomplete or poorly anchored memory, include `issue` and the original `context`, plus source refs when available. If two returned memories were both used together and a future agent would benefit from their co-recall, include `coUses` with the shared space/type, a concrete reason, and the original context. A shared topic or one coincidental joint read is insufficient.
4. `memory_use_report` records feedback and creates review suggestions atomically. It never changes a body, edge weight or importance. At a later review, call `memory_improvement_list` in the authorized domain, inspect full memories and actual sources, then use the ordinary versioned edit or association tools only when justified. Finish with `memory_improvement_resolve`. If evidence is missing, defer or dismiss with a reason.
5. Before creating a new durable memory, call `memory_save_validate`. Its `possibleExisting` field is a bounded, advisory same-scope candidate list. Reuse or update an existing memory when it expresses the same claim; save separately when it is materially different. Candidate similarity is not a duplicate verdict. `memory_save` still rechecks current state and authorization.

Example task feedback:

```json
{
  "reportId": "host-run-17:milestone-2",
  "recallId": "<returned by memory_brief>",
  "runId": "host-run-17",
  "hostId": "host-1",
  "task": "Review the proxy deployment",
  "outcome": "completed",
  "observations": [
    {"memoryId": "<returned id>", "disposition": "used", "reason": "Explained the local bind", "issue": "incomplete", "context": "Production deployment was outside the recorded development setup"}
  ]
}
```

No feedback call is needed when the brief returns no memories or none was evaluated. A report may contain `unassessed` if the host intentionally accounts for a delivered memory; absence of a report never implies adoption. Do not upload hidden reasoning, credentials, or full transcripts into task/context fields.

Measure the workflow using authorized task traces kept outside the public repository. Compare material use, completed corrections, unsupported co-use suggestions, duplicate saves and source-verified outcomes under comparable budgets. Contract tests do not establish a universal quality gain.
