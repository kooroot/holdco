# 10 — Engine boundary: an execution-level engine under the kernel (design only)

> **Status: Proposed — design only (D87).** Nothing in this document is implemented. No Nanocode (or any other third-engine) code is in the repository, and no adapter should be built until the open questions in §7 are answered.
> **상태: 제안 — 설계만 (D87).** 이 문서의 어떤 것도 구현되지 않았습니다. 저장소에 Nanocode(또는 다른 세 번째 엔진) 코드는 없고, §7의 열린 질문에 답이 나오기 전에는 어댑터를 만들지 않습니다.

---

## English

### 1. The layering

Holdco is a governance layer. It does not run an agent loop. It starts one session at a time on an engine and wraps it in locks, tiers, budgets, approvals, verification and an audit log (`07-engines.md`). Nanocode, and the "swarm" way of working it is built for (paradigm.xyz, "swarms", 2026-11-20), sit one layer down. That layer is an execution runtime with its own turn journal, subagent tree, per-child budgets, remote "hands" and an MCP payment hook.

The two layers complement each other rather than compete:

| Layer | Owns | Examples |
|---|---|---|
| Governance (the Holdco kernel) | Who may do what, at which tier, for how much, with whose approval, checked by whom, and recorded where | tickets, `company.yaml`, guard, ledger, inbox, verdicts, `action_log`, releases |
| Execution (an engine) | How a session's work gets done: model calls, tools, subagents, and retries inside the session | Claude Agent SDK, Codex SDK, and (proposed) Nanocode |

The boundary below says what a third, execution-level engine may do on its own and what it must hand back to the kernel. The rule is the one `07-engines.md` already applies to Claude and Codex: **the kernel owns the rules; an engine only runs a session.** A richer engine has more to report, but it does not get more authority.

### 2. What stays in the kernel (non-negotiable)

| Control | Where it is today | What the engine must do |
|---|---|---|
| Locked paths (D14, `05-security.md`) | `hooks/guard.ts`, `policy/paths.ts`, `SessionSpec.guard` / `hookCommand` | Call the guard before **every** tool effect, including tool calls made by its subagents and remote hands. A missing hook point is a capability `false`, and the kernel either compensates for it or refuses the role. |
| Tiers (T0–T3) and the action registry | `policy/`, the ticket's `action` | Nothing. The engine never decides a tier; it only reports `changed_paths` and the action the session claims. |
| Budgets | `admit()`, `SessionSpec.limits`, the ledger | Enforce `limits.maxBudgetUsd` as a ceiling for the whole subtree (a child's cap ≤ its parent's remaining cap). Report cost per session, and per child where it can. |
| Delegation | `delegate_start` / `delegate_wait` (D37); native subagents are off | Stay off by default. If a role is ever allowed native subagents, the subtree counts as one session for leases and budgets (§4). |
| Approvals and the inbox | supervisor, `inbox` | Nothing. Anything that needs a human comes back as a report or a tool call, never as a direct prompt to the Operator. |
| Audit log | `action_log`, `ticket_events`, `sessions` | Nothing directly. The kernel writes these from the engine's events and outcome. |
| External effects | Operator-declared executors (D50), crash-safe since D85 | Do not perform deploys, publishes, payments or credential use itself, except through §5. |
| Verification on a different engine | Independence on (engine, model) (D38) | A ticket's producer and its judge never run on the same (engine, model). See §7.6 for whether a re-implemented harness counts as a different engine. |

### 3. The adapter contract (proposed)

The third engine is an `Engine` like the other two (`packages/kernel/src/engine/types.ts`): `id`, `capabilities`, `run(spec, onEvent, signal) → Outcome`, and an optional `probe`. The proposal adds nothing to what the kernel lets an engine do; it only adds what an engine reports:

- **Identity and config.** `EngineId` gains a third literal (for example `"nanocode"`), with `engines.<id>` config like Codex's.
- **Capabilities.** `EngineCapabilities` is filled in honestly, and the kernel's existing compensations apply to every `false` (`07-engines.md`). New fields are only for what the kernel must know to stay in control:
  - `subtreeBudget: boolean`: the engine enforces `limits.maxBudgetUsd` over all of a session's subagents.
  - `subagentGuard: boolean`: the guard runs for tool calls made by subagents and remote hands, not only by the root.
  - `durableJournal: boolean`: the engine resumes a session from its own receipts, and reports an interrupted tool call as "outcome unknown" instead of re-running it.
