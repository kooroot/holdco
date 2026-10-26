# Metrics

> ✏️ Improvement may propose new metrics. Removing a metric the digest uses requires Operator approval.
> ✏️ 개선팀이 새 지표를 제안할 수 있습니다. 다이제스트가 쓰는 지표를 없애려면 운영자 승인이 필요합니다.

---

## English

Every metric below is computed by the kernel from its database (tickets, events, verdicts, labels, action log, session costs) and rendered into the weekly digest; the CEO adds only the narrative. Agents read metrics in the digest and in `reports/`; none of them reports a metric about itself.

### Company level (weekly digest)

| Metric | Why it matters | Healthy direction |
|---|---|---|
| **Evaluator–Operator agreement** (labels from `holdco audit` vs verdicts) | The one number that justifies autonomy | High and stable |
| Strategy objective progress | Are we doing the right work | Up |
| Total spend vs envelopes | Cost control | Within envelope |
| Inbox load (items/week, median handling time) | Operator attention spent | Down |
| CEO–COO disagreement rate | Dual control is alive | Low but non-zero |
| Canary pass rate (canaries objected / canaries injected) | COO is still judging | ~100% |
| Rollbacks (`holdco rollback`) and interrupts (incl. tripwires) | Things going wrong | Down |
| Action types by tier (`company.yaml:actions`, promotions and demotions) | Autonomy earned over time | Shifting toward T0/T1 |

### Department level

| Metric | Source |
|---|---|
| Verification first-pass rate | Verdicts per ticket (approve on first `verdict_submit`) |
| Attempts per ticket (rejections, crashes, timeouts) | Ticket `attempts` |
| Cost per completed ticket | Session costs summed per ticket |
| Cycle time | Ticket events (`triaged` → `done`) |
| Escaped defects | Tickets opened against a `done` ticket |
| Blocked tickets and time to unblock | Ticket events |

### Delegation level (input to Improvement)

| Metric | Measures |
|---|---|
| Junior failure rate per brief pattern (returns rejected by `delegate_wait`) | Brief quality |
| Assumptions per return, by department | Missing context in briefs |
| Juniors started per criterion passed | Clarity of done criteria |
| Spawn reason (`pattern`) vs outcome | Sizing judgment |
| Restatement rate and restated briefs that changed | Brief ambiguity |
| Junior cost share vs senior (from session costs) | Model tiering effectiveness |

### Anti-gaming notes

- Inbox load can be lowered by under-escalating. Watch it together with agreement and canaries.
- First-pass rate can be raised by producing smaller, safer work. Watch it together with strategy progress.
- Assumptions-per-return can be lowered by juniors hiding guesses. Spot-check returns in the weekly sample.

---

## 한국어

아래 지표는 모두 커널이 자기 데이터베이스(티켓, 이벤트, 판정, 라벨, 행동 로그, 세션 비용)에서 계산해 주간 다이제스트에 렌더링합니다. CEO는 서술만 더하고, 어떤 에이전트도 자기 지표를 스스로 보고하지 않습니다.

### 회사 단위 (주간 다이제스트)
가장 중요한 건 **평가기–운영자 일치율**(`holdco audit` 라벨 대 판정)입니다. 자율성을 정당화하는 유일한 숫자이며 높고 안정적이어야 합니다. 그 외 전략 목표 진척, 위임 범위 대비 지출, 인박스 부하(줄어야 함), CEO–COO 불일치율(낮되 0은 아니어야 함), 카나리 통과율(약 100%), 롤백·인터럽트(줄어야 함), 등급별 행동 유형 분포(시간이 갈수록 T0/T1 쪽으로 이동).

### 부서 단위
검증 1차 통과율(첫 판정에서 approve), 티켓당 시도 횟수(반려·크래시·타임아웃), 완료 티켓당 비용(세션 비용 합), 사이클 타임(`triaged` → `done` 이벤트), 완료 후 발견된 결함, blocked 티켓 수와 해소 시간.

### 위임 단위 (개선팀의 입력)
패턴별 주니어 실패율(`delegate_wait`가 반려한 반환서), 부서별 반환서당 가정 수, 통과한 기준당 시작한 주니어 수, 스폰 이유 대 결과, 되짚기 비율과 되짚기 후 바뀐 지시서, 시니어 대비 주니어 비용 비중.

### 지표 조작 방지 메모
- 인박스 부하는 에스컬레이션을 덜 해서 낮출 수 있음 → 일치율·카나리와 함께 볼 것
- 1차 통과율은 작고 안전한 일만 해서 높일 수 있음 → 전략 진척과 함께 볼 것
- 반환서당 가정 수는 주니어가 추측을 숨겨서 낮출 수 있음 → 주간 샘플에서 반환서를 표본 검사할 것
