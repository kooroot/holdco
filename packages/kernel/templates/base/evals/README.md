# Evaluation System

> 🔒 **Locked.** Operator only. No agent may edit anything under `evals/`. Improvement is measured against these files precisely because it cannot change them.
> 🔒 **잠금.** 운영자만 수정합니다. 어떤 에이전트도 `evals/` 아래를 수정할 수 없습니다. 개선팀은 바로 이 파일들을 바꿀 수 없기 때문에 이 파일들로 측정됩니다.

---

## English

### 1. What lives here

```
evals/
├── README.md          this file: evaluator interface, graduation, calibration
├── rubrics/           how each department's output is scored
├── replay/            frozen historical tickets used to test improvements
├── labels/            the Operator's blind grades (ground truth)
└── canaries/          deliberate violations injected into CEO→COO review
                       (unreadable by CEO, COO, and all departments)
```

### 2. Evaluator interface

Every Verification session ends with one Verdict, submitted with `verdict_submit` and repeated as the session's final message. The kernel validates this JSON shape (`src/protocol/verdict.ts`):

```json
{
  "ticket": "ENG-142",
  "rubric": "engineering.md#app",
  "verdict": "approve",
  "scores": { "correctness": 4, "tests": 3, "scope": 4, "assumptions": 3, "rollback": 2 },
  "overall": 3.45,
  "confidence": "high",
  "failures": [],
  "gates": [
    { "gate": "ci-green", "passed": true, "evidence": "no remote with checks; bun test: 14 passed, 0 failed" },
    { "gate": "verification-approved", "passed": true, "evidence": "this verdict" }
  ],
  "summary": "Meets every done criterion; rollback note is vague but present."
}
```