- **Events.** `SessionEvent` gains optional, observational kinds:
  - `subagent`: spawned or ended, with its own cost.
  - `receipt`: a tool call committed in the engine's journal.

  Both go into the session journal (`.holdco/sessions/<id>/events.jsonl`) and never move a ticket on their own.
- **Outcome.** `Outcome` is unchanged. A session that ends with an "outcome unknown" tool call reports `status: "error"` and names that call in `error`. The kernel handles it like any errored session: retry within `max_attempts`, then blocked.

Agents never perform external effects (D14), so an unknown tool outcome inside a session concerns only the worktree, and Verification judges it. It is not an `action_log` row.

### 4. Journal mapping

| Engine concept | Kernel record | Rule |
|---|---|---|
| Session, turn, model step | A `sessions` row and journal events | One kernel session per engine root session; turns are only counted. |
| Subagent tree | `subagent` journal events; their cost is rolled into the root session's ledger entry | The subtree is one session for budgets and leases; the kernel does not lease subagents. |
| Tool receipt | A `receipt` journal event | Observational only. Replay inside the engine is the engine's business. |
| Interrupted tool call ("outcome unknown") | A session `error` | As in §3. The kernel never retries it inside the same session. |
| External action (deploy, publish, payment) | An `action_log` row with `status` and `idem_key` (D85) | Only through a kernel executor or the payment mapping in §5. |

### 5. Payment hook mapping (prepare / commit / rollback)

Nanocode's MCP payment hook works like this: `McpPaymentProvider.prepare` returns a pending payment that has `commit` and `rollback`. Spending is an external, irreversible action. It therefore maps onto the kernel's spend approval and the D85 write-ahead record, not onto the engine:

1. **prepare.** The engine asks the kernel through a company tool (for example `spend_request`), giving the amount, payee, purpose and ticket. The kernel checks the action's tier, the department's share and any per-ticket cap, and records the request as *pending* (no `action_log` claim yet: nothing can have been charged). A T2 or T3 spend waits for approval like any other action.
2. **commit.** Allowed only once the request is approved where approval is required. Immediately before the commit, the kernel claims the run: an `action_log` row with `status = started` and an idempotency key (D85). The payer gets the key, so a retried commit inside this run is not a second payment. On a known result the kernel settles the row as `done` with the receipt and charges the ledger.
3. **rollback.** Before a claim: the pending request is dropped. After a claim: the kernel settles the row with no charge only when the payer confirms nothing was charged.
4. **Crash.** While pending: nothing to recover; the request is still pending or expires. Between the claim and a known result: the row stays `started`, and the next boot raises it as **outcome unknown** in the urgent inbox and never re-runs it (D85). The Operator checks the payer's records, then approves (the payment happened) or rejects (it did not).

The payer's secrets stay with the kernel (D14). Either the kernel performs the commit itself, or it gives the engine a single-use authorization capped at the amount. Which of the two is an open question (§7.5).

### 6. What this does not change

The constitution, the tiers, the inbox, the ledger and the verification rules apply unchanged. A third engine would be chosen per role in `company.yaml`, like the other two, and nothing would switch to it by default.

### 7. Open questions

1. **Terms of use.** Running an independently re-implemented harness against a Claude or ChatGPT *subscription* login may not be allowed by the providers' terms. Until that is confirmed, a third engine is API-key only, or not offered at all.
2. **Guard coverage.** Can the engine call the kernel guard for every tool call of every subagent and remote hand, either in-process or as a command hook? If not, which roles, if any, may use it? Read-only research roles only?
3. **Sandbox.** Does it confine writes and deny reads at the OS level, as `SandboxPolicy` requires, including on remote hands? Remote hands run on another machine, so who enforces `writableRoots` there?
4. **Budget accounting.** Does it report cost per subagent? Does it enforce the lineage minimum (a child's `budget_usd` ≤ its parent's remaining budget) against `limits.maxBudgetUsd`? Plan quotas (D72) have no equivalent there yet.
5. **Payment protocol.** The hook speaks one payment-challenge protocol, so a payer that speaks another needs a bridge. Who owns that bridge? Does the kernel perform commits itself, or issue capped authorizations?
6. **Verification independence.** Today independence is compared on (engine, model). Is an engine that runs the same vendor's models behind its own harness a *different* engine, or the same provider with the same blind spots? Proposal: compare independence by model provider, not by harness.
7. **Durable resume vs kernel leases.** If the engine resumes a session from its journal after a crash, it collides with the kernel, which has already marked that session `crashed` and re-queued the ticket. One of the two must yield. Proposal: the kernel's boot recovery wins, and the engine's resume is disabled under Holdco.
8. **Maintenance.** The engine pins and re-verifies the upstream harness behavior itself. How would `holdco doctor` check that a given version still honors this contract?

