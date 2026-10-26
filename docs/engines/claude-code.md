# Engine — Claude Code

> `@holdco/engine-claude`: how Holdco runs a session on Claude Code through the Claude Agent SDK, and what to confirm on your installed version. The engine-neutral picture is in `docs/design/07-engines.md`.
> `@holdco/engine-claude`: Holdco가 Claude Agent SDK로 Claude Code 세션을 돌리는 방법과, 설치된 버전에서 확인할 것. 엔진 중립적인 전체 그림은 `docs/design/07-engines.md`에 있습니다.

---

## English

### 1. Mapping

| Holdco concept | Claude Code mechanism | Where |
|---|---|---|
| Company instructions | appended to the `claude_code` system prompt preset | `AGENTS.md` (+ charter, role, project `AGENTS.md`/`CLAUDE.md`) read by the kernel |
| A role (CEO, senior, judge, junior…) | one `query()` session per ticket, model and effort from `roles.<kind>` | `org/roles/<role>.md` |
| Juniors (0..N) | separate kernel sessions via `delegate_start`; native `Agent`/`Task` disallowed | D37 |
| Capabilities | `allowedTools` / `disallowedTools` per `read`, `write`, `shell`, `web` | `src/options.ts` (`toolLists`) |
| Locks | `managedSettings` deny rules (absolute paths) + `sandbox.filesystem` + in-process guard | `toClaudeOptions` |
| Project config | `settingSources: []` in project sessions; `["project"]` + `projectConfigRoot` = live checkout in company sessions | — |
| Company tools | `mcpServers.company` (HTTP, `Authorization: Bearer <session token>`) | D36 |
| Limits | `maxTurns`, `maxBudgetUsd`, `abortController` | — |
| Structured result | `outputFormat: { type: "json_schema", schema }` → `structured_output` | D19 |
| Outcome | `fromResult`: `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution` → neutral `Outcome` with `total_cost_usd` | `src/outcome.ts` |

Claude Code needs no kernel compensation: `holdco engines` prints "every guarantee is native".

### 2. The guard, twice

- **Supervised sessions**: `hooks.PreToolUse` is an in-process callback that calls `spec.guard` (interrupts + the two-repository guard, identity bound in the closure) and returns `permissionDecision: "deny"` with the reason. A `blocked` event goes to the supervisor.
- **Sessions started by hand in the company repo**: `.claude/settings.json` registers the compiled binary (`.claude/hooks/pre-tool-use`, built by `holdco build-hook`). The registered command wraps it so that a missing binary, a crash, or an unset project dir all exit 2:

```sh
R="${CLAUDE_PROJECT_DIR:-$(cd "$(git rev-parse --git-common-dir)/.." && pwd)}"
B="$R/.claude/hooks/pre-tool-use"
[ -x "$B" ] || { echo "holdco: hook binary missing; failing closed" >&2; exit 2; }
HOLDCO_COMPANY_ROOT="$R" "$B" || exit 2
```

The binary embeds Effect and its dependencies, so editing `node_modules/` cannot change it; a source change takes effect only when the Operator rebuilds. The same binary is the Codex hook (see `codex.md`).

### 3. Identity for unsupervised sessions

| Variable | Example | Meaning |
|---|---|---|
| `AGENT_ID` | `engineering-senior` | L1 interrupts |
| `AGENT_DEPT` | `engineering` | L2/L3 interrupts; "only Improvement edits the org". CEO and COO use `exec` |
| `OPERATOR_SESSION` | `1` | The Operator's own session; bypasses the hook. Never set for agents, never trusted by the CLI |

Supervised sessions do not rely on these: identity is in the closure and the session token.

### 4. Verification status

Verified against `@anthropic-ai/claude-agent-sdk` 0.3.310 type definitions: every option in §1, the result subtypes, `total_cost_usd`, `structured_output`, the hook callback signature. The adapter is typechecked against them and unit-tested (`test/claude.test.ts`).

Confirm on a live session before relying on them (M3):

| Item | Why it matters | Fallback |
|---|---|---|
| Which `managedSettings` keys survive filtering (R1) | Deny rules may be dropped | sandbox + in-process guard cover the same paths |
| Sandbox available on the host (bubblewrap / Seatbelt) | `failIfUnavailable` refuses to start otherwise | doctor fails first |
| Exit code 2 blocks the call for the binary hook | Unsupervised sessions | the wrapper exits 2 on every failure |

### 5. Performance

The guard binary takes about 12 ms per tool call (TS + Effect, `process.env` and synchronous stdin, `bun build --compile --bytecode`). Startup, not language, was the cost: dropping Effect's `Config` module and async stdin halved init, and bytecode halved the rest. A Rust binary would be 1–2 ms, worth it only if tool-call volume makes 12 ms visible.

---

## 한국어

### 1. 매핑

위 표와 같습니다. 회사 지시문은 커널이 읽어 `claude_code` 시스템 프롬프트에 덧붙이고, 역할마다 티켓당 `query()` 세션 하나를 `roles.<종류>`의 모델과 강도로 띄웁니다. 주니어는 `delegate_start`로 띄우는 별도 커널 세션이며 엔진 고유 `Agent`/`Task` 도구는 금지합니다. 권한(`read`, `write`, `shell`, `web`)은 허용·금지 도구 목록으로, 잠금은 managed deny 규칙(절대 경로)과 샌드박스와 프로세스 내 가드로, 회사 도구는 세션 토큰이 붙은 MCP 서버로, 결과는 엔진 중립 `Outcome`으로 바꿉니다. Claude Code는 커널 보완이 필요 없습니다.

### 2. 가드는 두 번

슈퍼바이저가 띄운 세션은 프로세스 내 `PreToolUse` 콜백이 `spec.guard`를 불러 거부 사유와 함께 막습니다. 사람이 회사 레포에서 직접 띄운 세션은 `.claude/settings.json`이 컴파일된 바이너리를 등록하고, 바이너리 없음·크래시·경로 미설정이 모두 종료 코드 2가 되도록 셸로 감쌉니다. 이 바이너리는 Codex 훅으로도 그대로 씁니다.

### 3. 슈퍼바이저 밖 세션의 신원

위 표와 같습니다. 슈퍼바이저가 띄운 세션은 이 변수에 의존하지 않고, 클로저와 세션 토큰에 신원이 묶여 있습니다.

### 4. 검증 상태

SDK 0.3.310 타입 정의로 §1의 모든 옵션과 결과 타입을 확인했고, 어댑터는 그 타입으로 타입 검사와 단위 테스트를 거쳤습니다. managed 키 유지 여부(R1), 호스트 샌드박스, 바이너리 훅의 종료 코드 2 차단은 M3 실사용 세션에서 확인합니다.

### 5. 성능

가드 바이너리는 툴 호출당 약 12ms입니다. 차이를 만든 건 언어가 아니라 시작 비용이었습니다.
