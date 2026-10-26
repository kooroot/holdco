# 06 — Roadmap, Tests, Risks

---

## English

### Milestones

Each milestone ends with something that runs and an exit check that can fail.

| # | Milestone | Deliverables | Exit criteria |
|---|---|---|---|
| M0 | Spec + enforcement | Spec; compiled hook; two-repository guard; protocol schemas; config schema; effective and diff-based tier; graduation check; CLI | **Done.** |
| M1 | Kernel / template split + engines | `packages/kernel` with `templates/{base,modules,presets}`; placeholders replaced by `company.yaml` references; `module.yaml` per module; scaffold; `engines` + `roles` config; engine contract and compensations; `@holdco/engine-claude`, `@holdco/engine-codex`; Codex host probe in doctor | **Done.** Examples are generated from presets and checked by a test; no `${…}` left; every preset scaffolds a valid repo; Codex sandbox verified against the CLI; 275 tests |
| M2 | State and Operator CLI | SQLite store (`bun:sqlite`); ticket state machine with a legal-transition table, events and approval stages; `status`, `ticket new/list/show/unblock/decline`, `inbox`, `interrupt`, `resume`, `audit`, `digest`, `release`, `promote`, `rollback`, `project add`; terminal requirement for loosening commands | **Done.** Illegal transitions throw; every transition leaves an event; CLI tested end to end on a scaffolded company. Property-based sequence tests remain to be added |
| M3 | Supervisor core | Services and layers; boot recovery; session gate; pipeline dispatch for every state (D25); per-session worktrees (D22); sessions built from the release tag (D23); leases with attempt limits; the company MCP endpoint with per-session tokens (D36); `delegate_start` / `delegate_wait` (D37); `Sessions` choosing the adapter from `roles`; host credential deny list (D42); ledger; active interrupts with pause flags and one-shot L4; every tripwire detector (D27); challenge window and rollback; kernel-rendered digest; notifier; heartbeat; executors (D14) and the matching spec change in `operations.md` | **Done except the live part.** `holdco supervise` runs; simulated runs with a scripted engine over real git and real MCP cover the happy path with a junior, crash → retry → blocked → inbox, Verification rejection, L2 interrupt and resume, budget exhaustion, boot recovery, and dual control with the judge and COO on a second engine. Written in plain async TypeScript with an injected clock (D43); not yet an Effect `Layer` program. Still open: R1 spike; one live smoke session per engine with a $1 cap, including the Codex `blocked` event (R8a); spend-spike tripwire needs 24h of baseline |
| M4 | Wizard, services, publish | `create-holdco` is one shot today (scaffold → install → guard → doctor, first project registered, strategy rendered); still to do: the interactive wizard (engines, models per role), systemd and launchd files, npm publish of `@holdco/*` | In a clean directory, `bunx create-holdco --preset solo-dev --yes` ends with doctor passing, on Linux and macOS (including the Codex probe on macOS, R8b) |
| M5 | Dogfood | One real project, conservative tiers, two weeks | Weekly audits completed; agreement measured; inbox load trend recorded; incidents written up |
| M6 | Improvement and dual control | Replay runner, release gate, canary injection, COO review job, graduation proposals | A seeded regression is rejected by the gate; a seeded canary is caught; an approved promotion lands in `company.yaml` |
| M7 | Hardening and reach | Separate OS user or container for sessions (R5); more engines behind the same contract; Rust hook only if latency matters | Sessions cannot write the company repo even without the sandbox; a third engine passes the compensation test and runs a ticket end to end |

M5 needs a real project. The Operator's current main project is the natural candidate.

### Test strategy

| Level | What | How |
|---|---|---|
| Pure policy | guard, interrupts, effective tier, composition rules | unit tests (exist) |
| Contracts | brief, return, verdict, session report, config | schema tests with documented accept/reject cases (exist for brief, return, config) |
| State machine | ticket transitions, leases | property-based tests with generated sequences |
| Supervisor | dispatch, recovery, budget, interrupts, schedules | simulation: `TestClock` + in-memory SQLite + scripted fake `Sessions`; one simulated week per run |
| Enforcement | hook binary, sandbox, managed settings | binary matrix (exists); M3 live checks that blocked writes really fail |
| End to end | one ticket through a real session | gated behind an env flag; real API key; `maxBudgetUsd: 1` |

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| An engine SDK or CLI changes its options or result shape | medium | high | Pin exact SDK versions per engine package; all SDK use behind `Engine`; typechecked against the installed SDK; Codex `--strict-config` probe on every doctor run |
| One provider degrades or changes terms | medium | medium | Roles can move to the other engine by editing `company.yaml`; presets exist for each |
| Managed settings filter out our deny rules (R1) | medium | medium | Sandbox and in-process hook already cover; M3 spike decides |
| Real token cost far above estimates | medium | high | Start with low caps; per-session cap; provider cap; ledger alerts at 80% |
| Evaluator agreement never reaches graduation | medium | medium | That is the safe failure: the company stays gated; fix rubrics first |
| Operator stops doing audits | high | high | Audit-watch freezes graduation and improvement; inbox load is a tracked metric |
| Effect 4 API churn (new major line) | low | medium | Pin exact versions; types are checked in CI |
| Scope creep before dogfooding | high | medium | No M6 work before M5 has two weeks of data |

---

## 한국어

### 마일스톤

각 마일스톤은 실제로 돌아가는 무언가와, 실패할 수 있는 완료 검사로 끝납니다.

