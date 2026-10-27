# Ticket Lifecycle

> ✏️ Improvement may propose changes. / ✏️ 개선팀이 변경을 제안할 수 있습니다.

---

## English

All work is a ticket. Tickets live in the kernel's database and are reached only through company tools (`ticket_get`, `ticket_list`, `ticket_create`, `ticket_update`, ...) and the Operator's `holdco ticket` commands. There is no external tracker, no GitHub Issues, and no labels.

### States

```
 new ──► triaged ──► in_progress ──► ready_for_verification ──► verified ──► awaiting_approval ──► done
  │         ▲            │  ▲                 │                   │   (T2/T3)       │
  │         │            │  └──── rejected ◄──┤ (reject)          │                 ▼
  │         │            ▼                    │                   └─(T0/T1)──► done  rolled_back
  │         └──────── blocked ◄───────────────┘ (cannot-score, max attempts)
  ▼                      │
declined ◄───────────────┘ (CEO or Operator declines)
```

| State | Owner | Exit |
|---|---|---|
| `new` | CEO (`ticket_triage`); the Operator's inbox when there is no CEO | `triaged` or `declined` |
| `triaged` | Kernel dispatch | Leased by a department senior session → `in_progress` |
| `in_progress` | Owning senior (one session) | `ticket_update` → `ready_for_verification` or `blocked`; a crash or timeout counts as an attempt and re-queues |
| `ready_for_verification` | Verification session | `verdict_submit` → `verified` (approve), `rejected` (reject), `blocked` (cannot-score, Operator inbox) |
| `rejected` | Kernel | Counts as an attempt; re-queued to the owning senior → `in_progress` |
| `verified` | Kernel | Tier computed with `tierForChange` on the diff and gates checked: T0/T1 → executor → `done`; T2/T3 → `awaiting_approval` |
| `awaiting_approval` | CEO → COO → Operator (sub-stages below) | Approved → executor → `done`; rejected, objected without Operator approval, or expired → `declined` |
| `blocked` | CEO (`ticket_unblock` each cycle); the Operator (`holdco ticket unblock`) after `policy.executive.blocked_after` or without a CEO | `triaged` or `declined` |
| `done` | — | T2: finalizes after the challenge window; `holdco rollback` → `rolled_back` |
| `rolled_back` | Operator or tripwire | A follow-up ticket is opened |
| `declined` | CEO or Operator | Reason recorded in the note |

### Ticket fields

```yaml
id: ENG-142                 # kernel-assigned (<DEPT>-<n>); never chosen by an agent
project: app                # a company.yaml:projects[].id, or none for company-internal work
department: engineering     # an enabled department (company.yaml:modules.departments), improvement, or verification
opened_by: ceo | <role> | operator | kernel
action: code.merge.app      # the registry action (company.yaml:actions) that COMPLETES the ticket, not code.branch
title: one line
goal: what done looks like
why: a strategy line or the parent ticket
done_criteria: [checkable items]
priority: 1..5              # 1 is highest; default 3
state, approval_stage, attempts, branch, note, interrupt_flag   # maintained by the kernel
```

`action` must exist in `company.yaml:actions` by the time the senior calls `ticket_update` → `ready_for_verification`; the registry is `company.yaml`, not the YAML in `governance/policy.md`. An action under a reserved prefix (`legal.`, `credentials.`, `governance.`, `operator.`, `prod.irreversible.`) can only be performed by the Operator.

### Approval sub-stages (`awaiting_approval`)

| Stage | Who | Tool | Next |
|---|---|---|---|
| `needs_proposal` | CEO (without a CEO the kernel drafts the proposal) | `proposal_submit` | `needs_review` with a COO, else `inbox` |
| `needs_review` | COO (skipped without a COO; T2 then runs as T3) | `proposal_review` | `concur` on T2 → executes; T3, `object`, `needs_info` → `inbox` |
| `inbox` | Operator | `holdco inbox approve|reject <id>` | approve → executor → `done`; reject or `policy.inbox.timeout` elapsed → `declined` |

### Attempts and interrupts

- Every crash, timeout and Verification rejection increments `attempts`. Above `company.yaml:runtime.max_attempts` the ticket becomes `blocked` with the reason in the note.
- An L1 (agent) or L2 (department) interrupt sets `interrupt_flag` on the ticket and aborts its session without counting an attempt; `holdco resume <L> <target>` clears the flag and the ticket is re-queued where it was.
- A session that finds its branch already holding work (a retry) must inspect `git log`, `git status` and the ticket's events before continuing.

### Dispatch

The kernel starts sessions in this order: Verification tickets (`ready_for_verification`) → executive (CEO cycle, COO reviews) → production (`triaged`). Within production: project class (core → experiment → maintenance → brand) → `priority` → age. Priority and project are the CEO's allocation levers.

### Deliverable convention

- The deliverable of every ticket is the branch `t/<id>` in the project (`imp/<id>` in the company repository for Improvement). The senior's session works in the worktree `<project>/.claude/worktrees/t-<id>`.
- Non-code deliverables (research reports, GTM drafts, operations runbooks, build artifacts) are files under `docs/holdco/<department>/<ticket>.md` on that branch; the path goes in the `ticket_update` note as `deliverable: <path>` — the kernel passes it to the action's executor as `{deliverable}` (`company.yaml:executors`).
- Merge actions (`code.merge.*`, `improvement.merge`) are executed by the kernel's merge executor into the default branch with a recorded undo. `code.branch` leaves the branch. Deploy, publish, contact and outreach actions have no executor in v1: they become a `manual_action` inbox item the Operator performs by hand and approves.

### Transitions and who calls them