---

## 한국어

### 1. 계층

Holdco는 거버넌스 계층입니다. 에이전트 루프를 직접 돌리지 않고, 엔진 위에 세션을 하나씩 띄워 잠금·티어·예산·승인·검증·감사 로그로 감쌉니다(`07-engines.md`). Nanocode와, Nanocode가 겨냥하는 "스웜" 방식(paradigm.xyz, "swarms", 2026-11-20)은 그보다 한 층 아래에 있습니다. 자체 턴 저널, 서브에이전트 트리, 자식별 예산, 원격 "hands", MCP 결제 훅을 가진 실행 런타임입니다.

두 계층은 경쟁하지 않고 서로를 보완합니다.

| 계층 | 갖는 것 | 예 |
|---|---|---|
| 거버넌스 (Holdco 커널) | 누가 무엇을, 어떤 티어로, 얼마로, 누구 승인과 누구 검증으로 하고, 어디에 기록하는가 | 티켓, `company.yaml`, 가드, 원장, 인박스, 판정, `action_log`, 릴리스 |
| 실행 (엔진) | 세션 안의 일을 어떻게 하는가: 모델 호출, 도구, 서브에이전트, 세션 내 재시도 | Claude Agent SDK, Codex SDK, (제안) Nanocode |

아래 경계는 실행 수준의 세 번째 엔진이 스스로 해도 되는 것과 커널에 넘겨야 하는 것을 정합니다. 규칙은 `07-engines.md`가 Claude·Codex에 이미 적용하는 것과 같습니다. **규칙은 커널이 갖고, 엔진은 세션을 돌리기만 합니다.** 엔진이 풍부해지면 보고할 것이 늘어날 뿐 권한은 늘지 않습니다.

### 2. 커널에 남는 것 (양보 불가)

| 통제 | 지금 있는 곳 | 엔진이 해야 할 것 |
|---|---|---|
| 잠금 경로 (D14, `05-security.md`) | `hooks/guard.ts`, `policy/paths.ts`, `SessionSpec.guard` / `hookCommand` | 서브에이전트와 원격 hands의 도구 호출까지, **모든** 도구 효과 전에 가드를 호출합니다. 훅 지점이 없으면 capability `false`이고, 커널이 보완하거나 그 역할을 거부합니다. |
| 티어(T0–T3)와 행동 레지스트리 | `policy/`, 티켓의 `action` | 없음. 엔진은 티어를 정하지 않고 `changed_paths`와 세션이 주장하는 행동만 보고합니다. |
| 예산 | `admit()`, `SessionSpec.limits`, 원장 | `limits.maxBudgetUsd`를 서브트리 전체의 상한으로 지킵니다(자식 상한 ≤ 부모 잔여). 세션별 비용을, 가능하면 자식별 비용도 보고합니다. |
| 위임 | `delegate_start` / `delegate_wait` (D37); 네이티브 서브에이전트는 꺼짐 | 기본은 꺼 둡니다. 어떤 역할에 네이티브 서브에이전트를 허용하더라도 서브트리는 리스와 예산에서 한 세션입니다(§4). |
| 승인과 인박스 | 슈퍼바이저, `inbox` | 없음. 사람이 필요한 것은 보고나 도구 호출로 돌아오고, 운영자에게 직접 묻지 않습니다. |
| 감사 로그 | `action_log`, `ticket_events`, `sessions` | 직접 하는 것 없음. 커널이 엔진 이벤트와 결과로 기록합니다. |
| 외부 효과 | 운영자가 선언한 실행기 (D50, D85부터 크래시 안전) | 배포·게시·결제·자격 증명 사용을 스스로 하지 않습니다. 예외는 §5뿐입니다. |
| 다른 엔진에서의 검증 | (엔진, 모델) 기준 독립성 (D38) | 한 티켓의 생산자와 심판은 같은 (엔진, 모델)에서 돌지 않습니다. 재구현한 하네스를 다른 엔진으로 볼지는 §7.6. |

