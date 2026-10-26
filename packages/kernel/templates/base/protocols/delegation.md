# Delegation Protocol — Senior → Juniors

> ✏️ Improvement may propose changes. / ✏️ 개선팀이 변경을 제안할 수 있습니다.

---

## English

### 1. Why seniors and juniors

Agents of the same model know the same things, so "seniority" here does not mean experience. It means three things:

1. **Context separation.** The senior holds the whole picture (goal, plan, done criteria). Each junior receives one narrow, self-contained task in a fresh context. Long contexts degrade judgment; this keeps every context short.
2. **Model tiering.** Seniors run on a strong model; juniors on a cheaper, faster one by default. The senior can request a stronger junior for a hard subtask.
3. **Criteria before work.** The senior writes done criteria before any junior starts, then checks results against them.

The senior plans, delegates, integrates, and reviews. The senior does not do juniors' work. Juniors do not see the whole.

### 2. Sizing the team (0..N)

The senior decides team size per task. The default is zero.

```
size(task):
  if task is small, single-area, and fits comfortably in one context  → 0 juniors (senior does it)
  if task splits into independent parts                               → SPLIT: 1 junior per part
  if task is ambiguous or high-stakes and one answer must be chosen   → COMPETE: 2 juniors, same brief, varied approach
  if parts are tightly coupled (shared files, shared state)           → SEQUENTIAL: 1 junior at a time, or senior alone
  cap: company.yaml:modules.juniors.max_per_task (default 5); exceeding it requires a CEO ticket split
```

Each spawn decision is logged with the reason (`split`, `compete`, `sequential`, `solo`) so Improvement can later evaluate over- and under-spawning.

| Pattern | Use when | Senior's integration step |
|---|---|---|
| **Solo** | Small, local, clear | — |
| **Split** | Decomposable into independent parts | Merge parts, resolve interface mismatches |
| **Compete** | Ambiguous, design choice, high stakes | Compare, pick or combine, record the reason |
| **Sequential** | Coupled changes | Pass each result as context to the next brief |

### 3. Isolation

- A junior is a **separate kernel session**, started by `delegate_start`, possibly on a different engine or model from the senior (`company.yaml:modules.juniors`). It is never a native subagent of the senior's engine: it has its own instructions, its own sandbox, and no company tools.
- Every `junior_worker` works in its own **git worktree** `t-<ticket>-<brief_id>` on branch `t/<ticket>-<brief_id>`, created by the kernel. Juniors never share a working directory, never push, never open pull requests, never merge.
- The senior merges junior branches into the ticket branch `t/<id>`. Conflicts are the senior's job, never a junior's.
- `junior_reader` juniors need no worktree; their findings travel only in the return.
- Juniors never receive production secrets or credentials: no session does (`AGENTS.md` §Secrets, D14).

### 4. The handoff contract

All handoffs use the fixed schemas. Prose handoffs are a protocol violation.

- Senior → junior: **brief** (`protocols/brief.schema.md`), a JSON object passed to `delegate_start`
- Junior → senior: **return** (`protocols/return.schema.md`), the junior's final message, JSON

Enforcement (by the kernel, in `delegate_start` and `delegate_wait`):
- A brief that fails schema validation cannot start a junior; `brief_validate` shows the errors beforehand.
- A brief whose done criteria are empty or not checkable ("make it good", "improve quality") is rejected before starting.
- A return that fails validation ends that junior as a failure; `delegate_wait` reports it. There is no message channel back to a running junior: the senior starts a new one.

### 5. Restate check (large tasks)

For tasks estimated above `company.yaml:policy.delegation.restate_threshold` (default: more than one hour of agent time, or any COMPETE task), set `restate_first: true`. The junior returns only a one-paragraph restatement of the task and its planned approach with `status: restatement` and stops; its session is over. The senior compares the restatement to the brief, fixes the brief if they disagree, and starts a new junior with `restate_first: false`. A mismatch costs one short session; skipping the check costs a wasted task.

### 6. Review and iteration

```
for each return from delegate_wait (already validated):
  check result against brief.done_criteria yourself (mechanically where possible)
  read assumptions[] — resolve each: accept, correct, or escalate
  if fails: start a new junior with the failed criteria named in the brief
            (max company.yaml:policy.delegation.max_iterations, default 2)
  if still failing: senior takes over the subtask, or ticket_update → blocked with the two positions in the note
integrate into t/<id>; ticket_update → ready_for_verification
```

The senior's review is the first line of defense. It never replaces Verification (Constitution 2.2).

### 7. Signals for Improvement

| Signal | What it measures |
|---|---|
| Senior rejection rate per brief template | Brief quality |
| Assumptions per return, by task type | Context missing from briefs |
| Iterations to pass | Clarity of done criteria |
| Spawn reason vs outcome | Sizing judgment (over/under-spawning) |
| Restate mismatches | Ambiguity in briefs |

---

## 한국어

### 1. 왜 시니어와 주니어인가

같은 모델의 에이전트는 아는 것이 같으므로, 여기서 "연차"는 경험이 아닙니다. 세 가지를 뜻합니다.

1. **컨텍스트 분리.** 시니어는 전체 그림(목표, 계획, 완료 기준)을 듭니다. 주니어는 좁고 독립된 작업 하나를 깨끗한 컨텍스트에서 받습니다. 긴 컨텍스트는 판단을 흐리므로, 이 방식으로 모든 컨텍스트를 짧게 유지합니다.
2. **모델 등급.** 시니어는 강한 모델, 주니어는 기본적으로 싸고 빠른 모델. 어려운 하위 작업에는 시니어가 강한 주니어를 요청할 수 있습니다.
3. **작업 전 기준.** 시니어는 어떤 주니어든 착수하기 전에 완료 기준을 쓰고, 결과를 그 기준에 대조합니다.