| Transition | Caller | Tool / command |
|---|---|---|
| (none) → `new` | senior, improvement | `ticket_create` |
| (none) → `triaged` | CEO, improvement (own department), Operator | `ticket_create`, `holdco ticket new` |
| `new` → `triaged` / `declined` | CEO; Operator | `ticket_triage`; `holdco ticket unblock` / `holdco ticket decline` |
| `triaged` → `in_progress` | kernel | session lease |
| `in_progress` → `ready_for_verification` / `blocked` | owning senior | `ticket_update` |
| `ready_for_verification` → `verified` / `rejected` / `blocked` | Verification | `verdict_submit` |
| `verified` → `done` (T0/T1) or `awaiting_approval` (T2/T3) | kernel | `tierForChange` + gate check; `action_request` names the action beforehand |
| `needs_proposal` → `needs_review` / `inbox` | CEO | `proposal_submit` |
| `needs_review` → execute / `inbox` | COO | `proposal_review` |
| `inbox` → `done` / `declined` | Operator | `holdco inbox approve|reject <id>`; timeout → reject |
| `blocked` → `triaged` / `declined` | CEO; Operator | `ticket_unblock`; `holdco ticket unblock|decline` |
| `done` → `rolled_back` | Operator; tripwire | `holdco rollback <action-log-id>` |
| any → flagged / unflagged | Operator | `holdco interrupt <L> <target> --reason`, `holdco resume <L> <target>` |

---

## 한국어

모든 일은 티켓입니다. 티켓은 커널 데이터베이스에 있으며 회사 툴(`ticket_get`, `ticket_list`, `ticket_create`, `ticket_update` 등)과 운영자의 `holdco ticket` 명령으로만 접근합니다. 외부 트래커, GitHub Issues, 라벨은 없습니다.

### 상태

위 다이어그램과 표가 정의합니다. 요약:
- `new` → CEO가 `ticket_triage`로 `triaged`(CEO가 없으면 운영자 인박스) → 커널이 시니어 세션에 임대해 `in_progress` → 시니어가 `ticket_update`로 `ready_for_verification` 또는 `blocked`
- 검증 부서가 `verdict_submit`: approve → `verified`, reject → `rejected`(시도 횟수 1회 소모, 시니어에게 재배정), cannot-score → `blocked`(운영자 인박스)
- `verified`에서 커널이 diff로 등급을 계산(`tierForChange`, 잠긴·승인 필요 경로가 섞이면 T3)하고 게이트를 확인: T0/T1은 실행기가 처리해 `done`, T2/T3는 `awaiting_approval`
- `blocked`는 매 주기 CEO의 큐(`ticket_unblock`). `policy.executive.blocked_after`를 넘기거나 CEO가 없으면 운영자 인박스

### 티켓 필드

위 YAML과 같습니다. `id`는 커널이 부여(`<부서>-<n>`), `project`는 `company.yaml:projects[].id`, `department`는 `company.yaml:modules.departments`에 켜진 부서, `action`은 티켓을 **완료하는** 레지스트리 행동(`company.yaml:actions`, 예: `code.branch`가 아니라 `code.merge.app`). 예약 접두사(`legal.`, `credentials.`, `governance.`, `operator.`, `prod.irreversible.`)의 행동은 운영자만 수행합니다.

### 결재 하위 단계

`needs_proposal`(CEO `proposal_submit`, CEO가 없으면 커널이 초안) → `needs_review`(COO `proposal_review`, COO가 없으면 건너뛰고 T2는 T3로 처리) → `inbox`(운영자 `holdco inbox approve|reject <id>`, `policy.inbox.timeout` 경과 시 거절). T2에 COO 동의가 있으면 바로 실행, T3·반대·`needs_info`는 인박스로.

### 시도 횟수와 인터럽트

- 크래시, 타임아웃, 검증 반려는 모두 `attempts`를 올립니다. `runtime.max_attempts`를 넘으면 `blocked`.
- L1/L2 인터럽트는 티켓에 `interrupt_flag`만 세우고 세션을 중단하며 시도 횟수를 소모하지 않습니다. `holdco resume`이 플래그를 지우면 재배정됩니다.
- 재시도 세션은 브랜치에 이미 작업이 있으므로 `git log`, `git status`, 티켓 이벤트부터 봅니다.

### 디스패치 순서

검증 → 경영진 → 생산. 생산 안에서는 프로젝트 등급 → `priority` → 오래된 순. 우선순위와 프로젝트가 CEO의 배분 수단입니다.

### 산출물 규약

- 모든 티켓의 산출물은 프로젝트의 브랜치 `t/<id>`(개선팀은 회사 레포의 `imp/<id>`)입니다. 시니어는 워크트리 `<project>/.claude/worktrees/t-<id>`에서 작업합니다.
- 코드가 아닌 산출물(리서치 보고서, GTM 초안, 운영 런북, 빌드 결과물)은 그 브랜치의 `docs/holdco/<부서>/<티켓>.md`에 두고, 경로를 `ticket_update` 노트에 `deliverable: <경로>`로 적습니다. 커널이 이 값을 행동의 실행기에 `{deliverable}`로 넘깁니다(`company.yaml:executors`).
- 머지 행동은 커널의 머지 실행기가 기본 브랜치로 머지하고 되돌리기를 기록합니다. 배포·게시·연락·아웃리치 행동은 v1에 실행기가 없어 운영자가 직접 수행하고 승인하는 `manual_action` 인박스 항목이 됩니다.

### 전이와 호출자

위 표와 같습니다. 시니어는 `ticket_create`·`ticket_update`, CEO는 `ticket_triage`·`ticket_unblock`·`proposal_submit`, COO는 `proposal_review`, 검증은 `verdict_submit`, 커널은 임대·등급 계산·실행, 운영자는 `holdco ticket new|unblock|decline`, `holdco inbox approve|reject`, `holdco rollback`, `holdco interrupt|resume`.
