# Rubric — Verification & Security

> 🔒 Locked. / 🔒 잠금.

Verification's verdicts are judged by the Operator's blind grading (calibration). This file defines the extra security review used for high-risk changes.
검증 부서의 판정 자체는 운영자의 블라인드 채점(보정)으로 평가됩니다. 이 파일은 고위험 변경에 쓰는 추가 보안 리뷰를 정의합니다.

## #security — smart contracts and security-critical code

Scores 0–4 per dimension (1 and 3 are intermediates). Gates are recorded in the Verdict's `gates` and must work on a fresh company.

| Gate (mechanical) | Check |
|---|---|
| `ci-green` | When the prompt says the kernel ran the project's verify command with exit 0, that is this gate: record it passed and do not run the repository's test command again. Otherwise every test or command named in `done_criteria` plus the repository's own test command pass in the Verification worktree |
| Static analysis | The analyzers named in the project's `AGENTS.md` report no unresolved high/critical findings; **none configured → skipped and noted** |
| Negative-path tests | Each stated invariant has at least one test that tries to break it and confirms it fails safely (Verification writes the missing ones itself) |
| Replay | No regression on the verification replay suite; **skipped and noted while the suite is empty** |

| Dimension | Weight | 4 | 2 | 0 |
|---|---|---|---|---|
| Invariants stated | 0.25 | All security invariants written in the PR | Some | None |
| Negative coverage | 0.30 | Every invariant attacked by a test (replay, overflow, access control, reentrancy, etc. as relevant) | Some attacked | Only happy paths |
| Access control | 0.20 | Every privileged path enumerated and tested | Partially | Unreviewed |
| Upgrade / admin risk | 0.15 | Admin powers listed with their blast radius | Mentioned | Ignored |
| Findings report | 0.10 | Severity, location, reproduction for each | Incomplete | Missing |

**Threshold.** `approve` = every gate passed, overall ≥ 3.0, and no dimension at 0; otherwise `reject` with each finding as a failure (severity, location, reproduction in the evidence). Changes scored here are always T3 (`code.merge.critical`, `graduation: never`): an approve only moves the ticket to the Operator's inbox, and the Operator still decides the merge. The rubric informs that decision; it never replaces it.

## 한국어 요약

항목별 0~4점(1·3은 중간값). 기계적 게이트(`ci-green`: 프롬프트에 커널이 검증 명령을 exit 0으로 돌렸다고 적혀 있으면 그게 이 게이트 — 통과로 기록하고 다시 돌리지 않음; 아니면 완료 기준의 명령과 레포 테스트 명령 실행. 프로젝트 `AGENTS.md`가 지정한 정적 분석기에 미해결 high/critical 없음, 지정된 분석기가 없으면 건너뛰고 기록. 명시된 불변식마다 깨뜨리려 시도하는 부정 경로 테스트(없으면 검증이 직접 작성). 리플레이 무회귀는 세트가 비어 있으면 건너뛰고 기록) 후 불변식 명시(0.25), 부정 경로 커버리지(0.30), 접근 제어(0.20), 업그레이드·관리자 위험(0.15), 발견 사항 보고(0.10)로 채점. **통과 기준**: 모든 게이트 통과, 종합 3.0 이상, 0점 항목 없음. 아니면 발견 사항마다 실패로 `reject`. 여기서 채점되는 변경은 항상 T3이며 approve는 운영자 인박스로 보낼 뿐, 머지는 운영자가 결정합니다.
