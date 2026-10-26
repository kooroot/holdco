# Action Policy

> 🔒 **Locked.** Operator only. / 🔒 **잠금.** 운영자만 수정합니다.

---

## English

This file decides what any agent may do, and with whose approval. Autonomy is assigned **per action type**, not per project or per department. A department that is trusted for one action type may still need approval for another.

### 1. Tiers

| Tier | Name | Approval | Execution | Typical actions |
|---|---|---|---|---|
| **T0** | Autonomous | None | Immediate after Verification, logged | Internal, reversible, machine-verifiable work: code on a branch, tests, research notes, drafts |
| **T1** | Delegated | None, but checked against an **envelope** | Immediate if inside envelope; else escalates to T2 | Spending under a cap, testnet deploys, scheduled posts within a quota |
| **T2** | Executive | CEO proposal + COO concurrence | Optimistic: executes, then Operator challenge window | Outside an envelope but below board thresholds; reversible |
| **T3** | Board | Operator, explicitly (`holdco inbox approve <id>`) | Blocks until approved; unanswered items expire to reject after `policy.inbox.timeout` | Irreversible and high-stakes |

The kernel computes the effective tier when a ticket reaches `verified` (`tierForChange`): the registry tier of the ticket's action, raised to T3 when the diff touches a locked or approval-required path, raised to T2 when a T1 action is outside its envelope. **Without a COO (`modules.executive: ceo` or `none`), every T2 runs as T3** and goes to the Operator's inbox.

