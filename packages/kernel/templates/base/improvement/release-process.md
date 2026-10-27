# Release Process — How the Organization Changes

> ✏️ Improvement may propose changes, but the merge gate in §2 may only be loosened by the Operator.
> ✏️ 개선팀이 변경을 제안할 수 있지만, §2의 머지 게이트를 완화하는 건 운영자만 할 수 있습니다.

---

## English

Agents improve continuously, but the organization changes only as a **tagged release**. Sessions always read `org/`, `protocols/` and `improvement/` from the latest release tag, never from the working tree, so a merge is invisible until a release is tagged, and every release is a clean rollback point (L4).

### 1. Releases

- `holdco init` tags `r0`. Every later release is `r<n>` (`r1`, `r2`, ...). Releases are two-step: an `improvement.merge` that passes the gate is merged by the merge executor into the default branch and tagged at once as a **candidate** `rc-<n>`; after the watch period (§3) the kernel promotes it to `r<n>` or withdraws it. `holdco release` promotes the candidate immediately; `holdco release withdraw` withdraws it.
- One candidate at a time. A merge that lands while a candidate is under watch becomes the next candidate once this one is promoted.
- Improvement works on `imp/<id>` branches in worktrees cut from the latest tag; the ticket is one hypothesis.
- There is no `release/next` branch and no weekday rhythm; `policy.release.day`/`at` are kept for the digest's release notes.

### 2. Merge gate (per `improvement.merge`)

The kernel checks these when the ticket reaches `verified`; a gate that is not evidenced sends the ticket back to the senior.

| Condition | Default | Checked by |
|---|---|---|
| `verification-approved` | Verdict `approve` on the branch head | Verification |
| `replay-gain`: agreement with the Operator's labels improves | ≥ `company.yaml:policy.release.min_gain` (+2%) over the recorded verdicts, no action type regressing by more than `max_regression` | kernel replay gate, run on the candidate **when it changes the judge** (`evals/rubrics/`, the Verification charter or role file); **skipped and noted while no labeled ticket has a live branch** |
| `canary-clean` | candidate sessions' rejection rate ≤ baseline + `max_regression`, and no demotion during the watch | kernel candidate-watch (§3) |
| Touches only editable paths | no change under locked paths | kernel (`tierForChange`): a locked path makes the merge T3 |
| One hypothesis per ticket | a single diagnosed failure pattern | Verification (rubric) |

A merge touching `org/ceo.md`, `org/coo.md`, `org/departments/verification.md` or their role files (`org/roles/ceo.md`, `coo.md`, `verification-senior.md`) is T3 whatever the action id: it waits for the Operator in the inbox (`governance.exec-definition-change`).

### 3. Watch period

While a candidate `rc-<n>` exists, `company.yaml:policy.release.canary_traffic` (default 20%) of newly dispatched production sessions (department seniors and their juniors; never Verification, never the executives) run on the candidate organization; the rest keep the current release. Sessions are not told which one they run. After `policy.release.watch` (default 3 days) the candidate is promoted if its sessions' rejection rate is within `max_regression` of the rest and nothing was demoted; otherwise it is withdrawn: `org/`, `protocols/`, `improvement/`, `evals/` on the default branch revert to the release, and the Operator gets an urgent inbox item. A demotion during the watch also raises **L4** (`governance/interrupts.md` §3), which withdraws the candidate.

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

- `holdco init`이 `r0`를 태그합니다. 이후 릴리스는 `r<n>`(`r1`, `r2`, ...)이며 두 단계입니다. 게이트를 통과한 `improvement.merge`는 머지 실행기가 기본 브랜치로 머지하고 즉시 **후보** `rc-<n>`으로 태그되며, 감시 기간(§3) 뒤 커널이 `r<n>`으로 승격하거나 철회합니다. `holdco release`는 후보를 즉시 승격, `holdco release withdraw`는 철회합니다.
- 후보는 한 번에 하나. 감시 중에 들어온 머지는 이 후보가 승격된 뒤 다음 후보가 됩니다.
- 개선팀은 최신 태그에서 딴 워크트리의 `imp/<id>` 브랜치에서 작업하며 티켓 하나가 가설 하나입니다.
- `release/next` 브랜치도 요일 리듬도 없습니다. `policy.release.day`/`at`은 다이제스트의 릴리스 노트용입니다.

### 2. 머지 게이트 (`improvement.merge` 단위)

티켓이 `verified`가 될 때 커널이 확인하며, 증거 없는 게이트는 시니어에게 반려됩니다. `verification-approved`(검증 판정), `replay-gain`(운영자 라벨과의 일치율이 기록된 판정보다 `min_gain` 이상 상승, 행동 유형별 하락 `max_regression` 이하. 후보가 심판—`evals/rubrics/`, 검증 헌장·역할 파일—을 바꿀 때 커널의 리플레이 게이트가 계산하며, **살아 있는 브랜치를 가진 라벨 티켓이 없으면 건너뛰고 기록**), `canary-clean`(후보 세션의 반려율 ≤ 기준선 + `max_regression`, 감시 중 강등 없음. 커널의 후보 감시가 확인), 잠긴 경로 무변경(커널 `tierForChange`, 잠긴 경로를 건드리면 T3), 티켓당 가설 하나(검증 루브릭).

`org/ceo.md`, `org/coo.md`, `org/departments/verification.md`와 그 역할 파일(`org/roles/ceo.md`, `coo.md`, `verification-senior.md`)을 건드리는 머지는 행동 ID와 무관하게 T3이며 인박스에서 운영자를 기다립니다(`governance.exec-definition-change`).

### 3. 감시 기간

후보 `rc-<n>`이 있는 동안 새로 배분되는 생산 세션(부서 시니어와 그 주니어. 검증과 경영진은 제외)의 `company.yaml:policy.release.canary_traffic`(기본 20%)이 후보 조직으로 돌고 나머지는 현재 릴리스를 유지합니다. 세션은 자기가 어느 쪽인지 모릅니다. `policy.release.watch`(기본 3일) 뒤 후보 세션의 반려율이 나머지보다 `max_regression` 이상 나쁘지 않고 강등이 없으면 승격, 아니면 철회: 기본 브랜치의 `org/`, `protocols/`, `improvement/`, `evals/`를 릴리스로 되돌리고 운영자에게 긴급 인박스 항목이 갑니다. 감시 중 강등은 **L4**(`governance/interrupts.md` §3)도 걸며, L4는 후보를 철회합니다.

### 4. 롤백

- 자동: 위 감시 기간 트립와이어 → L4
- 수동: 운영자가 언제든 `holdco interrupt L4 "*" --reason "<사유>"`
- L4는 일회성: 커널이 `org/`, `protocols/`, `improvement/`를 직전 태그로 복원하고 결과를 새 릴리스로 태그한 뒤 스스로 해제. 새 세션은 즉시 복원된 정의를 읽음
- 롤백된 변경은 새 진단(새 티켓) 없이 다시 제출할 수 없음

### 5. 다이제스트 기록

모든 릴리스는 주간 다이제스트의 "조직 변경" 섹션을 위 표 형식으로 남기며, 커널이 기록에서 렌더링합니다.
