# 07 — Engines: Claude Code and Codex, per role

> Every role can run on Claude Code or on Codex, chosen in `company.yaml`. The kernel owns the rules; an engine only runs a session. Where an engine lacks a guarantee, the kernel names what it does instead.
> 모든 역할은 `company.yaml`에서 Claude Code나 Codex 중 원하는 엔진으로 돌릴 수 있습니다. 규칙은 커널이 갖고, 엔진은 세션을 돌리기만 합니다. 엔진에 없는 보장은 커널이 무엇으로 메우는지 이름을 붙여 둡니다.

---

## English

### 1. Why more than one engine

| Reason | What it buys |
|---|---|
| Independence (Constitution 2.2, 3.4) | A judge or COO on a second provider fails differently from the producers it checks. Two models from one vendor share training data and blind spots |
| Fit per role | Long-context planning, terse code review and cheap reading have different best models; each role kind gets its own (engine, model, effort) |
| Vendor risk | An outage, a price change or a policy change at one provider degrades the company instead of stopping it |
| Cost | Juniors on small models, the judge on a reasoning model, executives on whatever the Operator trusts most |

### 2. The contract

`packages/kernel/src/engine/types.ts`. Adapters are plain async code shaped like their SDKs; the kernel wraps them in Effect.

```ts
interface Engine {
  id: "claude" | "codex"
  capabilities: EngineCapabilities          // what this engine guarantees natively
  run(spec: SessionSpec, onEvent, signal): Promise<Outcome>
  probe?(ctx): Promise<ProbeResult[]>       // host self-test for doctor, no model call
}
```

- **`SessionSpec`** is everything the kernel decided: role and assignment, worktree, instructions as text, sandbox policy, the guard function and the guard binary, the company tool endpoint and token, limits, output schema, env, price.
- **`SessionEvent`** is a small neutral stream (`started`, `activity`, `tool`, `command`, `file_change`, `blocked`, `error`) the supervisor uses for tripwires and lease renewal.
- **`Outcome`** is one result shape (`success`, `max_turns`, `max_budget`, `timeout`, `aborted`, `error`) with cost and its source. The kernel never sees an SDK result type.

Each engine lives in its own package (`@holdco/engine-claude`, `@holdco/engine-codex`), so a company installs only what it uses.

### 3. Capability matrix

"Verified" means checked against the installed SDK's type definitions or, for Codex, against the Codex CLI 0.164.0 binary itself (`--strict-config`, `codex doctor`, `codex sandbox`).

| Guarantee | Claude Code (Agent SDK 0.3.310) | Codex (SDK + CLI 0.164.0) | Kernel compensation for the gap |
|---|---|---|---|
| Abort | `abortController` ✔ | `signal` on the turn ✔ | — |
| Structured output | `outputFormat: json_schema` ✔ | `outputSchema` ✔ | — |
| System instructions | `systemPrompt.append` ✔ | none | prepend to the first input; nothing safety-relevant depends on the model obeying |
| Cost reporting | `total_cost_usd` ✔ | tokens only | meter tokens × `engines.codex.prices` |
| Turn limit, mid-session budget cap | `maxTurns`, `maxBudgetUsd` ✔ | none; usage arrives only when a turn ends | reserve the cap from the share before dispatch; the adapter aborts after `maxTurns` completed actions or at the session timeout; spend metered at turn end and reconciled |
| Pre-tool guard | in-process `PreToolUse` callback ✔ | command hook (`hooks.json`) | register the compiled guard; run Codex through a wrapper that passes `--dangerously-bypass-hook-trust` (§5) |
| Subagent identity in hooks | `agent_id`, `agent_type` ✔ | not needed: no native subagents | juniors are kernel sessions (D37) on both engines |
| OS write sandbox | `sandbox` (bubblewrap / Seatbelt) ✔ | permission profile ✔ verified | — |
| OS read denial | `sandbox.filesystem.denyRead` ✔ | profile `deny` ✔ verified on Linux | doctor probes it on the host before agents start |
| Project config isolation | `settingSources: []` ✔ | per-session `CODEX_HOME` ✔ verified | project `.codex/` is kernel-locked anyway |
| Company tools | MCP (HTTP + bearer) ✔ | `[mcp_servers]` + `bearer_token_env_var` ✔ verified | — |

`compensations(capabilities)` in the kernel turns every gap into a named action with a strength (`prevent` or `detect`). A test fails if an engine declares a gap with no compensation, so a third engine cannot be added silently. `holdco engines` prints the list for a company.

### 4. Per-role assignment

```yaml
roles:
  ceo:           { engine: claude, model: opus }
  coo:           { engine: codex,  model: gpt-6.1-sol, effort: high }
  senior:        { engine: claude, model: opus }
  verification:  { engine: codex,  model: gpt-6.1-sol, effort: high }
  improvement:   { engine: claude, model: opus }
  junior_worker: { engine: claude, model: sonnet }
  junior_reader: { engine: claude, model: haiku }
  by_department: { gtm: { engine: claude, model: sonnet } }
```

