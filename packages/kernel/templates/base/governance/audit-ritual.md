# Operator Audit Ritual

> 🔒 **Locked.** Operator only. / 🔒 **잠금.** 운영자만 수정합니다.

---

## English

The Operator does not review every output. The Operator reviews **whether the system that reviews outputs can still be trusted**. This ritual is the minimum that keeps that true. It is mandatory: skipping it is how an unattended company drifts without anyone noticing.

### Weekly — 30 minutes

The kernel renders the weekly digest (template below) from the record at `company.yaml:policy.digest`, with the narrative the CEO added through `report_write`; `holdco digest` renders it on demand. The Operator works through it in this order:

| # | Block | Time | Question the Operator answers |
|---|---|---|---|
| 1 | **Goals** | 5 min | Are we moving toward the strategy document's objectives? |
| 2 | **Anomalies** | 5 min | Anything unusual in spend, error rates, rollbacks, tripwires? |
| 3 | **Sample grading** | 10 min | Does the evaluator still agree with me? |
| 4 | **Org changes** | 5 min | Do this week's improvements make sense? |
| 5 | **Pending T3** | 5 min | Anything in the inbox I have been avoiding? |

### Block 3 is the one that matters

`holdco audit sample` draws `company.yaml:policy.audit.weekly_sample` (default 10) verified outputs at random, weighted toward departments with lower evaluator confidence and higher risk (GTM at `policy.audit.gtm_multiplier`). The Operator grades each one **blind** with `holdco audit grade <id> approve|reject`, without seeing the evaluator's score; `holdco audit done` closes the week and only then are the two scores revealed and compared.

- Agreement stays high → the evaluator is calibrated; autonomy is justified.
- Agreement drops → the evaluator is drifting, or the work has changed in a way the rubric doesn't capture. Demotion triggers automatically (policy §5). The Operator decides whether to fix the rubric.
- Missing the audit `policy.audit.freeze_after_missed` weeks in a row raises L3 (`governance/interrupts.md` §3): no org change ships while nobody is checking the checker.

The Operator's grades are stored as labels in the kernel database and become the ground truth that graduation decisions are measured against; `evals/labels/` holds exported copies only.

### Monthly — 60 minutes

- Rewrite or confirm the **strategy document** the CEO allocates against.
- Review **envelope sizes**: raise those that block useful work, lower those never used.
- Review the **action registry**: which types are close to graduating (`holdco promote <action>` applies a graduation the kernel proposed), which were demoted.
- Read one full ticket end-to-end (`holdco ticket show <id>`), from CEO allocation to merge, to keep a first-hand picture of how the company actually works.

### Weekly digest template

The kernel fills the placeholders in angle brackets from the record.

```markdown
# Week <iso-week> digest

## 1. Goals
| Objective (from strategy doc) | Target | This week | Trend |

## 2. Anomalies
- Spend vs envelopes (per department)
- Error / rollback / tripwire counts vs 4-week average
- Interrupts issued and why

## 3. Sample grading
(blind items appear here; scores hidden until `holdco audit done`)

## 4. Org changes (release <release-tag>)
| Change | Department | Eval before → after | Canary result |
- Promotions and demotions in the action registry

## 5. Executive health
- CEO–COO disagreement rate (4-week trend)
- Canary pass rate
- Inbox load: items, median handling time

## 6. Pending T3
(inbox items, oldest first; answer with holdco inbox approve|reject <id>)

## 7. What the company did not understand this week
- Assumptions juniors made that seniors did not resolve
- Tickets the evaluator could not score

## 8. CEO narrative
(the text the CEO wrote with report_write; the only agent-authored section)
```

Section 7 exists because the most dangerous gap in an unattended company is the one the Operator cannot see: code, decisions, and context that grew without anyone fully understanding them.

---

## 한국어

운영자는 모든 산출물을 검토하지 않습니다. 운영자는 **산출물을 검토하는 시스템을 아직 믿을 수 있는가**를 검토합니다. 이 루틴은 그걸 유지하기 위한 최소한이며 의무입니다. 이걸 건너뛰는 게 바로 무인 회사가 아무도 모르게 표류하는 경로입니다.

### 매주 — 30분

커널이 `company.yaml:policy.digest`에 기록으로부터 주간 다이제스트(아래 템플릿)를 렌더링하고, CEO가 `report_write`로 쓴 서술을 붙입니다(`holdco digest`로 즉시 렌더링 가능). 운영자는 다음 순서로 봅니다.

| # | 블록 | 시간 | 운영자가 답할 질문 |
|---|---|---|---|
| 1 | **목표** | 5분 | 전략 문서의 목표를 향해 가고 있는가? |
| 2 | **이상 신호** | 5분 | 지출, 에러율, 롤백, 트립와이어에 특이점이 있는가? |
| 3 | **샘플 채점** | 10분 | 평가기가 아직 내 판단과 일치하는가? |
| 4 | **조직 변경** | 5분 | 이번 주 개선 사항이 납득되는가? |
| 5 | **대기 중인 T3** | 5분 | 인박스에서 미뤄둔 건이 있는가? |

### 핵심은 3번 블록

`holdco audit sample`이 검증된 산출물 `company.yaml:policy.audit.weekly_sample`개(기본 10개)를 무작위로 뽑되, 평가기 신뢰도가 낮고 위험이 큰 부서에 가중치를 둡니다(GTM은 `policy.audit.gtm_multiplier`배). 운영자는 평가기 점수를 보지 않고 `holdco audit grade <id> approve|reject`로 **블라인드** 채점하고, `holdco audit done`으로 주를 닫은 뒤에야 두 점수가 공개되고 비교됩니다.

- 일치율이 높게 유지됨 → 평가기가 보정되어 있음. 자율성이 정당화됨.
- 일치율이 떨어짐 → 평가기가 표류하고 있거나, 작업이 루브릭이 담지 못하는 방향으로 바뀜. 강등이 자동으로 걸리고(정책 §5), 루브릭을 고칠지는 운영자가 결정함.
- 감사를 `policy.audit.freeze_after_missed`주 연속 거르면 L3(`governance/interrupts.md` §3). 검사자를 아무도 검사하지 않는 동안 조직 변경은 나가지 않습니다.

운영자의 채점은 커널 데이터베이스에 라벨로 저장되어 승격 판정의 정답이 되며, `evals/labels/`에는 내보낸 사본만 둡니다.

### 매월 — 60분

- CEO가 배분 기준으로 삼는 **전략 문서**를 다시 쓰거나 확인
- **위임 범위 크기** 검토: 유용한 일을 막는 범위는 늘리고, 안 쓰는 범위는 줄이기
- **행동 레지스트리** 검토: 승격에 가까운 유형(커널이 제안한 승격은 `holdco promote <action>`으로 적용), 강등된 유형
- 티켓 하나(`holdco ticket show <id>`)를 CEO 배분부터 머지까지 처음부터 끝까지 읽기. 회사가 실제로 어떻게 돌아가는지 직접 파악한 그림을 유지하기 위함

### 주간 다이제스트 템플릿

위 템플릿과 같습니다. 꺾쇠 안의 값은 커널이 기록에서 채우고, 8번 섹션(CEO 서술)만 에이전트가 씁니다. 7번 섹션("이번 주 회사가 이해하지 못한 것")이 있는 이유는, 무인 회사에서 가장 위험한 공백이 운영자 눈에 보이지 않는 곳에 있기 때문입니다. 아무도 완전히 이해하지 못한 채 자라난 코드, 결정, 맥락입니다.
