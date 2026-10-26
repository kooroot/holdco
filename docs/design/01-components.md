# 01 — Components: Required and Optional

---

## English

### The test

Every component is classified by two questions.

1. **Does removing it break one of the invariants below?** If yes, it is required.
2. **Does removing it make the company stricter?** An optional component, when off, must route its work toward *more* human approval. If turning something off loosens the company, it was required, or its fallback is wrong.

### The five invariants

| # | Invariant | Meaning |
|---|---|---|
| I1 | Human final control | A human sets the standards and can stop everything at any time |
| I2 | Production and judgment are separate | No one scores their own output |
| I3 | Enforcement agents cannot bypass | Limits and locks are enforced outside an agent's reach |
| I4 | Traceable and recoverable | Every action is recorded and can be undone |
| I5 | Progress without the human | Work continues when nobody is watching |

### Class 1 — Required, fixed (cannot be turned off; shape is not configurable)

| Component | Guards | Without it |
|---|---|---|
| Operator (board) | I1 | No one is accountable |
| Constitution + action policy | I1, I3 | No standard for what may be done unasked |
| Supervisor | I5, I3 | A human must start every session; nobody enforces time and budget |
| Enforcement (locks, interrupts, sandbox) | I3, I1 | Locks depend on prompts; Improvement can edit its own evaluator |
| Verification (the judge) | I2 | Self-grading, or no evaluator so every action needs a human |
| Tickets, state store, action log | I4, I5 | No crash recovery; no record of what happened |
| Contracts (ticket, verdict, brief, return) | I2, I4 | Handoffs become prose; intent leaks |
| Release tags and rollback | I4 | Organization changes cannot be undone |

### Class 2 — Required, adjustable (always present; strength is chosen; kernel floors apply)

| Component | Adjustable | Floor (not configurable) |
|---|---|---|
| Budget | Monthly cap, department shares, session cap | Monthly and session caps must be set; provider-side hard cap strongly recommended (doctor warns) |
| Alert channel | Telegram, Slack, webhook | At least one; doctor sends a real test message |
| Approval inbox | Batch time, timeout | Default on timeout is **reject**, fixed |
| Tripwires | Spend spike multiple, loop threshold | Locked-path attempts and secret leaks always trip |
| Verification depth | Models, sampling, security review scope | Mechanical gates (tests, schemas) always run; judge (engine, model) ≠ every producer's |
| Operator audit | Day, sample size | Weekly, ≥ 5 samples; missing it N times freezes graduation and improvement |
| Graduation thresholds | Samples, agreement | ≥ 20 samples, agreement ≥ 0.9; always also: last 10 labels agree, no rollback, no missed canary, not frozen |

### Class 3 — Optional (can be off; off means stricter)

| Component | When off | When on, also requires |
|---|---|---|
| CEO | The Operator writes tickets; the supervisor dispatches by priority | Strategy document |
| COO | No second key: every T2 action runs as T3 (Operator approval) | CEO; canary rate ≥ 1%; model different from the CEO's |
| Research / Engineering / GTM departments | Their action types leave the registry; no tickets can target them | A rubric per department, or its actions stay ≥ T2. GTM also needs the voice guide |
| Operations department | No agent action reaches production; the Operator deploys | Executors with recorded undo steps (D14) |
| Improvement | The organization stays fixed: safe, but it does not get better | Replay set, release gate; dormant until enough labels (D20) |
| Auto-graduation | Every action stays at its starting tier | Verification + Operator labels + audit |
| Juniors | Seniors work alone: cheaper, slower on large tasks | Worktree confinement, max per task |
| Custom department | — | Charter; a rubric written by the Operator; ≥ T2 until it exists |

### Composition rules

1. **At least one producing department.** The kernel produces nothing.
2. **Turning an option off always falls back to something stricter.** The "When off" column is that fallback.
3. **Missing dependencies refuse to start.** A COO without canaries, an action owned by a disabled department, a judge sharing a producer's engine and model: `config check`, `init` and `doctor` all reject it. Improvement without enough labeled replay tickets is not rejected; it stays dormant (D20) and doctor reports it.

### How the classes map onto the product

| Class | Lives in | Who changes it |
|---|---|---|
| Required, fixed | Kernel package | Package releases only |
| Required, adjustable | `company.yaml` (with floors in the kernel) | Operator |
| Optional | `company.yaml` switches + module templates copied into the repo | Operator turns on/off; Improvement evolves the copied files |

---

## 한국어

### 판정 기준

모든 구성요소를 두 질문으로 분류합니다.

1. **빼면 아래 불변식 중 하나가 깨지는가?** 깨지면 필수입니다.
2. **빼면 회사가 더 엄격해지는가?** 옵션은 꺼졌을 때 그 일이 반드시 사람 결재가 늘어나는 쪽으로 넘어가야 합니다. 끄는데 회사가 느슨해진다면 그건 필수였거나 대체 경로가 잘못된 것입니다.

### 다섯 불변식