시니어는 계획하고, 위임하고, 통합하고, 검수합니다. 주니어의 일을 대신하지 않습니다. 주니어는 전체를 보지 않습니다.

### 2. 팀 규모 정하기 (0~N)

시니어가 작업마다 팀 규모를 정합니다. 기본값은 0입니다.

- 작고, 한 영역이고, 한 컨텍스트에 여유 있게 들어가면 → 주니어 0명 (시니어가 직접)
- 독립된 부분으로 쪼개지면 → **분할**: 부분당 주니어 1명
- 모호하거나 중요하고 하나의 답을 골라야 하면 → **경쟁**: 주니어 2명, 같은 지시서, 다른 접근
- 부분이 강하게 얽혀 있으면(공유 파일, 공유 상태) → **순차**: 한 번에 주니어 1명, 또는 시니어 단독
- 상한: `company.yaml:modules.juniors.max_per_task`(기본 5). 넘기려면 CEO가 티켓을 쪼개야 함

모든 스폰 결정은 이유(`split`, `compete`, `sequential`, `solo`)와 함께 기록되어, 개선팀이 나중에 과잉·과소 스폰을 평가할 수 있게 합니다.

### 3. 격리

- 주니어는 `delegate_start`가 시작하는 **별도 커널 세션**이며, 시니어와 다른 엔진·모델에서 돌 수 있습니다(`company.yaml:modules.juniors`). 시니어 엔진의 네이티브 서브에이전트가 아닙니다. 자기 지시문과 샌드박스를 갖고, 회사 툴은 없습니다.
- 모든 `junior_worker`는 커널이 만든 자기 **git 워크트리** `t-<티켓>-<brief_id>`(브랜치 `t/<티켓>-<brief_id>`)에서 작업합니다. 작업 디렉터리를 공유하지 않고, 푸시·PR·머지를 하지 않습니다.
- 시니어가 주니어 브랜치를 티켓 브랜치 `t/<id>`에 머지합니다. 충돌 해결은 시니어의 몫입니다.
- `junior_reader`는 워크트리가 없고, 발견은 반환서로만 전달됩니다.
- 주니어는 프로덕션 시크릿이나 자격증명을 절대 받지 않습니다. 어떤 세션도 받지 않습니다(`AGENTS.md` 시크릿 항목, D14).

### 4. 인수인계 계약

모든 인수인계는 고정 스키마를 씁니다. 산문 인수인계는 프로토콜 위반입니다.

- 시니어 → 주니어: **지시서** (`protocols/brief.schema.md`), `delegate_start`에 넘기는 JSON 객체
- 주니어 → 시니어: **반환서** (`protocols/return.schema.md`), 주니어의 마지막 메시지, JSON

강제 방식 (커널이 `delegate_start`와 `delegate_wait`에서 수행):
- 스키마 검증에 실패한 지시서로는 주니어를 시작할 수 없음. `brief_validate`로 미리 확인
- 완료 기준이 비었거나 확인 불가능한 지시서("잘 만들기", "품질 개선")는 시작 전에 반려
- 검증에 실패한 반환서는 그 주니어의 실패로 끝나고 `delegate_wait`가 보고함. 실행 중인 주니어에게 보낼 메시지 채널은 없으며, 시니어가 새 주니어를 시작함

### 5. 되짚기 확인 (큰 작업)

`company.yaml:policy.delegation.restate_threshold`(기본: 에이전트 시간 1시간 초과 또는 모든 경쟁 작업)를 넘는 작업은 `restate_first: true`로 보냅니다. 주니어는 과제와 접근을 한 문단으로 되짚어 `status: restatement`로 반환하고 멈추며 세션이 끝납니다. 시니어는 지시서와 비교해 어긋나면 지시서를 고치고, `restate_first: false`로 새 주니어를 시작합니다. 어긋남을 잡는 비용은 짧은 세션 하나이고, 건너뛴 비용은 작업 하나를 통째로 버리는 것입니다.

### 6. 검수와 반복

`delegate_wait`가 돌려준(이미 검증된) 반환서마다 완료 기준을 직접 대조(가능하면 기계적으로) → `assumptions[]`의 각 가정을 수용·정정·에스컬레이션 중 하나로 처리 → 실패하면 실패한 기준을 지시서에 명시해 새 주니어를 시작(최대 `company.yaml:policy.delegation.max_iterations`회, 기본 2회) → 그래도 실패하면 시니어가 하위 작업을 넘겨받거나 `ticket_update` → `blocked`에 양측 입장을 적어 올림. `t/<id>`에 통합한 뒤 `ticket_update` → `ready_for_verification`.

시니어의 검수는 1차 방어선이며 검증 부서를 대체하지 않습니다(헌법 2.2).

### 7. 개선팀을 위한 신호

| 신호 | 측정하는 것 |
|---|---|
| 지시서 템플릿별 시니어 반려율 | 지시서 품질 |
| 작업 유형별 반환서당 가정 수 | 지시서에서 빠진 맥락 |
| 통과까지 반복 횟수 | 완료 기준의 명료성 |
| 스폰 이유 대 결과 | 규모 판단 (과잉·과소 스폰) |
| 되짚기 불일치 | 지시서의 모호성 |
