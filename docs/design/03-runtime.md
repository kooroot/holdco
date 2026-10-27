# 03 — Runtime: the Supervisor

> The always-on process that starts every agent session, moves every ticket to an end state through crashes, and enforces time and budget. Deterministic code; no LLM inside.
> Implemented in `packages/kernel/src/supervisor/` (D43) with the store in `src/store/`; simulated in `test/supervisor.test.ts` with a scripted engine over real git and real MCP.
> 모든 에이전트 세션을 시작하고, 크래시가 나도 모든 티켓을 끝 상태까지 흘려보내고, 시간과 예산을 집행하는 상시 프로세스입니다. 결정론적 코드이며 내부에 LLM이 없습니다.

---

## English

### 1. Shape

```
systemd / launchd  ──restarts──▶  holdco supervise  ──pings──▶  heartbeat URL (external)
                                        │
        ┌───────────────┬───────────────┼───────────────┬────────────────┐
     Config          Store           Sessions        Executors         Notifier
  (company.yaml)   (SQLite)     (engine adapters)  (merge/deploy/   (TG/Slack/hook)
        │               │               │            publish)
        └── jobs: heartbeat · dispatch · reaper · tripwires · ceo-cycle · challenge-window
                  inbox-batch · digest · release · release-watch · audit-watch · config-watch
```

Each box is an Effect service (a `Context` tag with a live `Layer` and a test `Layer`). The supervisor is one Effect program under one `Scope`: stopping it interrupts every job and session fiber and runs their finalizers.

| Service | Interface (abridged) | Live | Test |
|---|---|---|---|
| `Config` | `current`; reload on change | file watcher + Schema decode | in-memory |
| `Org` | agent definitions and prompts **from the latest release tag** (D23) | `git show <tag>:<path>` | fixture |
| `Store` | tickets, leases, ledger, inbox, labels, demotions, canaries, releases, events | `@effect/sql-sqlite-bun` + `SqliteMigrator` | SQLite `:memory:` |
| `Worktrees` | create / remove per-session worktrees (D22) | `git worktree` via `ChildProcessSpawner` | temp dirs |
| `Sessions` | `run(spec): Effect<Outcome, SessionError, Scope>`; picks the adapter from `roles` | `@holdco/engine-claude`, `@holdco/engine-codex` (`Engine.run`) | scripted fake engine |
| `Tools` | the company MCP endpoint; one token per session (D36) | Bun HTTP server on `127.0.0.1` | in-memory |
| `Executors` | `run(action, ticket)`; secrets injected into the subprocess only | `ChildProcessSpawner`, GitHub API | recorder |
| `Notifier` | `send(severity, text)` | `HttpClient` | collector |
| `Interrupts` | `active`, `changes` | watch `control/interrupts.json` | in-memory |
| `Running` | live sessions: id → ticket, role, abort | `Ref<HashMap>` | same |
| time | `Clock` | system clock | `TestClock` (a simulated week in milliseconds) |

### 2. Boot sequence

1. **Config.** Decode `company.yaml`. Invalid → log, try to alert, exit non-zero (the service manager restarts with backoff; the heartbeat stops, so the external switch fires).
2. **Preflight.** Hook binary; sandbox dependencies (`bwrap` on Linux); model API key; alert channel (cached daily); release tag `r0` or later exists; `provider_cap_set: false` → warning.
3. **Store.** Open `.holdco/state.db` (WAL), migrate.
4. **Recover.** Leases held by a previous boot expire immediately: tickets go back to the queue with `attempts + 1` (or to `blocked` past `max_attempts`, §6). Sessions without an end record are marked `crashed`. Stale worktrees of closed tickets are pruned.
5. **Interrupts.** L5 active → halted mode (heartbeat and inbox only). A pending L4 is executed (§10).
6. **Jobs.** Fork all jobs in the program scope. Notify "supervisor started" with boot id, kernel version, release tag.

On SIGTERM: stop dispatch, interrupt running sessions, release their leases *without* an attempt penalty, flush, exit.

### 3. The session gate

Every job that starts a session (dispatch, ceo-cycle, COO review, digest narrative, improvement) goes through one gate:

1. the role and its department are not under an interrupt;
2. the role's budget share has room for a minimum session (`executive`, `verification`, `improvement` have shares like any department);
3. a slot is free. Slots go first to **Verification**, then **executive**, then producing work, so finished work is judged and approved before new work starts.

### 4. The ticket pipeline (D25)

Every state has exactly one owner, and the supervisor dispatches that owner. No state is a dead end.