### 3. 어댑터 계약 (제안)

세 번째 엔진도 다른 둘과 같은 `Engine`입니다(`id`, `capabilities`, `run(spec, onEvent, signal) → Outcome`, 선택적 `probe`). 이 제안은 엔진이 할 수 있는 일을 늘리지 않고, 엔진이 보고하는 것만 늘립니다.

- **식별과 설정.** `EngineId`에 세 번째 리터럴(예: `"nanocode"`)이, `engines.<id>`에 Codex와 같은 설정이 추가됩니다.
- **기능.** `EngineCapabilities`는 정직하게 채우고, 모든 `false`에는 기존 보완책이 적용됩니다. 새 필드는 커널이 통제를 유지하는 데 꼭 필요한 것만 둡니다.
  - `subtreeBudget`: 서브트리 전체에 예산을 강제합니다.
  - `subagentGuard`: 서브에이전트와 hands의 도구 호출에도 가드가 걸립니다.
  - `durableJournal`: 자체 영수증으로 세션을 재개하고, 중단된 도구 호출은 다시 돌리지 않고 "결과 불명"으로 보고합니다.
- **이벤트.** `SessionEvent`에 관측용 종류가 추가됩니다.
  - `subagent`: 생성과 종료, 그리고 비용.
  - `receipt`: 엔진 저널에 커밋된 도구 호출.

  둘 다 세션 저널에만 저장되며 티켓을 움직이지 않습니다.
- **결과.** `Outcome`은 그대로입니다. 결과 불명인 도구 호출로 끝난 세션은 `status: "error"`로 보고하고, 커널은 다른 오류 세션처럼 처리합니다(`max_attempts` 안에서 재시도한 뒤 blocked).

에이전트는 외부 효과를 내지 않으므로(D14), 세션 안의 결과 불명은 작업 트리 안의 문제이고 검증이 판단합니다. `action_log` 행이 아닙니다.

### 4. 저널 매핑

| 엔진 개념 | 커널 기록 | 규칙 |
|---|---|---|
| 세션, 턴, 모델 단계 | `sessions` 행과 저널 이벤트 | 엔진 루트 세션 하나가 커널 세션 하나입니다. 턴은 집계만 합니다. |
| 서브에이전트 트리 | `subagent` 저널 이벤트; 비용은 루트 세션의 원장 항목에 합산 | 예산과 리스에서 서브트리는 한 세션입니다. 커널은 서브에이전트에 리스를 주지 않습니다. |
| 도구 영수증 | `receipt` 저널 이벤트 | 관측용입니다. 엔진 안의 리플레이는 엔진이 맡습니다. |
| 중단된 도구 호출 ("결과 불명") | 세션 `error` | §3과 같습니다. 커널은 같은 세션 안에서 재시도하지 않습니다. |
| 외부 행동 (배포, 게시, 결제) | `status`와 `idem_key`가 있는 `action_log` 행 (D85) | 커널 실행기나 §5의 결제 매핑으로만 합니다. |

### 5. 결제 훅 매핑 (prepare / commit / rollback)

Nanocode의 MCP 결제 훅에서는 `McpPaymentProvider.prepare`가 `commit`과 `rollback`을 가진 대기 결제를 돌려줍니다. 지출은 되돌릴 수 없는 외부 행동이므로, 엔진이 아니라 커널의 지출 승인과 D85의 선기록에 매핑합니다.