- Role **kinds** are fixed by the kernel: `ceo`, `coo`, `senior`, `verification`, `improvement`, `junior_worker`, `junior_reader`. What a session may do comes from its role file (`org/roles/<role>.md`: kind, department, `capabilities: [read, write, shell, web, delegate]`), never from the engine.
- Independence is compared on the pair (engine, model). The schema rejects a judge equal to any producer (`senior`, `junior_worker`, any `by_department` override) and a COO equal to the CEO.
- Presets: `solo-dev` (Claude only), `solo-codex` (Codex only), `full` (both; COO and judge on Codex, producers on Claude).

### 5. How each adapter enforces the spec

**Claude.** `systemPrompt` preset + append; `settingSources: []` for project sessions (`["project"]` with `projectConfigRoot` = the live checkout for company sessions); `managedSettings` deny rules with absolute paths; `sandbox` enabled, `failIfUnavailable`, no unsandboxed commands; `hooks.PreToolUse` calls `spec.guard`; `Agent` and `Task` always disallowed; tools allowed per capability; `mcpServers.company` with the session token; `maxTurns`, `maxBudgetUsd`, `effort`, `outputFormat`.

**Codex.** The kernel writes a home per session under `.holdco/sessions/<id>/codex-home` and points `CODEX_HOME` at it:

```toml
approval_policy = "never"
default_permissions = "holdco"
project_doc_max_bytes = 0                       # project AGENTS.md comes from the kernel, not the worktree

[permissions.holdco.filesystem]
":root" = "read"
":tmpdir" = "write"                             # write-capable roles only
"/…/company" = "read"                           # denyWrite
"/…/company/.holdco" = "deny"                     # denyRead (also canaries, host credentials)

[permissions.holdco.filesystem.":workspace_roots"]
"." = "write"                                   # "read" for read-only roles

[permissions.holdco.network]
enabled = false                                 # or a domain allowlist + features.network_proxy

[shell_environment_policy]
inherit = "core"
exclude = ["*KEY*", "*TOKEN*", "*SECRET*"]

[mcp_servers.company]
url = "http://127.0.0.1:<port>/mcp/<session>"
bearer_token_env_var = "HOLDCO_SESSION_TOKEN"

[features]
hooks = true
multi_agent = false                             # and plugins, apps, browser/computer use, … off
```

plus `hooks.json` registering the guard binary for `PreToolUse`, plus `bin/codex`, a two-line wrapper. Three facts found while verifying shaped this:

1. **Profiles are dropped by legacy sandbox settings.** If `sandbox_mode` is set anywhere, or `--sandbox` is passed (which the SDK does when `sandboxMode` is set), Codex silently uses the old sandbox and ignores the profile. Reproduced: with `sandbox_mode` present, a denied file was readable. The adapter never sets either.
2. **Access values are `read`, `write`, `deny`.** `none` makes the config fail to load.
3. **Non-managed hooks are skipped until a person trusts them** in `/hooks`. The SDK cannot pass the global `--dangerously-bypass-hook-trust` flag, so `codexPathOverride` points at the wrapper, which adds it before `exec`. Waiving trust is safe here because the only hook source loaded is the kernel's own home: plugins are off and no project is trusted there.

Codex documents hooks as covering shell, `apply_patch` and MCP tools but "not a complete enforcement boundary". In Holdco the profile is the boundary; the hook adds interrupts and the two-repository guard on top.

### 6. Delegation is the kernel's, on both engines (D37)

Native subagents are off (Claude: `Agent`/`Task` disallowed; Codex: `multi_agent = false`). A senior calls `delegate_start(brief)`; the kernel validates the brief, creates `t-<id>-<brief>`, and starts the junior as its own session with the `junior_worker` or `junior_reader` assignment, which may be a different engine from the senior's. `delegate_wait` returns each validated return form. This keeps the junior worktree rule, the per-task junior cap, budget accounting and identity identical across engines, and lets a Claude senior use Codex juniors or the reverse.

### 7. What is still open

| # | Item | Plan |
|---|---|---|
| R8a | Codex hooks actually fire under `codex exec` with the wrapper (needs a model turn) | M3 live smoke: a session told to patch `governance/` must produce a `blocked` event |
| R8b | Profile enforcement on macOS (Seatbelt) | doctor probe runs there too; verified on Linux only so far |
| R1 | Which `managedSettings` keys survive on Claude | M3 spike; sandbox and in-process guard already cover |
| — | Codex config keys can change between CLI versions | engine package pins the SDK (and with it the CLI); the doctor probe runs `--strict-config` on every start |

---

## 한국어

### 1. 엔진을 여러 개 두는 이유

위 표와 같습니다. 핵심은 **독립성**입니다. 심판이나 COO를 다른 제공사 모델에 두면, 같은 회사 모델끼리 공유하는 학습 데이터와 맹점을 덜 공유하게 됩니다. 그 밖에 역할별로 맞는 모델을 고를 수 있고, 한 제공사의 장애·가격·정책 변경이 회사를 멈추지 않으며, 주니어는 작은 모델로 비용을 줄일 수 있습니다.

### 2. 계약