**Always T3**, regardless of graduation history:
- Any merge whose diff touches a locked path (`company.yaml`, `.holdco/`, `AGENTS.md`, `.codex/`, `CONSTITUTION.md`, `governance/`, `evals/`, `control/`, `CLAUDE.md`, `.github/`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`, `runtime/`, `package.json`, `bun.lock`, `tsconfig.json`, `node_modules/`) or an approval-required one (`org/ceo.md`, `org/coo.md`, `org/departments/verification.md`, `org/roles/ceo.md`, `org/roles/coo.md`, `org/roles/verification-senior.md`). The kernel's `LOCKED` and `APPROVAL_REQUIRED` lists are authoritative.
- Any action whose id starts with a **reserved prefix**: `legal.`, `credentials.`, `governance.`, `operator.`, `prod.irreversible.`. The kernel forces these to T3 with `graduation: never`, refuses them from `action_request`, and the Operator performs them by hand. New T3-only actions are registered by the Operator under these prefixes (for example `operator.outreach`, `operator.contact`, `prod.irreversible.data-delete`, `prod.irreversible.key-rotate`, `prod.irreversible.dns-change`).
- Legal commitments: contracts, terms acceptance, filings, applications submitted in the Operator's name
- Funds movement above `company.yaml:policy.t3.spend_per_action_usd` per action or `company.yaml:policy.t3.spend_monthly_usd` per month
- Public statements under the Operator's own identity outside pre-approved envelopes
- Irreversible production operations: mainnet deploys, data deletion, key rotation, DNS changes
- Granting any agent new credentials, tools, or external accounts
- Spawning a new department

### 2. Classifying an action

Before acting, an agent classifies the action by four questions. The strictest answer wins.

1. **Reversible?** Can it be undone completely, by us, within the challenge window? Unknown = no.
2. **External?** Does anyone outside the company see or receive it?
3. **Verifiable?** Can an evaluator in `evals/` score it mechanically?
4. **Material?** Does it move money, create obligations, or speak for the Operator?

| Reversible | External | Verifiable | Material | Minimum tier |
|---|---|---|---|---|
| yes | no | yes | no | T0 |
| yes | no | no | no | T1 |
| yes | yes | any | no | T1 (within envelope) / T2 |
| any | any | any | yes | T2, or T3 if above threshold |
| no | any | any | any | T3 unless explicitly graduated (§4) |

### 3. Envelopes

The registry is **`company.yaml:envelopes`**; this section describes it. An envelope is a pre-approved boundary inside which T1 actions run without approval. Envelopes are delegations: they specify `id`, `scope`, `limit`, `unit` (`count` or `usd`), `period`, and `on_exceed` (`escalate_t2` or `queue_t2`). Enforcement belongs to the kernel at execution time (meters in the action log, posting quotas), never to an agent's promise. Model spend is not an envelope: it is `company.yaml:budget` and its department `shares`.

Shipped module defaults:

| Envelope | Module | Scope | Default limit | On exceed |
|---|---|---|---|---|
| `social-posting` | gtm | posts on company-owned accounts | 5 / week | queue for T2 |
| `testnet-deploy` | operations | deploys to non-production networks and staging | 50 / day | escalate to T2 |
| `paid-data` | research | paid research data and third-party APIs | 30 USD / month | escalate to T2 |

### 4. Action registry

The registry is **`company.yaml:actions`** (readable by every session, writable only by the Operator and `holdco promote`). It is the only source of truth for tier; agents may not infer a tier from precedent. Each entry has `id`, `department`, `tier` (current), `evaluator` (the rubric Verification applies, `<file>#<section>` under `evals/rubrics/`, or a kernel-computed evaluator: `calibration`, `replay`), optional `envelope`, `gates`, and `graduation` (`auto`: the kernel proposes promotion when `evals/README.md` §3 holds; `never`: permanently gated). An action with no evaluator cannot sit below T2.

Shipped module defaults (starting tiers; the current tier is whatever `company.yaml` says):

| Action id | Department | Tier | Gates | Evaluator | Graduation |
|---|---|---|---|---|---|
| `verdict.issue` | verification | T0 | — | `calibration` | never |
| `code.branch` | engineering | T0 | — | `engineering.md#app` | auto |
| `code.merge.docs` | engineering | T2 | `ci-green`, `verification-approved` | `engineering.md#docs` | auto |
| `code.merge.app` | engineering | T2 | `ci-green`, `verification-approved` | `engineering.md#app` | auto |
| `code.merge.contracts` | engineering | T3 | `ci-green`, `verification-approved` | `verification.md#security` | never |
| `content.draft` | gtm | T0 | — | `gtm.md#post` | auto |
| `content.publish.company` | gtm | T1 (`social-posting`) | `verification-approved` | `gtm.md#post` | auto |
| `operator.publish` | gtm | T3 | — | — | never |
| `legal.submit-application` | gtm | T3 | — | — | never |
| `research.report` | research | T0 | — | `research.md` | auto |
| `research.paid-source` | research | T1 (`paid-data`) | — | `research.md` | auto |
| `ops.observe` | operations | T0 | — | `operations.md#observe` | never |
| `deploy.staging` | operations | T1 (`testnet-deploy`) | `ci-green`, `verification-approved` | `operations.md` | auto |
| `deploy.production` | operations | T2 | `rollback-tested` | `operations.md` | auto |
| `prod.irreversible.mainnet-deploy` | operations | T3 | — | — | never |
| `credentials.grant` | operations | T3 | — | — | never |
| `improvement.merge` | improvement | T1 | `replay-gain`, `canary-clean` | `replay` | never |
| `governance.exec-definition-change` | improvement | T3 | `replay-gain` | — | never |
| `executive.reallocate` | executive | T2 | — | — | never |

Executors in v1: **merge** (`code.merge.*`, `improvement.merge`: merges the ticket branch into the default branch and records the undo) and **branch** (`code.branch`: leaves the branch). Deploy, publish, contact and outreach actions have no executor: once approved they become a `manual_action` inbox item the Operator performs by hand and marks done.

### 4b. Gates

A gate is a precondition the kernel checks when a ticket reaches `verified`, before executing or routing the action. `verification-approved` is the verdict itself; every other gate listed on the action must appear as `passed` with evidence in the Verdict's `gates`, otherwise the ticket is rejected back to the senior with "gate not evidenced".

| Gate | Evidence | Who produces it |
|---|---|---|
| `verification-approved` | A Verdict `approve` for the ticket branch head | Verification (`verdict_submit`) |
| `ci-green` | The project's check status if a remote with checks exists; otherwise every test or command named in `done_criteria` plus the repository's own test command pass in the Verification worktree. Output quoted as evidence | Verification |
| `rollback-tested` | The undo step from the senior's note was exercised (staging or dry run) | Verification |
| `replay-gain` | Replay score of the candidate ≥ baseline + `policy.release.min_gain`, no dimension below `max_regression` | Release job; while `evals/replay` is empty it is skipped and noted |
| `canary-clean` | No canary approved and no tripwire attributable to the change | Release job; skipped and noted while there is no canary history |

Replay suites and labels live in the kernel database; `evals/replay/` and `evals/labels/` hold exported copies only.

### 5. Demotion

An action type drops one tier immediately when any of these occurs. Restoring it requires re-graduation (`holdco promote <action>` after `evals/README.md` §3 holds again).
- Evaluator–Operator agreement falls below `company.yaml:policy.graduation.demotion_agreement` over the last `company.yaml:policy.graduation.demotion_window` samples
- The Operator rolls back an action of that type (`holdco rollback <action-log-id>`)
- A canary violation of that type passes COO review; the kernel also raises L3 (`governance/approvals.md` §4, `governance/interrupts.md` §3)

---

## 한국어

이 파일은 어떤 에이전트가 무엇을, 누구의 결재로 할 수 있는지를 정합니다. 자율성은 프로젝트나 부서 단위가 아니라 **행동 유형 단위**로 부여됩니다.

### 1. 등급

| 등급 | 이름 | 결재 | 실행 | 대표 행동 |
|---|---|---|---|---|
| **T0** | 자율 | 없음 | 검증 후 즉시, 기록 | 내부·가역·기계 검증 가능한 작업: 브랜치 위 코드, 테스트, 리서치 노트, 초안 |
| **T1** | 위임 | 없음, 단 **위임 범위**에 대조 | 범위 안이면 즉시, 밖이면 T2로 | 한도 내 지출, 테스트넷 배포, 할당량 내 게시 |
| **T2** | 경영진 | CEO 제안 + COO 동의 | 옵티미스틱: 실행 후 운영자 이의제기 창 | 위임 범위 밖이지만 이사회 기준 미만, 가역적 |
| **T3** | 이사회 | 운영자 명시적 승인(`holdco inbox approve <id>`) | 승인까지 차단, `policy.inbox.timeout` 경과 시 거절 | 비가역이며 위험이 큰 행동 |

커널은 티켓이 `verified`가 될 때 실효 등급을 계산합니다(`tierForChange`): 레지스트리 등급을 기준으로, diff가 잠긴·승인 필요 경로를 건드리면 T3로, T1이 위임 범위를 벗어나면 T2로 올립니다. **COO가 없으면 모든 T2는 T3로 처리**되어 운영자 인박스로 갑니다.

승격 이력과 무관하게 **항상 T3**:
- 잠긴 경로(`company.yaml`, `.holdco/`, `AGENTS.md`, `.codex/`, `CONSTITUTION.md`, `governance/`, `evals/`, `control/`, `CLAUDE.md`, `.github/`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`, `runtime/`, `package.json`, `bun.lock`, `tsconfig.json`, `node_modules/`)나 승인 필요 경로(`org/ceo.md`, `org/coo.md`, `org/departments/verification.md`와 그 역할 파일)를 건드리는 머지. 커널의 `LOCKED`·`APPROVAL_REQUIRED` 목록이 기준
- **예약 접두사** `legal.`, `credentials.`, `governance.`, `operator.`, `prod.irreversible.`로 시작하는 행동. 커널이 T3·`graduation: never`로 강제하고 `action_request`에서 거부하며 운영자가 직접 수행. 새 T3 전용 행동은 운영자가 이 접두사 아래 등록(예: `operator.outreach`, `operator.contact`, `prod.irreversible.data-delete`, `prod.irreversible.key-rotate`, `prod.irreversible.dns-change`)
- 법적 약속: 계약, 약관 동의, 신고, 운영자 명의 지원서
- 건당 `policy.t3.spend_per_action_usd` 또는 월 `policy.t3.spend_monthly_usd`를 넘는 자금 이동
- 사전 위임 범위 밖에서 운영자 본인 명의로 하는 공개 발언
- 비가역 프로덕션 작업: 메인넷 배포, 데이터 삭제, 키 교체, DNS 변경
- 에이전트에게 새 자격증명, 툴, 외부 계정 부여
- 새 부서 신설

### 2. 행동 분류

행동 전에 네 가지 질문으로 분류합니다. 가장 엄격한 답이 이깁니다.

1. **가역적인가?** 이의제기 창 안에 우리가 완전히 되돌릴 수 있는가? 모르면 아니오.
2. **외부적인가?** 회사 밖의 누군가가 보거나 받는가?
3. **검증 가능한가?** `evals/`의 평가기가 기계적으로 채점할 수 있는가?
4. **중대한가?** 돈이 움직이거나, 의무가 생기거나, 운영자를 대변하는가?

| 가역 | 외부 | 검증 | 중대 | 최소 등급 |
|---|---|---|---|---|
| 예 | 아니오 | 예 | 아니오 | T0 |
| 예 | 아니오 | 아니오 | 아니오 | T1 |
| 예 | 예 | 무관 | 아니오 | T1(범위 내) / T2 |
| 무관 | 무관 | 무관 | 예 | T2, 기준 초과 시 T3 |
| 아니오 | 무관 | 무관 | 무관 | 명시적으로 승격되지 않은 한 T3 (§4) |

### 3. 위임 범위 (Envelope)

레지스트리는 **`company.yaml:envelopes`**입니다. 위임 범위는 T1 행동이 결재 없이 움직일 수 있는 사전 승인된 경계이며 `id`, `scope`, `limit`, `unit`(`count`/`usd`), `period`, `on_exceed`(`escalate_t2`/`queue_t2`)를 명시합니다. 집행은 에이전트의 약속이 아니라 커널이 실행 시점에 합니다. 모델 지출은 위임 범위가 아니라 `company.yaml:budget`과 부서별 `shares`입니다.

모듈 기본값: `social-posting`(gtm, 주 5건, 초과 시 T2 대기), `testnet-deploy`(operations, 일 50건, 초과 시 T2), `paid-data`(research, 월 30 USD, 초과 시 T2).

### 4. 행동 레지스트리

레지스트리는 **`company.yaml:actions`**입니다(모든 세션이 읽을 수 있고, 운영자와 `holdco promote`만 씀). 등급의 유일한 출처이며 에이전트는 선례로 등급을 추론할 수 없습니다. 각 항목: `id`, `department`, `tier`(현재), `evaluator`(검증이 적용하는 루브릭 `<파일>#<섹션>`, 또는 커널 계산 평가기 `calibration`/`replay`), 선택 `envelope`, `gates`, `graduation`(`auto`: `evals/README.md` §3 충족 시 커널이 승격 제안, `never`: 영구 게이트). 평가기 없는 행동은 T2 아래로 내려갈 수 없습니다.

모듈 기본값(시작 등급. 현재 등급은 `company.yaml`)은 위 표와 같습니다. 요약: 브랜치·초안·리서치 보고서·`ops.observe`·판정은 T0, 회사 채널 게시·유료 데이터·스테이징 배포·개선 머지는 T1, 코드 머지(docs·app)·프로덕션 배포·재배분은 T2, 컨트랙트 머지·운영자 명의 게시·지원서·메인넷·자격증명·경영진 정의 변경은 T3(영구).

v1 실행기: **merge**(`code.merge.*`, `improvement.merge`: 기본 브랜치로 머지하고 되돌리기 기록)와 **branch**(`code.branch`). 배포·게시·연락·아웃리치는 실행기가 없어 승인 후 운영자가 직접 수행하고 완료 처리하는 `manual_action` 인박스 항목이 됩니다.

### 4b. 게이트

게이트는 티켓이 `verified`가 될 때 커널이 확인하는 전제조건입니다. `verification-approved`는 판정 자체이고, 행동에 적힌 나머지 게이트는 판정서의 `gates`에 증거와 함께 `passed`로 있어야 합니다. 없으면 "gate not evidenced"로 시니어에게 반려됩니다.

| 게이트 | 증거 | 생산자 |
|---|---|---|
| `verification-approved` | 티켓 브랜치 헤드에 대한 `approve` 판정 | 검증 (`verdict_submit`) |
| `ci-green` | 체크가 있는 원격이 있으면 그 상태, 없으면 `done_criteria`의 모든 테스트·명령과 레포 자체 테스트 명령이 검증 워크트리에서 통과. 출력을 증거로 | 검증 |
| `rollback-tested` | 시니어 노트의 되돌리기 절차를 실제로 실행해 봄(스테이징·드라이런) | 검증 |
| `replay-gain` | 후보 리플레이 점수 ≥ 기준선 + `policy.release.min_gain`, 항목 퇴보 `max_regression` 이내 | 릴리스 잡. `evals/replay`가 비어 있으면 건너뛰고 기록 |
| `canary-clean` | 변경에 기인한 카나리 승인·트립와이어 없음 | 릴리스 잡. 카나리 이력이 없으면 건너뛰고 기록 |

리플레이 세트와 라벨은 커널 데이터베이스에 있고, `evals/replay/`·`evals/labels/`는 내보낸 사본만 둡니다.

### 5. 강등

다음 중 하나가 발생하면 해당 행동 유형은 즉시 한 등급 내려갑니다. 복구는 재승격(`holdco promote <action>`, `evals/README.md` §3 재충족 후)으로만 합니다.
- 최근 `policy.graduation.demotion_window`개 샘플에서 평가기–운영자 일치율이 `policy.graduation.demotion_agreement` 미만
- 운영자가 해당 유형의 행동을 롤백(`holdco rollback <action-log-id>`)
- 해당 유형의 카나리 위반이 COO 검토를 통과. 커널은 동시에 L3를 겁니다(`governance/approvals.md` §4, `governance/interrupts.md` §3)