| # | 불변식 | 뜻 |
|---|---|---|
| I1 | 사람의 최종 통제 | 사람이 기준을 정하고 언제든 전부 멈출 수 있다 |
| I2 | 생산과 판정의 분리 | 누구도 자기 결과를 채점하지 않는다 |
| I3 | 우회 불가능한 집행 | 한도와 잠금은 에이전트의 손이 닿지 않는 곳에서 집행된다 |
| I4 | 추적과 복구 | 모든 행동은 기록되고 되돌릴 수 있다 |
| I5 | 무인 진행 | 아무도 보지 않아도 일이 계속된다 |

### 1등급 — 필수·고정 (끌 수 없고 형태도 고정)

운영자, 헌법과 행동 정책, 슈퍼바이저, 집행 장치(잠금·인터럽트·샌드박스), 검증(판정자), 티켓·상태 저장소·행동 로그, 계약 스키마(티켓·판정·지시서·반환서), 릴리스 태그와 롤백. 각 항목이 지키는 불변식과 없을 때 벌어지는 일은 위 표와 같습니다.

### 2등급 — 필수·강도 설정 (항상 있고 세기를 고름, 커널 하한 적용)

| 구성요소 | 조정 가능 | 하한 (설정 불가) |
|---|---|---|
| 예산 | 월 상한, 부서 배분, 세션 상한 | 월·세션 상한 필수. 제공사 하드 한도 강력 권장(doctor 경고) |
| 알림 채널 | Telegram, Slack, webhook | 최소 1개, doctor가 실제 테스트 메시지 발송 |
| 승인 인박스 | 묶음 시각, 시한 | 시한 초과 시 기본값은 **거절**, 고정 |
| 트립와이어 | 지출 급증 배수, 루프 임계값 | 잠긴 경로 시도와 시크릿 유출은 항상 발동 |
| 검증 깊이 | 모델, 샘플링, 보안 리뷰 범위 | 기계적 게이트는 항상 실행, 판정자 모델 ≠ 시니어·주니어 모델 |
| 운영자 감사 | 요일, 샘플 수 | 주 1회 5개 이상, N번 건너뛰면 승격·개선 동결 |
| 승격 기준 | 샘플 수, 일치율 | 샘플 20개 이상, 일치율 0.9 이상. 항상 추가로: 최근 라벨 10개 일치, 롤백 없음, 카나리 놓침 없음, 동결 아님 |

### 3등급 — 옵션 (꺼도 됨, 끄면 엄격해짐)

| 구성요소 | 끄면 | 켜면 함께 필요 |
|---|---|---|
| CEO | 운영자가 티켓을 쓰고 슈퍼바이저가 우선순위대로 배분 | 전략 문서 |
| COO | 두 번째 열쇠가 없으니 모든 T2가 T3(운영자 결재)로 | CEO, 카나리 1% 이상, CEO와 다른 모델 |
| 리서치·개발·GTM | 해당 행동 유형이 레지스트리에서 빠지고 티켓을 만들 수 없음 | 부서별 루브릭(없으면 T2 이상 고정), GTM은 목소리 가이드 |
| 운영 | 에이전트 행동이 프로덕션에 닿지 않음, 배포는 운영자가 | 되돌리기 절차가 기록되는 실행기(D14) |
| 개선팀 | 조직 고정: 안전하지만 나아지지 않음 | 리플레이 세트, 릴리스 게이트, 라벨이 충분할 때까지 휴면(D20) |
| 자동 승격 | 모든 행동이 시작 등급에 고정 | 검증 + 운영자 라벨 + 감사 |
| 주니어 | 시니어 단독: 저렴하지만 큰 작업은 느림 | 워크트리 제한, 작업당 최대 인원 |
| 사용자 정의 부서 | — | 헌장, 운영자가 쓴 루브릭(생기기 전까지 T2 이상) |

### 구성 규칙

1. **생산 부서는 최소 1개.** 커널은 아무것도 생산하지 않습니다.
2. **옵션을 끄면 항상 더 엄격한 쪽으로 대체됩니다.** 위 표의 "끄면" 열이 그 대체 경로입니다.
3. **의존성이 빠지면 시작을 거부합니다.** 카나리 없는 COO, 꺼진 부서가 소유한 행동, 생산자와 모델을 공유하는 판정자는 `config check`, `init`, `doctor`가 모두 막습니다. 라벨 붙은 리플레이 티켓이 부족한 개선팀은 거부되지 않고 휴면 상태로 남으며(D20), doctor가 이를 보고합니다.

### 분류가 제품에 놓이는 자리

| 등급 | 위치 | 바꾸는 주체 |
|---|---|---|
| 필수·고정 | 커널 패키지 | 패키지 릴리스로만 |
| 필수·강도 설정 | `company.yaml`(하한은 커널에) | 운영자 |
| 옵션 | `company.yaml` 스위치 + 레포에 복사된 모듈 템플릿 | 운영자가 켜고 끔, 개선팀이 복사된 파일을 발전시킴 |