| State | Owner | What happens |
|---|---|---|
| `new` | CEO (triage, each cycle) | → `triaged` or `declined`. Without a CEO: a triage item in the Operator's daily inbox |
| `triaged`, `rejected` | producing department senior | session in the ticket worktree `t-<id>` (§8) |
| `in_progress` | that session | `ticket_update` → `ready_for_verification` or `blocked` |
| `ready_for_verification` | Verification | session in a fresh read-only worktree `v-<id>` of the PR head; `verdict_submit` → `verified` or `rejected` (a rejection counts as an attempt) |
| `verified` | kernel | `tierForChange` on the diff. T0/T1 with gates met → executor runs the action → `done`. T2/T3 → `awaiting_approval` (stage `needs_proposal`) |
| `awaiting_approval` / `needs_proposal` | CEO (batched in the next cycle) | proposal per `approvals.md` §2 → `needs_review`. Without a CEO the kernel drafts the proposal from the ticket and PR |
| `awaiting_approval` / `needs_review` | COO | concur → T2: executor runs it, `done` with an open challenge window; T3: inbox with the COO's position attached. Object → inbox with both positions. No answer within `blocked_after` → inbox. Without a COO this stage is skipped and every item goes to the inbox (T2 runs as T3) |
| `awaiting_approval` / `inbox` | Operator | approve → executor → `done`; reject or timeout → `declined` |
| `done`, challenge window open | Operator may roll back | `challenge-window` job finalizes after the window; `holdco rollback` → `rolled_back` (§10) |
| `blocked` | CEO (each cycle) | unblock → `triaged`, re-scope (new ticket), or `declined`. Blocked longer than `blocked_after`, or no CEO → Operator inbox |
| any, flagged `interrupt:L1/L2` | — | skipped by dispatch until resumed; no attempt penalty |

Every transition appends to `ticket_events`. A property test (M2) checks that from every state some sequence of owner actions reaches `done`, `declined` or `rolled_back`.

### 5. Dispatch

```
each tick:
  if L4 or L5 active: return
  for stage in [ready_for_verification, awaiting_approval (CEO/COO stages, batched),
                triaged + rejected]:
    for ticket in stage, ordered by (project class: core > experiment > maintenance > brand,
                                     priority, age):
      skip if flagged by an interrupt
      if not gate.admit(owner role):  continue          (§3)
      cap = min(budget.session_max_usd, owner's remaining share)
      if acquireLease(ticket):                           (§7)
        worktree = Worktrees.create(ticket, role)        (§8)
        fork Sessions.run(spec(ticket, role, worktree, cap)) in scope
```

`verified` tickets need no session: the kernel handles them in the same tick (tier, gates, executor or approval routing).

### 6. Sessions

One ticket per session (D5). Specs are built from the company repo **at the latest release tag** (D23), the ticket's worktree, and `company.yaml`.

Sessions are engine-neutral (D35). The kernel builds one `SessionSpec` and hands it to the adapter named by the role's assignment in `company.yaml` (`roles.<kind>`, D34). The adapter translates it into its engine's options; `07-engines.md` has the full matrix.

**The spec** (`packages/kernel/src/engine/types.ts`):

| Field | Value |
|---|---|
| `cwd` | the session's worktree (§8). Department and Verification sessions: a worktree of the project. CEO and COO: the live company checkout, read-only. Improvement: a worktree `imp-<id>` of the company repo |
| worktree dependencies | before a session starts, the kernel links the main checkout's `node_modules` into the worktree (or runs the lockfile's installer once) so tests and type checks run there; agents never install (`node_modules/` is locked) |
| `role`, `assignment` | the role file from `org/roles/` at the release tag (kind, department, capabilities, prompt) and its (engine, model, effort) |
| `instructions` | company `AGENTS.md` + department charter + role prompt + the project's `AGENTS.md` (or `CLAUDE.md`) read as text. Never loaded as engine config |
| `prompt` | the ticket, its prior returns and the branch state |
| `sandbox` | writable roots (the worktree), `denyWrite` (the company root, except Improvement's own worktree; `.holdco/`; the project's locked paths), `denyRead` (`.holdco/`, `evals/canaries/`, host credentials from `HOST_DENY_READ`, D42), network allowlist per department |
| `guard` | `evaluateInterrupts` + `evaluateGuard` with **both** repositories (D24); identity bound in the closure |
| `hookCommand` | the compiled guard binary, for engines whose hooks run as commands |
| `tools` | the company MCP endpoint for this session, with a session-bound token (D36, §9) |
| `limits` | `maxTurns`, `maxBudgetUsd` (= `cap`), `timeoutMs` (= `session_timeout`) |
| `outputSchema` | `SessionReport` (seniors), `Verdict` (Verification), `Proposal` / `Review` (CEO / COO), generated from Effect Schema (D19) |
| `env` | the Operator's environment with every credential-shaped name removed (`*_KEY`, `*_TOKEN`, `AWS_*`, `GH_*`, …) plus the engine's own credential — a desktop login (keychain, locale) keeps working headless; a repo-scoped token (push, open PR; no merge, no admin). Never production secrets (D14) |
| `price` | the price table entry, for engines that report tokens but not cost |

**What each adapter does with it:**

