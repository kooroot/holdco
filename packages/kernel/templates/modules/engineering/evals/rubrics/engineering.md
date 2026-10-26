# Rubric — Engineering

> 🔒 Locked. / 🔒 잠금.

Scores 0–4 per dimension (1 and 3 are intermediates). **Mechanical gates** must pass before any scoring and are recorded in the Verdict's `gates`; a failed gate is an automatic `reject`. Gates must work on a fresh company: no CI and no replay suite is not a failure.
항목별 0~4점(1·3은 중간값). **기계적 게이트**를 먼저 통과해야 채점하며 판정서 `gates`에 기록합니다. 게이트 실패는 자동 `reject`. 새 회사(CI·리플레이 없음)에서도 동작해야 합니다.

## #app — application code

| Gate (mechanical) | Check |
|---|---|
| `ci-green` | If the project has a remote with checks: all required checks green on the branch head. Otherwise: every test or command named in `done_criteria` plus the repository's own test command pass in the Verification worktree; quote the output as evidence |
| Done criteria | Every `done_criteria` item that names a test or command passes when run by Verification |
| Replay | No regression on the engineering replay suite; **skipped and noted while the suite is empty** |
| Scope | `git diff --stat <default branch>...HEAD` touches only paths implied by `done_criteria` and the senior's note |

| Dimension | Weight | 4 | 2 | 0 |
|---|---|---|---|---|
| Correctness | 0.40 | Meets all criteria, handles stated edge cases | Meets criteria, misses an obvious edge case | Does not do what the ticket asks |
| Tests | 0.25 | New behavior covered, including failure paths | Happy path only | No tests for new behavior |
| Scope discipline | 0.15 | Nothing beyond the ticket | Minor incidental changes | Unrelated refactors or features |
| Assumptions surfaced | 0.10 | All non-obvious decisions listed in PR | Some listed | Silent guesses found by reviewer |
| Rollback note | 0.10 | Concrete, tested revert path | Vague | Missing |

Approve if overall ≥ 3.0 and no dimension at 0.
통과 기준: 종합 3.0 이상, 0점 항목 없음.

## #docs — documentation only

| Dimension | Weight | 4 | 0 |
|---|---|---|---|
| Accuracy | 0.5 | Every command and path verified to work | Instructions that fail |
| Completeness for the stated reader | 0.3 | Reader can finish the task unaided | Key step missing |
| Scope | 0.2 | Docs only | Code changed |

Approve if overall ≥ 3.0.

## 한국어 요약

- **#app**: 기계적 게이트(`ci-green`: 체크가 있는 원격이면 그 상태, 없으면 완료 기준의 명령과 레포 테스트 명령을 검증 워크트리에서 실행. 완료 기준 명령 실행. 리플레이 무회귀는 세트가 비어 있으면 건너뛰고 기록. diff가 완료 기준과 시니어 노트가 암시하는 경로 안) 통과 후 정확성(0.40), 테스트(0.25), 범위 준수(0.15), 가정 공개(0.10), 롤백 노트(0.10)로 채점
- **#docs**: 정확성(0.5, 모든 명령과 경로가 실제로 동작), 대상 독자 기준 완결성(0.3), 범위(0.2, 문서만 변경)