1. **prepare.** 엔진이 회사 도구(예: `spend_request`)로 금액·수취인·목적·티켓을 커널에 요청합니다. 커널은 행동 티어, 부서 몫, 티켓별 상한을 확인하고 요청을 *대기* 상태로 기록합니다(아직 `action_log` 확보 없음: 청구됐을 수가 없음). T2/T3 지출은 다른 행동처럼 승인을 기다립니다.
2. **commit.** 승인이 필요한 경우 승인된 뒤에만 허용됩니다. commit 직전에 커널이 실행을 확보합니다: `status = started`와 멱등 키를 가진 `action_log` 행(D85). 결제자는 그 키를 받아, 이 실행 안에서 재시도한 commit이 두 번째 결제가 되지 않게 합니다. 결과가 알려지면 커널이 영수증과 함께 행을 `done`으로 정리하고 원장에 청구합니다.
3. **rollback.** 확보 전: 대기 요청을 버립니다. 확보 후: 결제자가 청구가 없었음을 확인할 때만 커널이 청구 없이 행을 정리합니다.
4. **크래시.** 대기 중: 복구할 것이 없습니다(요청이 대기로 남거나 만료). 확보와 알려진 결과 사이: 행이 `started`로 남고, 다음 부팅이 **결과 불명**으로 긴급 인박스에 올리며 다시 실행하지 않습니다(D85). 운영자는 결제자의 기록을 확인해 승인(결제됨)하거나 거절(결제 안 됨)합니다.

결제 시크릿은 커널에 남습니다(D14). 커널이 직접 commit하거나, 엔진에 금액 상한이 있는 1회용 권한을 줍니다. 둘 중 어느 쪽인지는 열린 질문입니다(§7.5).

### 6. 바뀌지 않는 것

헌법, 티어, 인박스, 원장, 검증 규칙은 그대로입니다. 세 번째 엔진도 다른 둘처럼 `company.yaml`에서 역할별로 고르며, 기본값으로 바뀌는 것은 없습니다.

### 7. 열린 질문

1. **약관.** 독자적으로 재구현한 하네스로 Claude·ChatGPT *구독* 로그인을 쓰는 것을 제공자 약관이 허용하지 않을 수 있습니다. 확인될 때까지 세 번째 엔진은 API 키 전용이거나 아예 제공하지 않습니다.
2. **가드 범위.** 모든 서브에이전트와 원격 hands의 모든 도구 호출에 커널 가드를 걸 수 있습니까(인프로세스든 명령 훅이든)? 아니라면 어떤 역할에 허용할까요? 읽기 전용 리서치 역할만?
3. **샌드박스.** 원격 hands를 포함해, `SandboxPolicy`가 요구하는 OS 수준 쓰기 제한과 읽기 거부를 제공합니까? hands는 다른 머신에서 도는데, 거기서 `writableRoots`는 누가 강제합니까?
4. **예산 회계.** 서브에이전트별 비용을 보고합니까? 계보 최소값(자식의 `budget_usd` ≤ 부모의 잔여 예산)을 `limits.maxBudgetUsd`에 맞춰 강제합니까? 플랜 쿼터(D72)에 해당하는 것은 아직 없습니다.
5. **결제 프로토콜.** 훅은 결제 챌린지 프로토콜 하나만 쓰므로, 다른 프로토콜을 쓰는 결제자에게는 브리지가 필요합니다. 브리지는 누가 맡습니까? 커널이 직접 commit합니까, 상한 있는 권한을 발급합니까?
6. **검증 독립성.** 지금 독립성은 (엔진, 모델)로 비교합니다. 같은 벤더의 모델을 자체 하네스로 돌리는 엔진은 *다른* 엔진입니까, 아니면 같은 사각지대를 가진 같은 제공자입니까? 제안: 독립성은 하네스가 아니라 모델 제공자로 비교합니다.
7. **지속 재개와 커널 리스.** 엔진이 크래시 뒤 저널로 세션을 재개하면 커널과 충돌합니다. 커널은 이미 그 세션을 `crashed`로 표시하고 티켓을 다시 큐에 넣었기 때문입니다. 둘 중 하나가 양보해야 합니다. 제안: 커널의 부팅 복구가 이기고, Holdco 아래에서는 엔진의 재개를 끕니다.
8. **유지보수.** 엔진은 업스트림 하네스 동작을 스스로 고정하고 다시 검증합니다. `holdco doctor`는 특정 버전이 이 계약을 여전히 지키는지 어떻게 확인합니까?
