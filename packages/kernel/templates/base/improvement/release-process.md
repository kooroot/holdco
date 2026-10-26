# Release Process — How the Organization Changes

> ✏️ Improvement may propose changes, but the merge gate in §2 may only be loosened by the Operator.
> ✏️ 개선팀이 변경을 제안할 수 있지만, §2의 머지 게이트를 완화하는 건 운영자만 할 수 있습니다.

---

## English

Agents improve continuously, but the organization changes only as a **tagged release**. Sessions always read `org/`, `protocols/` and `improvement/` from the latest release tag, never from the working tree, so a merge is invisible until a release is tagged, and every release is a clean rollback point (L4).

### 1. Releases

- `holdco init` tags `r0`. Every later release is `r<n>` (`r1`, `r2`, ...), tagged by the kernel's release job at `company.yaml:policy.release` (`day`, `at`) or on demand with `holdco release`.
- An `improvement.merge` that passes the gate is merged by the merge executor into the default branch and marks the company `release_pending`; the release job tags within a day. Several merges in one day ship as one release.
- Improvement works on `imp/<id>` branches in worktrees cut from the latest tag; the ticket is one hypothesis.
- There is no `release/next` branch and no fixed weekday rhythm beyond `policy.release`.

### 2. Merge gate (per `improvement.merge`)

The kernel checks these when the ticket reaches `verified`; a gate that is not evidenced sends the ticket back to the senior.

| Condition | Default | Checked by |
|---|---|---|
| `verification-approved` | Verdict `approve` on the branch head | Verification |
| `replay-gain`: overall replay score improves | ≥ `company.yaml:policy.release.min_gain` (+2%) on the target department | release job; **skipped and noted while `evals/replay` is empty** |
| No dimension regresses | no dimension drops more than `company.yaml:policy.release.max_regression` (−1%) | release job, part of `replay-gain` |
| `canary-clean` | no canary approved and no tripwire attributable to the change | release job; skipped and noted without canary history |
| Touches only editable paths | no change under locked paths | kernel (`tierForChange`): a locked path makes the merge T3 |
| One hypothesis per ticket | a single diagnosed failure pattern | Verification (rubric) |

A merge touching `org/ceo.md`, `org/coo.md`, `org/departments/verification.md` or their role files (`org/roles/ceo.md`, `coo.md`, `verification-senior.md`) is T3 whatever the action id: it waits for the Operator in the inbox (`governance.exec-definition-change`).

### 3. Watch period

For `company.yaml:policy.release.watch` (default 3 days) after a release, any demotion or tripwire the kernel can attribute to the release raises **L4** automatically (`governance/interrupts.md` §3). `policy.release.canary_traffic` is reserved for a future per-definition canary; v1 ships every release to all traffic.

### 4. Rollback

- Automatic: the watch-period tripwire above → L4.
- Manual: the Operator issues `holdco interrupt L4 "*" --reason "<why>"` at any time.
- L4 is one-shot: the kernel restores `org/`, `protocols/`, `improvement/` from the previous tag, tags the result as a new release, and clears itself. New sessions read the restored definition at once.
- A rolled-back change cannot be resubmitted without a new diagnosis (a new ticket).

### 5. Digest entry

Every release writes the "Org changes" section of the weekly digest, rendered by the kernel from the record:

| Change | Department | Diagnosis | Replay before → after | Cost delta | Canary |

---

## 한국어

에이전트는 계속 개선되지만, 조직은 **태그 릴리스**로만 바뀝니다. 세션은 항상 최신 릴리스 태그의 `org/`, `protocols/`, `improvement/`를 읽고 작업 트리는 읽지 않으므로, 머지는 릴리스가 태그되기 전까지 보이지 않고 모든 릴리스가 깨끗한 롤백 지점(L4)이 됩니다.

### 1. 릴리스

- `holdco init`이 `r0`를 태그합니다. 이후 릴리스는 `r<n>`(`r1`, `r2`, ...)이며 커널의 릴리스 잡이 `company.yaml:policy.release`(`day`, `at`)에, 또는 `holdco release`로 즉시 태그합니다.
- 게이트를 통과한 `improvement.merge`는 머지 실행기가 기본 브랜치로 머지하고 회사를 `release_pending`으로 표시하며, 릴리스 잡이 하루 안에 태그합니다. 하루에 여러 머지는 하나의 릴리스로 나갑니다.
- 개선팀은 최신 태그에서 딴 워크트리의 `imp/<id>` 브랜치에서 작업하며 티켓 하나가 가설 하나입니다.
- `release/next` 브랜치도, `policy.release` 외의 고정 요일 리듬도 없습니다.

### 2. 머지 게이트 (`improvement.merge` 단위)

티켓이 `verified`가 될 때 커널이 확인하며, 증거 없는 게이트는 시니어에게 반려됩니다. `verification-approved`(검증 판정), `replay-gain`(대상 부서 +`min_gain` 이상, 어떤 항목도 `max_regression` 넘게 퇴보 없음. 릴리스 잡이 계산하며 **`evals/replay`가 비어 있으면 건너뛰고 기록**), `canary-clean`(변경에 기인한 카나리 승인·트립와이어 없음. 카나리 이력이 없으면 건너뛰고 기록), 잠긴 경로 무변경(커널 `tierForChange`, 잠긴 경로를 건드리면 T3), 티켓당 가설 하나(검증 루브릭).

`org/ceo.md`, `org/coo.md`, `org/departments/verification.md`와 그 역할 파일(`org/roles/ceo.md`, `coo.md`, `verification-senior.md`)을 건드리는 머지는 행동 ID와 무관하게 T3이며 인박스에서 운영자를 기다립니다(`governance.exec-definition-change`).

### 3. 감시 기간

릴리스 후 `company.yaml:policy.release.watch`(기본 3일) 동안 그 릴리스에 기인한다고 커널이 판단한 강등이나 트립와이어가 생기면 자동으로 **L4**(`governance/interrupts.md` §3). `policy.release.canary_traffic`은 향후 정의별 카나리용으로 예약되어 있고 v1은 모든 릴리스를 전체 트래픽에 내보냅니다.

### 4. 롤백

- 자동: 위 감시 기간 트립와이어 → L4
- 수동: 운영자가 언제든 `holdco interrupt L4 "*" --reason "<사유>"`
- L4는 일회성: 커널이 `org/`, `protocols/`, `improvement/`를 직전 태그로 복원하고 결과를 새 릴리스로 태그한 뒤 스스로 해제. 새 세션은 즉시 복원된 정의를 읽음
- 롤백된 변경은 새 진단(새 티켓) 없이 다시 제출할 수 없음

### 5. 다이제스트 기록

모든 릴리스는 주간 다이제스트의 "조직 변경" 섹션을 위 표 형식으로 남기며, 커널이 기록에서 렌더링합니다.