| # | 마일스톤 | 산출물 | 완료 기준 |
|---|---|---|---|
| M0 | 명세 + 집행 | 명세, 컴파일 훅, 두 레포 가드, 프로토콜 스키마, 설정 스키마, 실효·diff 기반 등급, 승격 검사, CLI | **완료.** |
| M1 | 커널·템플릿 분리 + 엔진 | 템플릿을 품은 `packages/kernel`, 플레이스홀더를 `company.yaml` 참조로 교체, 모듈별 `module.yaml`, 스캐폴드, `engines`·`roles` 설정, 엔진 계약과 보완책, `@holdco/engine-claude`·`@holdco/engine-codex`, doctor의 Codex 호스트 실측 | **완료.** 예시는 프리셋에서 생성되고 테스트로 확인, `${…}` 없음, 모든 프리셋이 유효한 레포를 만듦, 실제 CLI로 Codex 샌드박스 확인, 테스트 275개 |
| M2 | 상태와 운영자 CLI | SQLite 저장소(`bun:sqlite`), 허용 전이 표·이벤트·승인 단계가 있는 티켓 상태 머신, `status`·`ticket`·`inbox`·`interrupt`·`resume`·`audit`·`digest`·`release`·`promote`·`rollback`·`project add`, 느슨하게 하는 명령의 터미널 요구 | **완료.** 불법 전이는 예외, 모든 전이가 이벤트를 남김, 스캐폴드한 회사에서 CLI 종단 테스트. 속성 기반 순서 테스트는 추가 예정 |
| M3 | 슈퍼바이저 핵심 | 서비스와 레이어, 부팅 복구, 세션 관문, 모든 상태의 파이프라인 배분(D25), 세션별 워크트리(D22), 릴리스 태그 기반 세션 조립(D23), 시도 한도가 있는 임대, 세션별 토큰이 붙은 회사 MCP 엔드포인트(D36), `delegate_start`·`delegate_wait`(D37), `roles`로 어댑터를 고르는 `Sessions`, 호스트 자격 증명 차단 목록(D42), 원장, 일시정지 표시와 일회성 L4가 있는 능동 인터럽트, 모든 트립와이어 감지기(D27), 이의제기 창과 롤백, 커널 렌더링 다이제스트, 알림, 하트비트, 실행기(D14)와 그에 맞춘 `operations.md` 명세 수정 | **실사용 부분만 남고 완료.** `holdco supervise`가 돕니다. 실제 git과 실제 MCP 위에서 스크립트 엔진으로 주니어가 포함된 정상 경로, 크래시 → 재시도 → blocked → 인박스, 검증 반려, L2 인터럽트와 재개, 예산 소진, 부팅 복구, 심판과 COO를 두 번째 엔진에 둔 이중 통제를 시뮬레이션했습니다. 주입된 시계를 쓰는 평범한 비동기 TypeScript로 작성(D43), 아직 Effect `Layer` 프로그램은 아님. 남은 것: R1 스파이크, 엔진마다 1달러 상한 실제 세션 1회(Codex `blocked` 이벤트 포함, R8a) |
| M4 | 마법사, 서비스, 배포 | `create-holdco`는 지금 한 번에 끝남(스캐폴드 → 설치 → 가드 → doctor, 첫 프로젝트 등록, 전략 렌더링). 남은 것: 대화형 마법사(엔진, 역할별 모델), systemd·launchd 파일, `@holdco/*` npm 배포 | 빈 디렉터리에서 `bunx create-holdco --preset solo-dev --yes`가 doctor 통과로 끝남(Linux, macOS 모두, macOS의 Codex 실측 포함, R8b) |
| M5 | 실사용 | 실제 프로젝트 하나, 보수적 등급, 2주 | 주간 감사 수행, 일치율 측정, 인박스 부하 추이 기록, 사고 기록 |
| M6 | 개선과 이중 통제 | 리플레이 실행기, 릴리스 게이트, 카나리 주입, COO 검토 작업, 승격 제안 | 심어둔 퇴보가 게이트에서 반려되고, 심어둔 카나리가 잡히고, 승인된 승격이 `company.yaml`에 반영됨 |
| M7 | 강화와 확장 | 세션용 별도 OS 사용자나 컨테이너(R5), 같은 계약 뒤의 엔진 추가, 지연이 문제될 때만 Rust 훅 | 샌드박스 없이도 세션이 회사 레포에 쓰지 못함, 세 번째 엔진이 보완책 테스트를 통과하고 티켓 하나를 끝까지 처리 |

M5에는 실제 프로젝트가 필요합니다. 지금의 주력 프로젝트가 자연스러운 후보입니다.

### 테스트 전략

순수 정책(가드, 인터럽트, 실효 등급, 구성 규칙)은 단위 테스트, 계약(지시서, 반환서, 판정, 세션 보고서, 설정)은 문서화된 허용·반려 케이스 테스트, 상태 머신은 속성 기반 테스트, 슈퍼바이저는 `TestClock` + 메모리 SQLite + 가짜 `Sessions`로 일주일 시뮬레이션, 집행 장치는 바이너리 매트릭스와 M3의 실제 차단 확인, 종단 간은 환경 플래그 뒤에서 실제 API 키와 1달러 상한으로 돌립니다.

### 위험

위 표와 같습니다. 엔진 SDK·CLI 변경은 엔진 패키지별 정확한 버전 고정, 설치된 SDK 기준 타입 검사, doctor마다 돌리는 Codex `--strict-config` 실측으로, 한 제공사의 장애나 조건 변경은 `company.yaml`에서 역할을 다른 엔진으로 옮기는 것으로 대응합니다. 가장 가능성 높고 영향이 큰 위험은 **운영자가 감사를 그만두는 것**이며, 감사 감시가 승격과 개선을 동결하고 인박스 부하를 지표로 추적하는 것으로 대응합니다. 그다음은 실사용 전에 범위가 늘어나는 것인데, M5에서 2주 데이터가 쌓이기 전에는 M6 작업을 하지 않는 것으로 막습니다.
