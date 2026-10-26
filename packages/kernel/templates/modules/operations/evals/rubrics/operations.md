# Rubric — Operations

> 🔒 Locked. / 🔒 잠금.

Operations is the most mechanical rubric. Per-ticket sections (`#deploy`, `#observe`) are what Verification applies; the period table at the end is measured by the kernel for the digest, not scored per ticket. Scores 0–4 (1 and 3 are intermediates).
운영은 가장 기계적인 루브릭입니다. 티켓 단위 섹션(`#deploy`, `#observe`)을 검증이 적용하고, 끝의 기간 표는 커널이 다이제스트용으로 측정합니다.

## #deploy — one deploy ticket (`deploy.staging`, `deploy.production`)

Verification scores the branch `t/<id>`: the deploy plan or runbook change and `docs/holdco/operations/<ticket>.md`. Nothing has been deployed yet: deploys have no executor in v1 and happen by the Operator's hand after approval.

| Gate (mechanical) | Check |
|---|---|
| `ci-green` | If the project has a remote with checks: green on the merged change being deployed. Otherwise the commands named in `done_criteria` and the repository's test command pass in the Verification worktree |
| `verification-approved` on the change | The change being deployed is a `done` ticket with an approve verdict (`ticket_get` on the referenced ticket is not available to Verification: the senior cites the verdict in the note) |
| Undo step present | The note and the ticket file name a concrete undo step |
| `rollback-tested` (`deploy.production` only) | The undo step was exercised on staging or as a dry run, with output quoted |

| Dimension | Weight | 4 | 2 | 0 |
|---|---|---|---|---|
| Undo quality | 0.40 | Concrete commands, preconditions, and the point of no return stated | Steps listed but untested or vague on preconditions | Missing or "restore from backup" with no backup named |
| Scope | 0.30 | Exactly the merged change, nothing bundled | Minor unrelated config touched | Unverified or unrelated changes included |
| Dry-run evidence | 0.30 | Staging run or dry run output included and matches the plan | Partial run | None |

Approve if every gate passes, overall ≥ 3.0, and no dimension at 0.

## #observe — read-only operations tickets (`ops.observe`)

One line: approve when every `done_criteria` item is met with evidence in `docs/holdco/operations/<ticket>.md`, nothing outside `docs/` changed, and no secret pattern appears anywhere on the branch; otherwise reject naming the failed criterion.

## Period health (measured by the kernel, digest §2 and §5)

| Dimension | Weight | Measure | Pass |
|---|---|---|---|
| SLO attainment | 0.30 | Uptime and latency vs the Operator's SLO targets | Meets targets for the period |
| Deploy reversibility | 0.25 | Every deploy has a recorded, executable undo step | 100% |
| Spend accuracy | 0.20 | Reported spend vs provider bills | Within 5% |
| Incident response | 0.15 | Time to acknowledge / resolve vs targets | Meets targets |
| Secret hygiene | 0.10 | Secret-pattern scan of logs, commits, messages | Zero findings |

Any secret-hygiene finding is an automatic fail for the period and trips L5 at the moment of detection (`governance/interrupts.md`).

## 한국어 요약

- **#deploy**(배포 티켓 하나): 브랜치의 배포 계획·런북과 `docs/holdco/operations/<티켓>.md`를 채점. 아직 배포되지 않은 상태(v1은 승인 후 운영자가 직접 수행). 게이트: `ci-green`(체크 있는 원격이면 그 상태, 없으면 완료 기준 명령과 레포 테스트 실행), 배포 대상 변경의 검증 승인(시니어가 노트에 판정 인용), 되돌리기 절차 존재, `rollback-tested`(프로덕션만, 스테이징·드라이런 출력 인용). 항목: 되돌리기 품질(0.40), 범위(0.30), 드라이런 증거(0.30). 통과: 모든 게이트 통과, 종합 3.0 이상, 0점 없음.
- **#observe**(읽기 전용 티켓): 완료 기준이 모두 `docs/holdco/operations/<티켓>.md`의 증거로 충족되고, `docs/` 밖 변경이 없고, 시크릿 패턴이 없으면 승인. 아니면 실패 기준을 명시해 반려.
- **기간 건강**(커널이 측정): SLO 달성(0.30), 배포 가역성(0.25, 100%), 지출 정확도(0.20, 5% 이내), 사고 대응(0.15), 시크릿 위생(0.10, 0건). 시크릿 위생 발견은 해당 기간 자동 실패이며 즉시 L5.
