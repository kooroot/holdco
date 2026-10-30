# Product feedback and decision memory

Holdco can accept product observations from an Operator-controlled collector and reuse
explicit Operator decisions. Evidence creates work; it never grants permissions.
Existing companies gain the two SQLite tables when they next open their state store.
No company template regeneration or policy change is required.

Holdco is a standalone agent-company runtime. Its kernel owns work intake, scoped
decision memory, policy enforcement, execution verification and cost accounting.
Project-specific data sources, thresholds and business logic belong in optional
external adapters; no particular business or product is required to run Holdco.

## 1. Connect a product observation

A collector writes a JSON file and invokes `holdco observe <file> --dir <company>`.
This is a local, trusted ingestion boundary, not a public webhook. The producer needs
access to the company state; do not give that access to agents or external callers.
Strip secrets and personal data before ingestion. No new credentials are configured
or external services contacted by Holdco itself.

Example producer (replace project with the registered project's id):

```ts
const observation = {
  id: "probe-20261030-1200", // stable event id; retry with exactly the same payload
  project: "app",
  source: "service-monitor",
  fingerprint: "api-latency", // same incident while its ticket remains open
  observed_at: Date.now(),
  summary: "API latency exceeds its service objective",
  evidence: ["service health probe: p95 response time is 1200ms"],
  done_criteria: ["p95 response time is below 500ms on three consecutive probe runs"],
  department: "engineering",
  metric: { name: "p95-latency", value: 1200, target: 500, unit: "milliseconds" },
}
await Bun.write("/tmp/service-observation.json", JSON.stringify(observation))
```

```sh
holdco observe /tmp/service-observation.json --dir /path/to/company
```

Only emit an observation when a problem is observed. The metric is evidence, not an
implicit threshold detector. Inputs must be at most seven days old (one minute future
clock skew allowed), reference an enabled producing department and registered project,
and contain evidence and acceptance criteria. Extra fields such as action or command
are rejected. Limits on text and arrays keep context bounded.

The event key is `(project, source, id)`. Replaying it returns the original ticket;
changing its content is an error. Further events with the same
`(project, source, fingerprint)` reuse an open ticket. A recurrence after a terminal
ticket creates a new investigation. The insert and ticket creation are one transaction.
The new ticket has **no action** and starts at `new`, so normal triage, independent
verification and authorization still apply. Latest observations are supplied to the
ticket's sessions as untrusted data. Metric acceptance criteria must be independently
checked; observations cannot mark a ticket complete.

## 2. Record a decision once

`holdco decision add decision.json` requires an interactive Operator terminal.
There is no agent-facing write tool. The store lives under the existing protected
`.holdco` boundary. Example input:

```ts
const decision = {
  id: "reliability-first-v1",
  project: "app", // null for a company-wide decision
  scope: "Current service-reliability milestone",
  decision: "Prioritize the service latency objective before new features",
  rationale: "Slow responses prevent users from completing existing workflows",
  evidence: ["Operator planning decision, 2026-10-30"],
  expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
}
await Bun.write("/tmp/decision.json", JSON.stringify(decision))
```

```sh
holdco decision add /tmp/decision.json --dir /path/to/company
holdco decision list --project app --dir /path/to/company
holdco decision revoke reliability-first-v1 --dir /path/to/company
```

Records are immutable; revoke and add a new id to revise one. Expired and revoked
records are excluded. Executives see recent active decisions across projects; workers
and reviewers see company-wide records and the current ticket's project only. Up to
30 recent matching records are considered, with a bounded context budget; omitted
records are explicitly counted. This is scoped retrieval, not a semantic search index.
The agent must cite a decision's id and evidence, respect its scope, and escalate
conflicts or new judgments. These records never override policy or approve an action.

## 3. Check the actual result of an external action

An executor can declare a read-only `postcheck` with the same argv placeholders,
working directory, environment allowlist and per-command timeout as its command.
The probe must exit zero only when the intended state is observed. A bounded polling
probe can implement a settling window or several consecutive healthy observations.

```yaml
executors:
  deploy.staging:
    command: ["./scripts/deploy.sh", "staging", "{branch}"]
    cwd: project
    env: [DEPLOY_TOKEN]
    undo: ["./scripts/deploy.sh", "staging", "{previous}"]
    postcheck: ["./scripts/check-service-health.sh", "staging"]
    timeout: 2m
```

Define these project scripts before configuring them. `postcheck` is optional for
backward compatibility; without it, a successful external command still means done.
A zero-exit command followed by a failed probe is **applied but not verified**:
its output and undo stay in the action log, its ticket becomes `blocked`, and an urgent
`recovery` inbox item alerts the Operator. The CEO cannot unblock it automatically.
Inspect the recorded probe output and use the existing Operator rollback command
when appropriate. An Operator can explicitly unblock after investigating the state;
that may run the action again, so do not unblock an irreversible action blindly.
Acknowledging the recovery inbox item alone does not retry or complete the ticket.
No automatic rollback is attempted because its safety depends on the action.

This is a postcondition check, not continuous production monitoring. Keep the collector
running independently to detect subsequent regressions. `postcheck` cannot use
`{previous}` from the command's output: probe arguments are validated before the action.

## 4. Recovery evidence and useful work

`rollback-tested` is no longer implicitly satisfied by an `undo` declaration.
Verification must exercise recovery in an isolated test environment and provide
nonempty evidence. If a required gate cannot be run, report `cannot-score`; never pass
an unexecuted check. Doctor only checks prerequisites, not actual recovery success.

The CEO no longer has a quota of 2–3 tickets per department. Its cycle asks for a
concrete strategy objective or observed evidence, an expected user/business outcome,
and measurable completion criteria. With no justified work it should wait. This is a
planning instruction, not a deterministic proof of business value; Operator audits
remain necessary. Period spend per completed ticket now includes failed work and
executive/review overhead, rather than only successful-ticket sessions.

## 한국어 운영 요약

- 수집기에서 실제 이상이 발견될 때 JSON을 만들고 `holdco observe`로 입력합니다.
  동일 이벤트는 멱등 처리하고 진행 중인 같은 장애는 한 티켓으로 모읍니다.
- `holdco decision add`로 적용 범위·근거·만료가 있는 운영자 결정을 저장합니다.
  변경할 때는 기존 결정을 철회하고 새 ID로 등록합니다. 권한 승인을 대신하지 않습니다.
- 배포 실행기에 `postcheck`를 추가하면 명령 성공 이후 실제 상태도 확인합니다.
  실패하면 로그·복구 정보를 남기고 차단하며, 자동으로 재배포하지 않습니다.
- `rollback-tested`에는 실제 복구 시험 증거가 필요합니다.
- 일감 수를 채우기 위한 지시를 제거하고, 실패·관리 비용까지 포함한 완료당 비용을 봅니다.

The examples use a fictional project named `app`. No external integration, scheduler
or production credentials are configured by this feature. Each company may choose
its own observation producers and postcondition probes without changing the kernel.