| Concern | Claude (`@holdco/engine-claude`, Agent SDK 0.3.310) | Codex (`@holdco/engine-codex`, Codex SDK 0.164.0) |
|---|---|---|
| Instructions | `systemPrompt: { preset: "claude_code", append }` | prepended to the first input (no system prompt option) |
| Project config | `settingSources: []` for project sessions; `["project"]` + `projectConfigRoot` = live checkout for company sessions | `CODEX_HOME` = a per-session directory under `.holdco/sessions/`, written by the kernel; nothing from `~/.codex` or the project loads |
| Guard | in-process `hooks.PreToolUse` calling `spec.guard` | the compiled binary registered as a `PreToolUse` command hook in the generated home |
| Locks | `managedSettings` deny rules + `sandbox.filesystem` | `sandbox_mode` from capabilities + a permission profile (`denyWrite` → read, `denyRead` → none) |
| Company tools | `mcpServers.company` (HTTP, bearer token) | `[mcp_servers.company]` with the token in an env var |
| Native subagents | `Agent` / `Task` always disallowed | not exposed |
| Budget | `maxBudgetUsd` inside the engine | kernel meters tokens × price at every usage report and aborts at the cap |
| Structured output | `outputFormat: json_schema` | `outputSchema` on the turn |
| Abort | `abortController` registered in `Running` | `signal` on the turn, registered in `Running` |

**Outcome mapping** (adapters return one `Outcome`; the kernel never sees engine result types):

| Outcome | Ticket | Attempts |
|---|---|---|
| `success`, state moved by tools | confirmed | — |
| `success`, report says partial or stopped | requeue, or `blocked` if the stop needs a decision | +1 |
| `max_turns`, `error`, `timeout` | requeue | +1 |
| `max_budget` | requeue only if the share has room | +1 |
| `aborted` by an interrupt | flagged, no penalty (§10) | — |
| no outcome (process died) | reaper | +1 |
| Verification rejects | `rejected` → back to the department | +1 |

