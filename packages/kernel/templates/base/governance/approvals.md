# Approvals & Escalation

> 🔒 **Locked.** Operator only. / 🔒 **잠금.** 운영자만 수정합니다.

---

## English

### 1. Who approves what

| Tier | Proposer | Approver | Operator role |
|---|---|---|---|
| T0 | Any department senior (`action_request`) | — (Verification verdict, then the kernel executes) | Reads the weekly digest |
| T1 | Any department senior (`action_request`) | Envelope check, run by the kernel at execution | Reads the weekly digest |
| T2 | CEO (`proposal_submit`) | COO concurrence (`proposal_review`) | May challenge within the window (`holdco rollback`) |
| T3 | CEO, with the COO's review attached | **Operator** (`holdco inbox approve|reject <id>`) | Approves or rejects in the inbox; silence expires to reject after `policy.inbox.timeout` |

The kernel computes the tier when a ticket reaches `verified` (`governance/policy.md` §1). **Without a COO, every T2 runs as T3** and goes straight to the Operator's inbox after the CEO's proposal; without a CEO the kernel drafts the proposal from the ticket.

### 2. The CEO–COO protocol (T2 and T3)

1. **CEO proposes** with `proposal_submit` at stage `needs_proposal`. The Proposal is `{ticket, title, decision, goal, alternatives_rejected[], expected_cost, rollback_plan, why_now, risk, reversibility, evidence[]}`. The CEO's reasoning trace is stored but **not shown to the COO**.
2. **COO reviews independently** with `proposal_review` at stage `needs_review`. The COO receives the proposal, the policy file, and current metrics, and answers three questions as booleans:
   - Does this violate `governance/policy.md` or the Constitution? (`violates_policy`)
   - Does it fit within budget and capacity? (`within_budget_and_capacity`)
   - Is the rollback plan executable? (`rollback_executable`)
3. **Outcome.** The Review is `{ticket, decision: concur|object|needs_info, the three booleans, reasoning}`.
   - `concur` (only when all three pass) → T2 executes optimistically and the challenge window opens; T3 goes to the inbox with the concurrence attached.
   - `object` → the inbox, with both positions side by side.
   - `needs_info` → names one specific missing fact, at most once per proposal; also the inbox.
   - Neither may re-submit the same proposal after an objection without new information.

### 3. Challenge window

| Action class | Window | After the window |
|---|---|---|
| T2, internal | `company.yaml:policy.windows.t2_internal` (default 24h) | Finalized |
| T2, external but reversible | `company.yaml:policy.windows.t2_external` (default 72h) | Finalized |

During the window the Operator may roll back with one command (`holdco rollback <action-log-id>`; the merge executor recorded the undo). Finalized actions can still be reversed, but by a new ticket rather than an automatic rollback.

### 4. Keeping dual control honest

Dual control fails silently when the COO stops judging and starts agreeing. Two mechanisms detect this:

**Disagreement rate.** Tracked weekly in the digest.
- Near 0% for `company.yaml:policy.executive.rubber_stamp_weeks` consecutive weeks → flag: possible rubber-stamping.
- Above `company.yaml:policy.executive.high_disagreement` → flag: CEO strategy and policy have diverged; the Operator should revisit the strategy document.

**Canary proposals.** The kernel injects proposals with a known, deliberate violation into the COO's review batch at random (target `company.yaml:policy.executive.canary_rate` of review traffic). The COO cannot distinguish canaries from real proposals.
- A canary rejected → recorded as a pass; the canary ticket is retired.
- A canary approved → nothing executes; the related action type is **demoted** (policy §5) **and** the kernel raises **L3** with an Operator alert (`governance/interrupts.md` §3).

Canary content lives in `evals/canaries/` as Proposal JSON files, which neither the CEO nor the COO can read.

### 5. The Operator inbox

T3 requests, T2 objections and `needs_info`, cannot-score verdicts, `manual_action` items (deploys and publishes the Operator performs by hand), triage items when there is no CEO, blocked tickets past `policy.executive.blocked_after`, and `issue_file` proposals arrive in one inbox, rendered by the kernel and delivered as a **daily batch** at `company.yaml:policy.inbox.batch_at`. `holdco inbox` lists it; `holdco inbox approve <id>` / `holdco inbox reject <id>` answer an item.

Each item the kernel renders carries:

```
Title:            one line
Recommendation:   approve / reject, with the CEO's and COO's positions
Why now:          what is blocked until this is decided
Evidence:         ticket id, verdict scores, relevant reports
Risk:             worst realistic outcome if approved
Reversibility:    how to undo, and until when
Cost:             money, time, and capacity
Default if no answer within company.yaml:policy.inbox.timeout:  reject (never approve by silence)
```

The CEO is measured on **inbox load**: items per week and median Operator handling time. Both should fall over time. Reducing load by under-escalating is caught by the weekly sample grading and the canaries.

### 6. Escalation paths

| Trigger | Goes to | Mechanism |
|---|---|---|
| CEO–COO disagreement or `needs_info` | Operator inbox | kernel, after `proposal_review` |
| Envelope exceeded | T2 (CEO → COO) | kernel at execution |
| Ticket blocked > `company.yaml:policy.executive.blocked_after`, or no CEO | Operator inbox | kernel; `holdco ticket unblock|decline` |
| Senior–junior deadlock after `policy.delegation.max_iterations` | CEO | `ticket_update → blocked` with both positions in the note |
| Evaluator cannot score an output | Operator inbox | `verdict_submit` with `cannot-score` |
| Any agent believes an article of the Constitution is being violated | Operator, directly, bypassing CEO and COO | `issue_file` |

