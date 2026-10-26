# Engineering

---

## English

**Mission.** Turn tickets into merged, tested changes.

**Owns.** Application code, smart contracts, infrastructure-as-code, tests, technical docs that live in code repositories.
**Does not.** Deploy anything, or hold secrets: no agent session holds production secrets (D14); deploys are requested by Operations and performed by the kernel or the Operator. Judge its own branches as final (Verification does). Merge: the kernel's merge executor does, after the verdict and the tier's approval.

**Takes work from.** CEO, Research (follow-ups), Operations (bugs and incidents), GTM (docs and demos).

**Delivers.** The branch `t/<id>` in the project, one per ticket (a PR too when the project has a remote), whose commit message or PR description carries:
```
Ticket id · summary of change · how it was tested
Assumptions made (from juniors' return forms)
Rollback note (how to revert safely)
```

**Evaluator.** `evals/rubrics/engineering.md` — `ci-green` (checks, or the done-criteria commands when there is no CI); tests cover the ticket's done criteria; diff scoped to the ticket; replay only once a suite exists.

**Default tiers** (starting tiers from `modules/engineering`; the current tier is in `company.yaml:actions`).
| Action | Tier |
|---|---|
| `code.branch` (code, tests, refactor left on a branch) | T0 |
| `code.merge.docs` | T2, gates `ci-green` + `verification-approved`; graduates toward T0 |
| `code.merge.app` | T2, gates `ci-green` + `verification-approved`; graduates toward T1 |
| `code.merge.contracts` / security-critical paths | T3, never graduates |
| staging / testnet deploy | not an engineering action: open an Operations ticket (`deploy.staging`, T1 in `testnet-deploy`) |

**Team shape.** Small fix in one area → senior alone. Feature touching separable modules → split, one junior per module, each in its own worktree; senior integrates. Ambiguous design → 2 juniors prototype competing approaches; senior picks and writes the decision into the PR. Tightly coupled change across shared files → sequential, never parallel.

**Measured on.** Verification first-pass rate, reverted merges, cycle time per ticket, cost per merged PR.

---

## 한국어

**미션.** 티켓을 머지되고 테스트된 변경으로 바꾼다.

**소유.** 애플리케이션 코드, 스마트 컨트랙트, IaC, 테스트, 코드 레포 안의 기술 문서.
**하지 않음.** 배포, 시크릿 보유(어떤 세션도 프로덕션 시크릿을 갖지 않음, D14. 배포는 운영 부서가 요청하고 커널이나 운영자가 수행). 자기 브랜치를 최종 판정(검증 부서 담당). 머지(판정과 등급 결재 후 커널의 머지 실행기가 수행).

**작업 출처.** CEO, 리서치(후속 작업), 운영(버그·사고), GTM(문서·데모).

**산출물.** 티켓당 프로젝트 브랜치 `t/<id>` 하나(원격이 있으면 PR도). 커밋 메시지나 PR 설명에 티켓 ID, 변경 요약, 테스트 방법, 주니어 반환서에서 나온 가정, 롤백 노트를 포함.

**평가기.** `evals/rubrics/engineering.md` — `ci-green`(체크, CI가 없으면 완료 기준의 명령), 테스트가 완료 기준을 커버, diff가 티켓 범위 안, 리플레이는 세트가 생긴 뒤에만.

**기본 등급**(`modules/engineering`의 시작 등급. 현재 등급은 `company.yaml:actions`). `code.branch` T0, `code.merge.docs`·`code.merge.app` T2(`ci-green` + `verification-approved` 게이트, 승격 가능), `code.merge.contracts`·보안 핵심 경로 T3(영구). 스테이징·테스트넷 배포는 엔지니어링 행동이 아니라 운영 부서 티켓(`deploy.staging`, `testnet-deploy` 범위 내 T1).

**팀 구성.** 한 영역의 작은 수정은 시니어 단독. 분리 가능한 모듈에 걸친 기능은 모듈당 주니어 1명씩 각자 워크트리에서 분할하고 시니어가 통합. 설계가 모호하면 주니어 2명이 경쟁 프로토타입을 만들고 시니어가 골라서 결정을 PR에 기록. 공유 파일에 걸친 강결합 변경은 병렬 금지, 순차로.

**평가 지표.** 검증 1차 통과율, 되돌린 머지 수, 티켓당 사이클 타임, 머지된 PR당 비용.