| Field | Meaning |
|---|---|
| `ticket` | The ticket under review (must match the session's ticket) |
| `rubric` | `<file>#<section>` under `evals/rubrics/`, the `evaluator` of the ticket's action in `company.yaml:actions` |
| `verdict` | `approve` → ticket `verified`; `reject` → `rejected`, back to the senior, counts as an attempt; `cannot-score` → `blocked`, Operator inbox |
| `scores` | One integer 0–4 per rubric dimension. The rubric tables describe 4, 2 and 0; **1 and 3 are intermediates**, used when the output sits between two descriptions |
| `overall` | Weighted per the rubric, 0–4; the kernel may recompute it from `scores` |
| `confidence` | `high` / `medium` / `low`; low-confidence verdicts are oversampled in the Operator's weekly grading |
| `failures` | `[{criterion, evidence}]`; a `reject` needs at least one |
| `gates` | `[{gate, passed, evidence}]` for every mechanical gate the action lists (`governance/policy.md` §4b); an `approve` needs every listed gate `passed`, and the kernel rejects a ticket whose action gates are not evidenced here |
| `summary` | One paragraph; for `cannot-score`, which rubric is missing |

Rules:
- **Mechanical checks first.** Anything a test, linter, schema, or command can decide is decided that way and recorded in `gates`. LLM grading covers only what cannot be mechanized.
- The grader receives the rubric, the ticket, the branch and the senior's note. Never the producer's reasoning.
- `cannot-score` means no rubric covers the output. The kernel blocks the ticket and puts it in the Operator's inbox; the Operator adds or fixes a rubric and unblocks.
- Two evaluators are computed by the kernel rather than by a rubric: `calibration` (Verification's own verdicts, scored by the Operator's blind labels) and `replay` (Improvement merges, scored by the release job on the replay suite).

### 3. Graduation — how autonomy is earned

An action type in `governance/policy.md` moves to a less restrictive tier only when all of these hold:

| Condition | Default |
|---|---|
| Labeled samples of that action type (Operator blind grades) | ≥ `company.yaml:policy.graduation.samples` (30) |
| Evaluator–Operator agreement on approve/reject | ≥ `company.yaml:policy.graduation.agreement` (0.95) |
| Agreement on the most recent 10 samples | 10/10 |
| No Operator rollback of that type in the window | 0 |
| No missed canary of that type in the window | 0 |
| The action has a registered evaluator | required |

Graduation is proposed by the kernel, never by an agent, and applied by the Operator with `holdco promote <action>`, which lowers the `tier` in `company.yaml:actions`. Actions marked `graduation: never` stay where they are regardless of record; `graduation: auto` means the kernel proposes when the table holds.

How labels accumulate: while an action type is at T2 or T3, every Operator approve/reject in the inbox is also stored as a label, alongside the weekly `holdco audit` grades. Approvals are not only gates; they are training data for the evaluator that will eventually replace them.

### 4. Demotion

Mirror of graduation, applied immediately (`governance/policy.md` §5): agreement drops below `company.yaml:policy.graduation.demotion_agreement` (0.85) over the last `company.yaml:policy.graduation.demotion_window` (20) samples, any rollback, or any missed canary.

### 5. Calibration

The single most important number in the company is **evaluator–Operator agreement**, measured every week by blind sample grading (`governance/audit-ritual.md`). If it holds, autonomy is safe. If it slips, the company is optimizing toward a standard the Operator no longer endorses.

When agreement slips, the Operator chooses one of:
1. **Fix the rubric** — the work changed and the rubric did not.
2. **Retrain the grader prompt** — the rubric is right but the grader misapplies it.
3. **Accept the drift** — the Operator's own standard changed; update the rubric to match.

### 6. Replay suite

The replay suite is frozen historical tickets with their briefs, inputs, and Operator-approved outcomes, kept in the kernel database; `evals/replay/` holds exported copies. The release job runs candidate Improvement merges against it (`replay-gain` gate). The suite is refreshed only by the Operator, from tickets that have been labeled. Improvement can see the suite's results, not edit its contents. While the suite is empty, replay gates are skipped and noted.

### 7. Canaries

`evals/canaries/` holds Proposal JSON files with known, deliberate violations (budget breach, policy violation, missing rollback, wrong tier). The kernel injects them into the COO's review batch at `company.yaml:policy.executive.canary_rate`. See `governance/approvals.md` §4 and `evals/canaries/README.md`.

---

## 한국어

### 1. 여기 있는 것

- `README.md`: 이 파일. 평가기 인터페이스, 승격, 보정
- `rubrics/`: 각 부서의 산출물 채점 방법
- `replay/`: 개선안을 테스트하는 고정된 과거 티켓
- `labels/`: 운영자의 블라인드 채점 (정답)
- `canaries/`: CEO→COO 검토에 주입되는 의도적 위반 (CEO, COO, 모든 부서가 읽을 수 없음)

### 2. 평가기 인터페이스

모든 검증 세션은 `verdict_submit`으로 제출하고 마지막 메시지로도 반복하는 판정서 하나로 끝납니다. 커널이 위 JSON 형식을 검증합니다: `ticket`(세션의 티켓), `rubric`(`company.yaml:actions`의 `evaluator`, `<파일>#<섹션>`), `verdict`(`approve` → `verified`, `reject` → `rejected`로 시니어에게 반려·시도 횟수 소모, `cannot-score` → `blocked`·운영자 인박스), `scores`(항목별 정수 0~4. 표는 4·2·0을 설명하고 **1과 3은 중간값**), `overall`(가중 평균, 커널이 재계산 가능), `confidence`(low는 주간 채점에서 더 많이 뽑힘), `failures`(`reject`에 최소 1개), `gates`(행동의 기계적 게이트마다 통과 여부와 증거. `approve`는 전부 통과해야 하고, 증거 없는 게이트는 커널이 반려), `summary`(cannot-score면 어떤 루브릭이 없는지).

규칙:
- **기계적 검사 우선.** 테스트, 린터, 스키마, 명령으로 판정할 수 있는 건 그렇게 판정하고 `gates`에 기록합니다. LLM 채점은 기계화할 수 없는 부분만 다룹니다.
- 채점자는 루브릭, 티켓, 브랜치, 시니어 노트만 받습니다. 생산자의 추론은 절대 받지 않습니다.
- `cannot-score`는 루브릭이 없다는 뜻입니다. 커널이 티켓을 막고 운영자 인박스에 넣으며, 운영자가 루브릭을 추가·수정한 뒤 풉니다.
- 루브릭이 아니라 커널이 계산하는 평가기 둘: `calibration`(검증 판정 자체, 운영자 블라인드 라벨로 채점)과 `replay`(개선 머지, 릴리스 잡이 리플레이 세트로 채점).

### 3. 승격 — 자율성을 획득하는 방법

`governance/policy.md`의 행동 유형은 위 표의 조건을 모두 충족할 때만 덜 엄격한 등급으로 이동합니다. 운영자 블라인드 채점 샘플 30개 이상, 승인/반려 일치율 0.95 이상, 최근 10개는 10/10 일치, 기간 내 롤백 0회, 카나리 놓침 0회, 등록된 평가기 존재.

승격은 에이전트가 아니라 커널이 제안하고, 운영자가 `holdco promote <action>`으로 적용해 `company.yaml:actions`의 `tier`를 낮춥니다. `graduation: never`인 행동은 기록과 무관하게 그 자리에 머물고, `auto`는 표가 충족되면 커널이 제안합니다.

라벨이 쌓이는 방식: 행동 유형이 T2나 T3에 있는 동안, 인박스에서 운영자가 한 모든 승인/거절이 주간 `holdco audit` 채점과 함께 라벨로 저장됩니다. **결재는 단순한 관문이 아니라, 언젠가 그 결재를 대체할 평가기의 학습 데이터입니다.**

### 4. 강등

승격의 반대이며 즉시 적용됩니다(`governance/policy.md` §5). 최근 20개 샘플에서 일치율이 0.85 미만, 롤백 발생, 카나리 놓침 중 하나라도 해당되면 강등됩니다.

### 5. 보정

회사에서 가장 중요한 숫자 하나는 **평가기–운영자 일치율**이며, 매주 블라인드 샘플 채점으로 측정합니다(`governance/audit-ritual.md`). 이게 유지되면 자율성은 안전합니다. 이게 미끄러지면 회사는 운영자가 더 이상 지지하지 않는 기준을 향해 최적화하고 있는 것입니다.

일치율이 떨어지면 운영자는 셋 중 하나를 고릅니다.
1. **루브릭 수정** — 작업은 바뀌었는데 루브릭이 안 바뀜
2. **채점 프롬프트 재조정** — 루브릭은 맞는데 채점자가 잘못 적용함
3. **표류 수용** — 운영자 본인의 기준이 바뀜. 루브릭을 거기에 맞춰 갱신

### 6. 리플레이 세트

리플레이 세트는 지시서, 입력, 운영자가 승인한 결과와 함께 고정된 과거 티켓이며 커널 데이터베이스에 있고 `evals/replay/`에는 내보낸 사본만 둡니다. 릴리스 잡이 개선 머지 후보를 여기에 대고 실행합니다(`replay-gain` 게이트). 세트는 라벨이 붙은 티켓으로 운영자만 갱신합니다. 개선팀은 결과를 볼 수 있지만 내용을 수정할 수 없습니다. 세트가 비어 있는 동안 리플레이 게이트는 건너뛰고 기록합니다.

### 7. 카나리

`evals/canaries/`에는 알려진 의도적 위반(예산 초과, 정책 위반, 롤백 계획 누락, 잘못된 등급)이 담긴 Proposal JSON 파일이 있습니다. 커널이 `company.yaml:policy.executive.canary_rate` 비율로 COO 검토 묶음에 주입합니다. `governance/approvals.md` §4, `evals/canaries/README.md` 참조.