`attempts > runtime.max_attempts` → `blocked` (owner: CEO, else Operator). Every outcome writes its cost to the ledger with its source (`engine` for Claude's own figure, `price_table` for metered Codex usage); both are estimates until reconciled.

**Idempotency.** Each ticket works on branch `t/<id>` in worktree `t-<id>`. A retry reuses both; the prompt tells the senior to inspect the branch and prior returns first.

### 7. Leases and crash recovery

```sql
-- acquire: exactly one row updated means this session owns the ticket
UPDATE tickets
   SET lease_holder = :session, lease_expires = :now + :ttl,
       state = CASE state WHEN 'triaged' THEN 'in_progress' WHEN 'rejected' THEN 'in_progress' ELSE state END
 WHERE id = :id AND state = :expected_state AND interrupt_flag IS NULL
   AND (lease_expires IS NULL OR lease_expires < :now);

-- reap: every tick; crash loops end in 'blocked'
UPDATE tickets
   SET lease_holder = NULL, lease_expires = NULL, attempts = attempts + 1,
       state = CASE WHEN attempts + 1 > :max_attempts THEN 'blocked' ELSE :requeue_state END
 WHERE lease_expires < :now AND lease_holder IS NOT NULL;
```

`ttl = session_timeout + lease_grace`, renewed on every message from the session stream. `requeue_state` is the state the ticket was dispatched from (`triaged` for department work, `ready_for_verification` for a crashed Verification session, and so on).

### 8. Worktrees and repositories

- **Every session has its own working tree (D22).** No two sessions ever share a checkout.

| Session | Worktree | Branch |
|---|---|---|
| Department senior | `<project>/.claude/worktrees/t-<id>` | `t/<id>` |
| Its juniors | `<project>/.claude/worktrees/t-<id>-<brief>` | `t/<id>-<brief>` |
| Verification | `<project>/.claude/worktrees/v-<id>` (read-only use) | detached at the PR head |
| Improvement | `<company>/.claude/worktrees/imp-<id>` | `imp/<id>` |
| CEO, COO | none; live company checkout, read-only | — |

- **Projects stay in their own repositories (D12).** The kernel injects the company layer per session; nothing is copied into a project.
- **Guard with two repositories (D24, implemented).** A path is judged by the repository it resolves into, so a project session cannot write `/…/company/company.yaml` by absolute path. Every project additionally locks `.claude/settings*`, `.claude/hooks/`, `.claude/agents/`, `.claude/skills/`, `.mcp.json` and `.codex/` (kernel-fixed), plus its `projects[].locked` globs.
- **Juniors are kernel sessions (D37).** A senior calls `delegate_start`; the kernel validates the brief, creates the junior's worktree, and runs the junior as its own session with the `junior_worker` or `junior_reader` assignment. Its `cwd` and writable root are that worktree, so the junior rule (D13) holds on every engine without relying on subagent identity in hooks. The guard still checks `agent_id` / `agent_type` when an engine reports them.
- **The live company checkout changes only by release (D23, implemented).** Improvement writes `org/` (departments, roles, skills), `protocols/`, `improvement/` only inside its worktree. The merge is `improvement.merge`, and `tierForChange` makes it T3 when the diff touches a locked or approval-required path (CEO, COO, Verification definitions).

### 9. How agents talk to the kernel

Agents never touch the database or credentials. They call tools on one company MCP endpoint served by the supervisor on `127.0.0.1`. Each session gets its own bearer token, created with the session and bound to its id, role and ticket; the tool list is chosen from that binding, never from anything the agent sends (D7, amended by D36). Every engine that speaks MCP reaches the same tools the same way.

| Tool | Roles | Effect |
|---|---|---|
| `ticket_get`, `ticket_list` | seniors | own department; CEO sees all |
| `ticket_create` | any senior, CEO | a ticket for any enabled department, state `new` (CEO triages; without a CEO, the Operator's inbox). Improvement's tickets for itself are auto-triaged |
| `ticket_update` | owning senior | `in_progress → ready_for_verification` or `blocked`, with a note |
| `ticket_triage` | CEO | `new → triaged` (department, action, priority) or `declined` |
| `ticket_unblock` | CEO | `blocked → triaged` with a note, or `declined` |
| `brief_validate`, `return_validate` | seniors | same code as the CLI |
| `verdict_submit` | Verification | approve / reject / cannot-score |
| `proposal_submit` | CEO | for `needs_proposal` tickets → `needs_review` (or the inbox without a COO) |
| `proposal_review` | COO | concur / object / needs-info |
| `action_request` | seniors | request merge, deploy or publish for a `verified` ticket; the kernel decides (§4). It never executes T2/T3 without the approval path |
| `report_write` | CEO, Operations | digest narrative, incident note, health line → `reports/` |
| `issue_file` | all | a proposal to change a locked file → inbox (never a PR) |

| `delegate_start` | seniors (roles with `delegate`) | validate a brief, create `t-<id>-<brief>`, start a junior session; returns a handle. Counts against `juniors.max_per_task` and the senior's budget share |
| `delegate_wait` | seniors | wait for one or more handles; returns each validated return form (or the failure) |

Juniors get no company tools: their token carries an empty tool list, and the guard also blocks `mcp__company__*` calls carrying an `agent_id`.

### 10. Interrupts and tripwires

**Interrupts** (`control/interrupts.json`, written only through the Operator's `holdco interrupt`):

| Level | Supervisor action (in addition to the hook blocking tool calls) |
|---|---|
| L1 | abort that agent's sessions; flag their tickets `interrupt:L1` (kept: branch, worktree, attempts) |
| L2 | same for the whole department |
| L3 | abort Improvement sessions; disable release and improvement jobs; graduation proposals frozen |
| L4 | **one-shot**: abort all; restore org files from the previous release tag and commit; clear the L4 entry (logged); resume. `init` creates tag `r0`, so there is always a tag to return to |
| L5 | abort all; suspend executors and envelopes; dispatch off; critical alert |

`holdco resume <level> <target>` clears a flag; flagged tickets return to their previous state with no attempt penalty.

**Tripwires** (every one listed in `governance/interrupts.md` §3 has a detector; D27):

| Tripwire | Detector | Raises |
|---|---|---|
| Department spend > `dept_spend_spike_x` × its 7-day hourly average | tripwires job, ledger | L2 on the department |
| Monthly share or an envelope reaches 100% | ledger, `action_request` | L2 on the spending department |
| Same tool error > `loop_threshold` times | per-session counter over the event stream (`SessionEvent`) | L1 on the agent |
| Write attempt to a locked path | the guard returns `Blocked(locked)` (in-process, or logged by the binary hook and seen as a `blocked` event) | L1 on the agent + alert |
| COO approves a canary | `proposal_review` handler | L3 + alert |
| Secret pattern in tool output, a diff, or an outgoing message | scan of command and message events; executors scan diffs and messages before running | L5 |
| Release causes a demotion or tripwire within `release.watch` | release-watch job | L4 |
| Audit missed `freeze_after_missed` times | audit-watch job | L3 (freezes graduation and improvement) |

The binary hook used by unsupervised sessions blocks and logs, but cannot raise interrupts.

### 11. Jobs

| Job | Schedule | Does |
|---|---|---|
| heartbeat | every `runtime.tick` | ping the heartbeat URL |
| dispatch | every tick | §5 |
| reaper | every tick | §7 |
| tripwires | every tick | §10 |
| challenge-window | every tick | finalize T2 actions past `windows.t2_internal` / `t2_external` |
| ceo-cycle | every `executive.ceo_cycle` | one CEO session: triage `new`, write proposals for `needs_proposal`, handle `blocked`, allocate. Skipped without a CEO |
| inbox-batch | daily at `inbox.batch_at` (company time zone) | summarize open routine items; urgent items alerted at once when filed (D52); items past `timeout` reject every tick |
| digest | weekly at `policy.digest` | the kernel renders every deterministic section from the database (goals data, anomalies, sample list, org changes, executive health, pending T3, unresolved assumptions); the CEO adds narrative if present. A failed CEO session never skips the digest (Constitution 6.3) |
| improvement-cycle | weekly, Monday | Improvement session to diagnose and open tickets; dormant until enough labeled replay tickets (D20) |
| candidate | on an Improvement merge (or daily when one is pending) | tag `rc-<n>`; replay gate when judge-side files changed (D54); then `canary_traffic` of production sessions run on it (D53) |
| candidate-watch | every tick while a candidate exists | demotion → withdraw; after `release.watch`, promote to `r<n>` or withdraw on regression |
| release-watch | every tick for `release.watch` after a release | attributable demotion or tripwire → L4 (which also withdraws any candidate) |
| audit-watch | weekly | missed audits → L3 + alert |
| config-watch | on file change | validate, then swap (02) |

### 12. Budget

Before (gate, §3; the cap is reserved from the share), during (Claude: `maxBudgetUsd` in the engine; Codex: the kernel meters tokens × price at every usage report and aborts at the cap), after (outcome cost → ledger, estimate), outside (provider cap; doctor warns while `provider_cap_set: false`). Envelopes are checked by `action_request`. The month boundary follows `company.timezone`. The ledger is reconciled against provider billing (Operations rubric: within 5%).

### 13. Alerts and the dead man's switch

| Severity | Examples | Delivery |
|---|---|---|
| critical | L5, secret detected, tripwire, supervisor crash loop | immediately, every channel |
| warning | share at 80%, ticket blocked, COO timeout, doctor warning | hourly roll-up |
| info | inbox batch, digest, release notes | on schedule |

The supervisor pings `heartbeat_url_env` every tick; an external cron-monitoring service alerts when pings stop. It is the one alert that works when the host, the service manager and the supervisor are all down.

### 14. State schema (SQLite, `.holdco/state.db`)

| Table | Key columns |
|---|---|
| `tickets` | id, project, department, action_type, state, approval_stage, interrupt_flag, priority, goal, why, done_criteria, opened_by, attempts, lease_holder, lease_expires, window_closes_at |
| `ticket_events` | ticket_id, at, actor, from_state, to_state, note (append-only) |
| `sessions` | id, ticket_id, parent_session (juniors), role, engine, model, effort, engine_session_id, worktree, release (the org tag it ran on), started_at, ended_at, status, turns, cost_usd, cost_source, transcript_path |
| `ledger` | at, role, project, session_id, usd, source (`engine` / `price_table` / `reconciliation`) (append-only) |
| `action_log` | at, actor, ticket_id, action_type, effective_tier, forced_by, inputs, outputs, score, approvals, undo |
| `inbox` | id, kind (`t3` / `t2_objection` / `coo_timeout` / `triage` / `blocked` / `graduation` / `issue` / `manual_action` / `candidate_withdrawn`), urgency, payload, status, decided_at, decision, note, batched_at |
| `verdicts`, `labels`, `demotions`, `canaries`, `audits` | as in evals/README.md and approvals.md |
| `releases` | tag, at, watch_until, changes, status (`released` / `candidate` / `promoted` / `withdrawn`), promoted_to |
| `replays` | candidate, ticket_id, operator_verdict, recorded_verdict, candidate_verdict, cost_usd (D54) |

### 15. Failure modes

| Failure | Detected by | Response |
|---|---|---|
| Session dies | no result; lease stops renewing | reaper requeues; past `max_attempts` → `blocked` |
| Session hangs | `session_timeout` | abort, requeue |
| Supervisor crashes | service manager | restart; boot recovery |
| Host down | heartbeat silence | external switch alerts |
| Model API 429 / 5xx | `error` outcome | requeue with `Schedule.exponential` + jitter; repeated → warning |
| Budget exhausted | ledger | role skipped by the gate; warning at 80% |
| COO silent | `blocked_after` | item goes to the inbox |
| CEO session fails | outcome | proposals and triage retry next cycle; digest still rendered by the kernel |
| `company.yaml` broken | config-watch | keep previous config; alert |
| Hook binary missing | settings wrapper | unsupervised tool calls fail closed; doctor fails |
| Sandbox unavailable | `failIfUnavailable` | session refuses to start; critical alert |
| DB locked or corrupt | Store errors | halt dispatch; critical alert; daily backups in `.holdco/backups/` |

---

## 한국어

### 1. 모양

위 다이어그램과 표와 같습니다. 각 상자는 Effect 서비스(`Context` 태그 + 실제·테스트 `Layer`)이고, 전체가 하나의 `Scope` 아래 하나의 Effect 프로그램입니다. 새로 생긴 서비스는 둘입니다. `Org`는 에이전트 정의와 프롬프트를 작업 트리가 아니라 **최신 릴리스 태그에서** 읽고(D23), `Worktrees`는 세션마다 워크트리를 만들고 지웁니다(D22).

### 2. 부팅 절차

1. **설정** 디코딩. 실패하면 기록·경보 시도·비정상 종료(서비스 관리자가 재시작, 하트비트가 끊겨 외부 스위치 발동)
2. **사전 점검**: 훅 바이너리, 샌드박스 의존성, 모델 API 키, 알림 채널, 릴리스 태그 `r0` 이상 존재, 제공사 한도 미설정 경고
3. **저장소** 열기와 마이그레이션
4. **복구**: 이전 부팅의 임대를 즉시 만료시켜 `attempts + 1`로 재대기(`max_attempts` 초과 시 `blocked`), 종료 기록 없는 세션은 `crashed`, 닫힌 티켓의 워크트리 정리
5. **인터럽트**: L5면 정지 모드, 대기 중인 L4는 실행(§10)
6. **작업 시작**과 알림(부팅 ID, 커널 버전, 릴리스 태그)

### 3. 세션 관문

세션을 띄우는 모든 작업(배분, CEO 주기, COO 검토, 다이제스트 서술, 개선)은 하나의 관문을 통과합니다. 역할과 부서에 인터럽트가 없을 것, 그 역할의 예산 몫에 최소 세션만큼 여유가 있을 것(경영진·검증·개선도 다른 부서처럼 몫이 있음), 슬롯이 비어 있을 것. 슬롯은 **검증 → 경영진 → 생산 작업** 순으로 배정해서, 끝난 일이 판정·승인된 뒤에 새 일이 시작되게 합니다.

### 4. 티켓 파이프라인 (D25)

모든 상태에는 주인이 정확히 하나 있고, 슈퍼바이저가 그 주인을 배분합니다. 막다른 상태는 없습니다.

| 상태 | 주인 | 일어나는 일 |
|---|---|---|
| `new` | CEO(매 주기 분류) | `triaged` 또는 `declined`. CEO가 없으면 운영자 일일 인박스의 분류 항목 |
| `triaged`, `rejected` | 생산 부서 시니어 | 티켓 워크트리 `t-<id>`에서 세션 |
| `in_progress` | 그 세션 | `ticket_update`로 `ready_for_verification` 또는 `blocked` |
| `ready_for_verification` | 검증 | PR head의 새 읽기 전용 워크트리 `v-<id>`에서 세션. `verified` 또는 `rejected`(반려도 시도 1회로 셈) |
| `verified` | 커널 | diff에 `tierForChange` 적용. T0/T1이고 게이트 충족이면 실행기가 실행 후 `done`. T2/T3는 `awaiting_approval`(단계 `needs_proposal`) |
| `awaiting_approval` / `needs_proposal` | CEO(다음 주기에 묶어서) | `approvals.md` §2 형식의 제안 → `needs_review`. CEO가 없으면 커널이 티켓과 PR로 초안 작성 |
| `awaiting_approval` / `needs_review` | COO | 동의 시 T2는 실행기가 실행하고 이의제기 창이 열린 채 `done`, T3는 COO 입장을 첨부해 인박스로. 반대 시 양측 입장으로 인박스. `blocked_after` 안에 응답이 없으면 인박스. COO가 없으면 이 단계를 건너뛰고 전부 인박스(T2가 T3로) |
| `awaiting_approval` / `inbox` | 운영자 | 승인 시 실행기 실행 후 `done`, 거절이나 시한 초과 시 `declined` |
| `done`, 이의제기 창 열림 | 운영자가 롤백 가능 | `challenge-window` 작업이 창이 지나면 확정, `holdco rollback`이면 `rolled_back` |
| `blocked` | CEO(매 주기) | 해제해서 `triaged`, 범위 재조정(새 티켓), 또는 `declined`. `blocked_after`보다 오래되거나 CEO가 없으면 운영자 인박스 |
| `interrupt:L1/L2` 표시가 붙은 모든 상태 | — | 해제될 때까지 배분에서 제외, 시도 횟수 증가 없음 |

모든 전이는 `ticket_events`에 기록되며, M2의 속성 기반 테스트가 모든 상태에서 주인들의 행동만으로 `done`·`declined`·`rolled_back` 중 하나에 도달할 수 있는지 확인합니다.

### 5. 배분

L4/L5면 아무것도 하지 않습니다. 매 틱 검증 대기 → 승인 대기(CEO·COO 단계, 묶음) → 작업 대기 순으로, 각 단계 안에서는 (프로젝트 등급, 우선순위, 나이) 순으로 봅니다. 인터럽트 표시가 있으면 건너뛰고, 관문을 통과하면 임대를 잡고, 워크트리를 만들고, 세션을 띄웁니다. `verified` 티켓은 세션이 필요 없어서 커널이 같은 틱에 처리합니다.

### 6. 세션

티켓당 세션 하나이며(D5), 회사 레포의 **최신 릴리스 태그**(D23), 티켓 워크트리, `company.yaml`로 조립합니다. 세션은 엔진 중립입니다(D35). 커널이 `SessionSpec` 하나를 만들고, `company.yaml`의 `roles.<종류>` 배정(D34)이 가리키는 어댑터에 넘기면 어댑터가 자기 엔진 옵션으로 번역합니다. 표는 위와 같고, 핵심은 다음과 같습니다.
- `cwd`는 세션 자신의 워크트리입니다. 부서·검증 세션은 프로젝트 워크트리, CEO·COO는 회사 라이브 체크아웃(읽기 전용), 개선팀은 회사 레포의 워크트리 `imp-<id>`.
- **지시문은 텍스트로만 들어갑니다.** 회사 `AGENTS.md`, 부서 헌장, 역할 프롬프트, 프로젝트의 `AGENTS.md`(또는 `CLAUDE.md`)를 커널이 읽어 붙입니다. Claude는 시스템 프롬프트에 덧붙이고, 시스템 프롬프트 옵션이 없는 Codex는 첫 입력 앞에 붙입니다.
- **프로젝트 설정은 로드하지 않습니다.** Claude는 프로젝트 세션에서 `settingSources: []`(회사 세션은 `["project"]` + 라이브 체크아웃을 `projectConfigRoot`로), Codex는 커널이 `.holdco/sessions/` 아래에 만든 세션 전용 `CODEX_HOME`을 써서 `~/.codex`나 프로젝트의 설정이 아무것도 들어오지 않습니다. 에이전트가 프로젝트에 훅을 심어 다음 세션에서 샌드박스 밖으로 실행시키는 경로가 이걸로 닫힙니다.
- **가드는 두 레포를 모두 압니다(D24).** Claude는 프로세스 내 `PreToolUse` 훅이 `spec.guard`를 부르고, Codex는 같은 판정 코드를 담은 컴파일 바이너리를 생성된 홈에 커맨드 훅으로 등록합니다.
- **예산.** Claude는 엔진 안의 `maxBudgetUsd`, 비용 대신 토큰만 보고하는 Codex는 커널이 사용량 보고마다 토큰 × 가격표로 계산해 상한에서 중단합니다.
- 회사 도구는 두 엔진 모두 같은 MCP 엔드포인트로 받습니다(D36). 엔진 고유 서브에이전트는 끕니다(D37).

결과 매핑은 위 표와 같습니다. 어댑터는 엔진별 결과 타입 대신 `Outcome` 하나를 돌려주고, 인터럽트로 중단된 세션은 시도 횟수 없이 표시만 붙습니다. `max_attempts`를 넘으면 `blocked`(주인은 CEO, 없으면 운영자)가 됩니다. 원장에는 비용과 출처(`engine` 또는 `price_table`)를 함께 기록합니다.

### 7. 임대와 크래시 복구

위 SQL과 같습니다. 회수 SQL이 `max_attempts`를 확인해서 크래시를 반복하는 티켓은 `blocked`로 끝나고, 무한 루프가 생기지 않습니다. 재대기 상태는 티켓이 배분된 원래 상태입니다(부서 작업이면 `triaged`, 죽은 검증 세션이면 `ready_for_verification`).

### 8. 워크트리와 레포

- **모든 세션은 자기 작업 트리를 갖습니다(D22).** 두 세션이 체크아웃을 공유하는 일은 없습니다. 배정은 위 표와 같습니다.
- **프로젝트는 각자의 레포에 둡니다(D12).**
- **두 레포를 아는 가드(D24, 구현 완료).** 경로는 실제로 귀속되는 레포 기준으로 판단하므로, 프로젝트 세션이 절대 경로로 `/…/company/company.yaml`을 쓸 수 없습니다. 모든 프로젝트는 `.claude/settings*`, `.claude/hooks/`, `.claude/agents/`, `.claude/skills/`, `.mcp.json`, `.codex/`가 커널 고정으로 잠기고, `projects[].locked` 글롭이 추가로 잠깁니다.
- **주니어는 커널 세션입니다(D37).** 시니어가 `delegate_start`를 부르면 커널이 지시서를 검증하고 주니어 워크트리를 만든 뒤, `junior_worker` 또는 `junior_reader` 배정으로 별도 세션을 띄웁니다. `cwd`와 쓰기 가능 경로가 그 워크트리이므로, 훅이 서브에이전트 신원을 알려주는지와 무관하게 모든 엔진에서 주니어 규칙(D13)이 지켜집니다. 엔진이 `agent_id`·`agent_type`을 주면 가드가 그것도 확인합니다.
- **회사 라이브 체크아웃은 릴리스로만 바뀝니다(D23, 구현 완료).** 개선팀은 조직 정의 파일을 자기 워크트리 안에서만 쓸 수 있습니다. 머지는 `improvement.merge`이고, diff가 잠긴 경로나 승인 필요 경로(CEO·COO·검증 정의)를 건드리면 `tierForChange`가 T3로 만듭니다.

### 9. 에이전트가 커널과 대화하는 방법

에이전트는 DB나 자격 증명을 절대 만지지 않습니다. 슈퍼바이저가 `127.0.0.1`에 띄운 회사 MCP 엔드포인트 하나로 도구를 부르고, 세션마다 세션 ID·역할·티켓에 묶인 전용 토큰을 받습니다. 도구 목록은 이 토큰의 바인딩으로 정하며 에이전트가 보내는 값은 보지 않습니다(D7, D36에서 수정). MCP를 쓰는 엔진은 모두 같은 도구를 같은 방식으로 씁니다. 시니어는 `delegate_start`·`delegate_wait`로 주니어를 띄우고 반환서를 받으며, 주니어 토큰에는 도구가 하나도 없습니다.

도구 목록은 위 표와 같습니다. 리뷰 이후 바뀐 점: `ticket_create`는 부서 헌장대로 모든 시니어가 쓸 수 있고(`new` 상태로 생성, CEO가 분류, CEO가 없으면 운영자 인박스), 개선팀이 자기에게 여는 티켓은 자동 분류됩니다. `ticket_unblock`(CEO)이 추가됐습니다. `proposal_submit`은 `needs_proposal` 티켓에 대해서만 쓰고, `action_request`는 T2/T3를 승인 경로 없이 절대 실행하지 않습니다.

### 10. 인터럽트와 트립와이어

**인터럽트**: L1·L2는 세션을 중단하고 티켓에 `interrupt:L1/L2` 표시를 붙입니다(브랜치, 워크트리, 시도 횟수는 유지). 그래서 다음 틱에 같은 티켓이 다시 배분되어 막히기를 반복하지 않습니다. L3는 개선 세션 중단, 릴리스·개선 작업 정지, 승격 제안 동결. **L4는 일회성**입니다. 전부 중단하고 직전 릴리스 태그로 조직 파일을 복원·커밋한 뒤 L4 항목을 스스로 지우고(기록) 재개합니다. `init`이 `r0` 태그를 만들어 두므로 돌아갈 태그는 항상 있습니다. L5는 전부 중단, 실행기·위임 범위 정지, 배분 끄기, 치명 경보.

**트립와이어**: `governance/interrupts.md` §3의 모든 항목에 감지기가 있습니다(D27). 위 표와 같습니다. 부서 지출 급증(L2), 월 몫이나 위임 범위 100%(L2), 같은 툴 오류 반복(L1), 잠긴 경로 쓰기 시도(L1 + 경보), COO의 카나리 승인(L3 + 경보), 툴 출력·diff·외부 메시지의 시크릿 패턴(L5), 릴리스 감시 기간 내 강등이나 트립와이어(L4), 감사 누락(L3). 슈퍼바이저 밖 세션의 바이너리 훅은 막고 기록할 뿐 인터럽트를 걸 수는 없습니다.

### 11. 작업

위 표와 같습니다. 추가된 작업은 `challenge-window`(T2 이의제기 창 확정), `improvement-cycle`(주간 진단, 라벨이 충분할 때까지 휴면), `release-watch`(릴리스 후 감시 기간 동안 L4 트리거)입니다. **다이제스트는 커널이 DB에서 결정론적 섹션을 전부 직접 렌더링**하고, CEO가 있으면 서술만 더합니다. CEO 세션이 실패해도 다이제스트는 빠지지 않습니다(헌법 6.3).

### 12. 예산

세션 전(관문), 세션 중(`maxBudgetUsd`), 세션 후(원장, 추정치), 우리 코드 밖(제공사 한도)의 네 겹입니다. 위임 범위는 `action_request`가 확인하고, 월 경계는 회사 시간대를 따르며, 원장은 제공사 청구와 대조합니다.

### 13. 알림과 데드맨 스위치

위 표와 같습니다. COO 무응답이 경고 항목에 추가됐습니다. 외부 하트비트는 호스트·서비스 관리자·슈퍼바이저가 전부 죽어도 동작하는 유일한 경보입니다.

### 14. 상태 스키마

위 표와 같습니다. `tickets`에 `approval_stage`, `interrupt_flag`, `window_closes_at`이, `action_log`에 `forced_by`(T3로 강제한 경로)가, 인박스 종류에 `coo_timeout`·`triage`·`blocked`가, 그리고 `releases` 테이블이 추가됐습니다.

### 15. 장애 모드

위 표와 같습니다. 추가된 항목: COO 무응답은 인박스로, CEO 세션 실패는 다음 주기 재시도와 커널 다이제스트로, 크래시 반복은 `max_attempts` 이후 `blocked`로 끝납니다.