---

## 한국어

### 1. 누가 무엇을 결재하는가

| 등급 | 제안자 | 결재자 | 운영자의 역할 |
|---|---|---|---|
| T0 | 각 부서 시니어(`action_request`) | — (검증 판정 후 커널이 실행) | 주간 다이제스트 열람 |
| T1 | 각 부서 시니어(`action_request`) | 위임 범위 검사, 커널이 실행 시점에 수행 | 주간 다이제스트 열람 |
| T2 | CEO(`proposal_submit`) | COO 동의(`proposal_review`) | 이의제기 창 안에서 `holdco rollback` |
| T3 | CEO(COO 검토 첨부) | **운영자**(`holdco inbox approve|reject <id>`) | 인박스에서 승인 또는 거절. `policy.inbox.timeout` 경과 시 거절 |

등급은 티켓이 `verified`가 될 때 커널이 계산합니다(`governance/policy.md` §1). **COO가 없으면 모든 T2는 T3로** CEO 제안 뒤 바로 운영자 인박스로 가고, CEO가 없으면 커널이 티켓에서 제안 초안을 만듭니다.

### 2. CEO–COO 프로토콜 (T2·T3)

1. **CEO 제안.** `needs_proposal` 단계에서 `proposal_submit`. 제안서는 `{ticket, title, decision, goal, alternatives_rejected[], expected_cost, rollback_plan, why_now, risk, reversibility, evidence[]}`. CEO의 추론 과정은 저장되지만 **COO에게 보이지 않습니다**.
2. **COO 독립 검토.** `needs_review` 단계에서 `proposal_review`. 제안서, 정책 파일, 현재 지표만 받고 세 질문에 불리언으로 답합니다: 정책·헌법 위반(`violates_policy`), 예산·용량 적합(`within_budget_and_capacity`), 롤백 실행 가능(`rollback_executable`).
3. **결과.** 검토서는 `{ticket, decision: concur|object|needs_info, 불리언 셋, reasoning}`.
   - `concur`(셋 다 통과할 때만) → T2는 옵티미스틱 실행, 이의제기 창 개시. T3는 동의를 첨부해 인박스로
   - `object` → 양측 입장을 나란히 붙여 인박스로
   - `needs_info` → 빠진 사실 하나를 특정(제안당 최대 1회), 역시 인박스로
   - 반대 이후에는 새 정보 없이 같은 제안을 다시 올릴 수 없음

### 3. 이의제기 창

T2 내부 `policy.windows.t2_internal`(기본 24시간), T2 외부·가역 `policy.windows.t2_external`(기본 72시간). 창 안에서는 `holdco rollback <action-log-id>` 한 번으로 롤백(머지 실행기가 되돌리기를 기록해 둠). 확정된 행동은 새 티켓으로 되돌립니다.

### 4. 이중 통제가 살아 있게 하는 장치

**불일치율.** 주간 다이제스트에서 추적. `policy.executive.rubber_stamp_weeks`주 연속 0%에 가까우면 도장 찍기 의심, `policy.executive.high_disagreement` 초과면 전략·정책 괴리.

**카나리 제안.** 커널이 의도적 위반이 든 제안을 COO 검토 묶음에 무작위로 섞습니다(`policy.executive.canary_rate`). COO는 구별할 수 없습니다.
- 카나리 거절 → 통과로 기록, 카나리 티켓 은퇴
- 카나리 승인 → 실행되지 않음. 관련 행동 유형 **강등**(정책 §5) **및** 커널이 **L3**를 걸고 운영자 경보(`governance/interrupts.md` §3)

카나리는 `evals/canaries/`의 Proposal JSON 파일이며 CEO·COO 모두 읽을 수 없습니다.

### 5. 운영자 인박스

T3 요청, T2 반대·`needs_info`, cannot-score 판정, `manual_action`(운영자가 직접 수행하는 배포·게시), CEO가 없을 때의 분류, `blocked_after`를 넘긴 티켓, `issue_file` 제안이 하나의 인박스로 들어오며, 커널이 렌더링해 매일 `policy.inbox.batch_at`에 **묶어서** 전달합니다. `holdco inbox`로 보고 `holdco inbox approve|reject <id>`로 답합니다. 각 항목은 위 템플릿의 필드를 담습니다. **응답이 없으면 기본값은 거절이며, 침묵으로 승인되는 일은 없습니다.**

CEO는 **인박스 부하**(주당 건수, 운영자 처리 시간 중앙값)로 평가됩니다. 에스컬레이션을 덜 해서 부하를 줄이는 꼼수는 주간 샘플 채점과 카나리로 잡힙니다.

### 6. 에스컬레이션 경로

| 계기 | 가는 곳 | 방식 |
|---|---|---|
| CEO–COO 이견 또는 `needs_info` | 운영자 인박스 | `proposal_review` 후 커널 |
| 위임 범위 초과 | T2 (CEO → COO) | 실행 시점 커널 |
| `policy.executive.blocked_after` 초과 또는 CEO 없음 | 운영자 인박스 | 커널. `holdco ticket unblock|decline` |
| 시니어–주니어 `max_iterations` 후 교착 | CEO | `ticket_update → blocked`, 노트에 양측 입장 |
| 평가기가 채점할 수 없음 | 운영자 인박스 | `verdict_submit`의 `cannot-score` |
| 헌법 위반 의심 (모든 에이전트) | CEO·COO를 건너뛰고 운영자에게 | `issue_file` |
