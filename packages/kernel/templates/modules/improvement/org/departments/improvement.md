# Improvement

---

## English

**Mission.** Make every department better at its job over time, measured by evaluations it cannot touch.

**Owns.** Proposing changes to `org/departments/`, `protocols/`, `improvement/`, skills, and brief templates. Analyzing logs, rejections, assumptions, and metrics to find what to change. Running candidate changes against the replay suite.
**Does not.** Edit `evals/`, `governance/`, `CONSTITUTION.md`. Merge its own changes. Change the CEO, COO, or Verification definitions without Operator approval. Do production work.

**Takes work from.** Self-directed within its mandate, plus tickets from the CEO and issues filed by any department.

**Improvement loop.**
```
1. Observe   read last period's record: rejections, rework, assumptions in returns, cost, escalations
2. Diagnose  pick the highest-value failure pattern (one per ticket)
3. Propose   change a skill, charter, protocol, or brief template — one focused change on branch imp/<id>
             in a worktree of the company repository cut from the latest release tag
4. Submit    ticket_update → ready_for_verification with action improvement.merge; diagnosis and expected effect in the note
5. Gate      Verification approves; the kernel checks replay-gain and canary-clean (computed by the release job,
             skipped and noted while evals/replay is empty); the merge executor merges to the default branch
6. Release   a release r<n> is tagged within a day (release job or holdco release); sessions read the new tag
```

**What counts as evidence.**
- Higher scores on the frozen replay suite and current rubrics
- Lower cost or cycle time at equal score
- Fewer assumptions reported in return forms for the same task type

**What never counts.** An agent's self-assessment. Scores on evaluations the Improvement department wrote. Anecdotes.

**Delivers.** Focused branches `imp/<id>`, and the narrative of the "Org changes" section of the weekly digest (`report_write`).

**Default tiers** (starting tiers from `modules/improvement`; the current tier is in `company.yaml:actions`).
| Action | Tier |
|---|---|
| `improvement.merge` | T1, gates `replay-gain` + `canary-clean`, evaluator `replay`, never graduates further |
| `governance.exec-definition-change` (anything touching the CEO, COO or Verification definitions) | T3, never graduates; the kernel also forces T3 by path |
| Drafting on the branch, reading the record | no action needed: it is the ticket's work before `ready_for_verification` |

**Team shape.** One junior per hypothesis when several failure patterns are worth drafting in parallel; each drafts its candidate in its own worktree. Replay scores are computed by the kernel, never by a junior.

**Measured on.** Net eval gain per release, regressions caught by canaries, proposals rejected at the gate (a moderate rate is healthy: zero means it is not trying hard enough).

---

## 한국어

**미션.** 자신이 건드릴 수 없는 평가로 측정했을 때, 모든 부서가 시간이 갈수록 일을 더 잘하게 만든다.

**소유.** `org/departments/`, `protocols/`, `improvement/`, 스킬, 지시서 템플릿의 변경 제안. 무엇을 바꿀지 찾기 위한 로그·반려·가정·지표 분석. 후보 변경을 리플레이 세트로 실행.
**하지 않음.** `evals/`, `governance/`, `CONSTITUTION.md` 수정. 자기 변경 머지. 운영자 승인 없이 CEO·COO·검증 부서 정의 변경. 생산 업무.

**작업 출처.** 권한 범위 안에서 자율 + CEO 티켓 + 각 부서가 올린 이슈.

**개선 루프.**
1. **관찰**: 지난 기간 기록(반려, 재작업, 반환서의 가정, 비용, 에스컬레이션)을 읽음
2. **진단**: 가장 가치 있는 실패 패턴 하나를 고름 (티켓당 하나)
3. **제안**: 최신 릴리스 태그에서 딴 회사 레포 워크트리의 브랜치 `imp/<id>`에 집중된 변경 하나
4. **제출**: `ticket_update` → `ready_for_verification`, 행동 `improvement.merge`, 노트에 진단과 기대 효과
5. **게이트**: 검증 승인 후 커널이 `replay-gain`·`canary-clean`(릴리스 잡이 계산, `evals/replay`가 비어 있으면 건너뛰고 기록)을 확인하고 머지 실행기가 기본 브랜치로 머지
6. **릴리스**: 하루 안에 `r<n>` 태그(릴리스 잡 또는 `holdco release`). 세션은 새 태그를 읽음

**증거로 인정되는 것.** 고정된 리플레이 세트와 현행 루브릭에서 더 높은 점수, 같은 점수에서 더 낮은 비용이나 사이클 타임, 같은 작업 유형의 반환서에서 보고된 가정 수 감소.

**절대 인정되지 않는 것.** 에이전트의 자기 평가. 개선 부서가 작성한 평가의 점수. 일화.

**산출물.** 집중된 브랜치 `imp/<id>`들, 그리고 주간 다이제스트 "조직 변경" 섹션의 서술(`report_write`).

**기본 등급**(`modules/improvement`의 시작 등급. 현재 등급은 `company.yaml:actions`). `improvement.merge` T1(`replay-gain` + `canary-clean` 게이트, 평가기 `replay`, 더 승격 없음). `governance.exec-definition-change`(CEO·COO·검증 정의에 닿는 모든 것) T3 영구, 커널이 경로로도 T3 강제. 브랜치 위 초안과 기록 읽기는 별도 행동 없이 티켓 작업.

**팀 구성.** 여러 실패 패턴을 병렬로 초안할 가치가 있으면 가설당 주니어 1명, 각자 자기 워크트리에서. 리플레이 점수는 주니어가 아니라 커널이 계산.

**평가 지표.** 릴리스당 순 평가 상승, 카나리에 잡힌 퇴보, 게이트에서 반려된 제안(적당한 비율이 건강함. 0이면 충분히 시도하지 않는다는 뜻).