위 코드와 같습니다. 커널은 `SessionSpec`(역할과 배정, 워크트리, 텍스트 지시문, 샌드박스 정책, 가드 함수와 가드 바이너리, 회사 도구 엔드포인트와 토큰, 한도, 출력 스키마, 환경변수, 가격)을 만들고, 어댑터는 이를 자기 엔진 옵션으로 번역해 실행한 뒤 중립적인 `SessionEvent` 스트림과 `Outcome` 하나를 돌려줍니다. 커널은 SDK 결과 타입을 절대 보지 않습니다. 엔진마다 패키지가 따로라서 회사는 쓰는 엔진만 설치합니다.

### 3. 기능 비교표

위 표와 같습니다. "확인됨"은 설치한 SDK 타입 정의로, Codex는 CLI 0.164.0 바이너리 자체(`--strict-config`, `codex doctor`, `codex sandbox`)로 확인했다는 뜻입니다. Codex에 없는 것(시스템 프롬프트, 비용 보고, 턴 한도와 세션 중 예산 상한, 프로세스 내 훅)은 커널이 각각 이름 붙은 보완책으로 메웁니다. 예를 들어 Codex는 턴이 끝날 때만 사용량을 알려주므로, 어댑터가 완료된 행동 수(`maxTurns`)와 세션 시간으로 직접 끊고 비용은 턴 종료 시 계산해 나중에 대조합니다. 보완책 없는 빈칸을 선언한 엔진은 테스트가 실패하므로 세 번째 엔진도 몰래 추가될 수 없습니다. `holdco engines`가 회사별 목록을 보여줍니다.

### 4. 역할별 배정

위 예시와 같습니다. 역할 **종류**는 커널이 정하고, 세션이 할 수 있는 일은 엔진이 아니라 역할 파일(`org/roles/<역할>.md`의 `capabilities`)이 정합니다. 독립성은 (엔진, 모델) 쌍으로 비교해서 심판이 어떤 생산자와도 같으면, COO가 CEO와 같으면 스키마가 거부합니다. 프리셋은 `solo-dev`(Claude만), `solo-codex`(Codex만), `full`(둘 다, COO와 심판은 Codex, 생산자는 Claude)입니다.

### 5. 어댑터가 명세를 집행하는 방법

Claude는 위 설명과 같습니다. Codex는 커널이 세션마다 `.holdco/sessions/<id>/codex-home`을 만들어 `CODEX_HOME`으로 지정하고, 위 설정 파일과 가드 훅 등록, 두 줄짜리 래퍼를 씁니다. 검증하면서 찾은 세 가지 사실이 설계를 바꿨습니다.

1. **`sandbox_mode`가 어디든 있거나 `--sandbox`가 넘어가면 권한 프로필이 조용히 무시됩니다.** SDK의 `sandboxMode`가 바로 `--sandbox`를 넘깁니다. 실제로 `sandbox_mode`가 있을 때 차단해야 할 파일이 읽혔습니다. 어댑터는 둘 다 절대 설정하지 않습니다.
2. **접근 값은 `read`, `write`, `deny`입니다.** `none`을 쓰면 설정 로드가 실패합니다.
3. **관리되지 않는 훅은 사람이 `/hooks`에서 신뢰하기 전까지 건너뜁니다.** SDK는 전역 플래그 `--dangerously-bypass-hook-trust`를 넘길 수 없어서, `codexPathOverride`가 이 플래그를 `exec` 앞에 붙이는 래퍼를 가리킵니다. 로드되는 훅이 커널 소유 홈의 것뿐이라(플러그인 끔, 신뢰된 프로젝트 없음) 신뢰 절차를 생략해도 안전합니다.

Codex 문서도 훅이 셸·`apply_patch`·MCP 도구를 다루지만 "완전한 집행 경계는 아니다"라고 합니다. Holdco에서 경계는 권한 프로필이고, 훅은 그 위에 인터럽트와 두 레포 가드를 더합니다.

### 6. 위임은 두 엔진 모두 커널이 합니다 (D37)

엔진 고유 서브에이전트는 끕니다(Claude는 `Agent`/`Task` 금지, Codex는 `multi_agent = false`). 시니어가 `delegate_start`를 부르면 커널이 지시서를 검증하고 워크트리를 만든 뒤 주니어를 별도 세션으로 띄우며, 주니어 엔진은 시니어와 달라도 됩니다. 그래서 주니어 워크트리 규칙, 작업당 주니어 상한, 예산, 신원이 엔진과 무관하게 같고, Claude 시니어가 Codex 주니어를 쓰는 조합도 됩니다.

### 7. 아직 열린 것

위 표와 같습니다. Codex 훅이 래퍼를 통해 `codex exec`에서 실제로 발동하는지(모델 호출이 필요해 M3 실사용 테스트에서 확인), macOS(Seatbelt)에서의 프로필 집행(doctor 실측이 macOS에서도 돌지만 지금은 Linux만 확인), Claude의 managed 키 유지 여부(R1), CLI 버전 간 설정 키 변경(SDK 버전 고정과 매 시작 시 `--strict-config` 실측으로 대응)입니다.
