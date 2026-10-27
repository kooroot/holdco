# Engine — Codex

> `@holdco/engine-codex`: how Holdco runs a session on OpenAI Codex through the Codex SDK, what was verified against the real Codex CLI, and what is still open. The engine-neutral picture is in `docs/design/07-engines.md`.
> `@holdco/engine-codex`: Holdco가 Codex SDK로 Codex 세션을 돌리는 방법, 실제 Codex CLI로 확인한 것, 아직 열린 것. 엔진 중립적인 전체 그림은 `docs/design/07-engines.md`에 있습니다.

---

## English

### 1. Mapping

| Holdco concept | Codex mechanism | Where |
|---|---|---|
| Company instructions | prepended to the first input (`instructions --- prompt`); Codex has no system prompt option | `toCodexOptions` |
| Project `AGENTS.md` | `project_doc_max_bytes = 0`; the kernel supplies it from the default branch, never from the worktree | `codexConfig` |
| A role | one thread per ticket: `model`, `modelReasoningEffort` from `roles.<kind>`, `workingDirectory` = the worktree, `approvalPolicy: "never"` | `toCodexOptions` |
| Capabilities | workspace `write` if the role has `write` or `shell`, else `read`; web search `live` only with `web` | `workspaceAccess` |
| Sandbox | permission profile `holdco` in a kernel-owned `CODEX_HOME` (§2) | `codexConfig` |
| Guard | the compiled guard binary as a `PreToolUse` command hook in that home | `codexHooks` |
| Hook trust | `codexPathOverride` → `bin/codex` wrapper adding `--dangerously-bypass-hook-trust` | `binary.ts` |
| Company tools | `[mcp_servers.company]`, `bearer_token_env_var = "HOLDCO_SESSION_TOKEN"` | D36 |
| Juniors | kernel sessions via `delegate_start`; `features.multi_agent = false` | D37 |
| Limits | adapter aborts after `maxTurns` completed actions or at `timeoutMs`; `signal` for interrupts | `index.ts` |
| Cost | tokens × `engines.codex.prices` (cached input at its rate; reasoning is part of output) | `costUsd` |
| Structured result | `outputSchema` on the turn when the schema is strict-compatible (every object closed, all properties required); a schema with a map (Verdict `scores`) is placed in the prompt and the final message is parsed instead — OpenAI's API rejects such schemas, which ended judge sessions with exit 1 on the first live run (2026-10-27); kernel validates either way | `strictCompatible`, `extractJson`, `CodexRunState` |

### 2. The generated home

`.holdco/sessions/<id>/codex-home/` (unreadable to every session's commands, since `.holdco/` is denied):

| File | Mode | Contents |
|---|---|---|
| `config.toml` | 600 | `approval_policy`, `default_permissions = "holdco"`, the profile (filesystem, network), `shell_environment_policy` (`inherit = "core"`, excludes `*KEY*`, `*TOKEN*`, `*SECRET*`), the company MCP server, features (`hooks` on; `multi_agent`, `plugins`, `apps`, browser and computer use, image generation and others off) |
| `hooks.json` | 600 | `PreToolUse`, matcher `*`, command = the guard binary |
| `bin/codex` | 700 | `exec '<real codex>' --dangerously-bypass-hook-trust "$@"` |

Profile rules, in order of strength (`deny` > `write` > `read`): `":root" = "read"`; for write-capable roles `":tmpdir"` and `":slash_tmp"` writable; every `denyWrite` path `read`; every `denyRead` path `deny` (company `.holdco/`, `evals/canaries/`, host credentials); `":workspace_roots"."."` = `write` or `read`. Network is off unless the department allowlists domains, in which case the domains are allowed and `features.network_proxy = true`, because Codex enforces domain rules only through its proxy.

### 3. What was verified, and how

Against the Codex CLI 0.164.0 binary that the SDK bundles, on Linux, without a model call:

| Check | Result |
|---|---|
| `codex --strict-config doctor --json` with the generated home | config loads; `filesystem sandbox = restricted`, denied-read rules counted, `network sandbox = restricted` |
| `codex sandbox -- cat <company>/.holdco/state` | Permission denied |
| `codex sandbox -- sh -c 'echo x > <company>/planted'` | Read-only file system |
| writing inside the workspace and under tmp | works |
| same home plus `sandbox_mode = "workspace-write"` | **the denied file is readable**: the profile was dropped |
| access value `none` instead of `deny` | config fails to load |
| `codex --dangerously-bypass-hook-trust exec --help` | accepted (global flag, before `exec`) |
| each disabled feature, `project_doc_max_bytes`, `shell_environment_policy` | accepted under `--strict-config` |

The first four rows are automated: `probe()` in this package runs them, `test/codex.live.test.ts` runs the probe in CI when the binary is present, and `holdco doctor` runs it on the Operator's host before any agent starts.

The bottom of the table is why the adapter never sets the SDK's `sandboxMode` (it passes `--sandbox`) or `networkAccessEnabled`, and never writes `sandbox_mode`.

### 4. Still open

| # | Item | Plan |
|---|---|---|
| R8a | **Closed.** Verified without a model: a mock Responses API (local `model_providers.mock`) made CLI 0.164.0 call `exec` → `tools.exec_command`; the kernel guard ran as the PreToolUse hook (`tool_name: "Bash"`, `tool_input.command`), exit 2 blocked writes to the company's `governance/`, reads of `.holdco/` and writes to the project's `.codex/`, and let a worktree write through. The hook is a child of the codex process, so the adapter now passes `HOLDCO_COMPANY_ROOT`, `HOLDCO_PROJECT_ROOT`, `HOLDCO_PROJECT_LOCKED`, `AGENT_ID`, `AGENT_DEPT` in its env | Codex 0.164 runs tools in "code mode": the model calls `exec` with JavaScript that invokes `tools.exec_command`; hooks still fire per shell command. Note also that `codex exec` appends `[projects.<cwd>] trust_level = "trusted"` to the session's `config.toml` — harmless because the home is per session |
| R8b | Profile enforcement on macOS (Seatbelt) | the doctor probe runs there; Linux verified so far |
| — | Usage arrives only at turn end | the adapter limits actions and time; the ledger reconciles against billing |
| — | Example prices in presets | replace with your provider's current rates; the schema refuses a Codex model with no price |

Model ids and prices: `codex debug models` (CLI 0.164.0) lists `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-*`, `gpt-5.5` with effort levels low…ultra; list prices in `config/models.ts` were checked on 2026-10-26 against three price tables synced from OpenAI's pricing page (benchlm.ai, morphllm.com, cloudinsight.cc).

Sources: Codex hooks and permissions documentation (developers.openai.com/codex/hooks, /codex/permissions), Codex SDK 0.164.0 source (`dist/index.js`: argument construction, binary resolution).

---

## 한국어

### 1. 매핑

위 표와 같습니다. Codex에는 시스템 프롬프트 옵션이 없어서 회사 지시문을 첫 입력 앞에 붙이고, 프로젝트 `AGENTS.md`는 워크트리에서 읽지 않도록 끈 뒤(`project_doc_max_bytes = 0`) 커널이 기본 브랜치에서 읽어 넣습니다. 권한은 작업 공간 쓰기 여부와 웹 검색으로, 잠금은 커널 소유 `CODEX_HOME`의 권한 프로필로, 가드는 같은 컴파일 바이너리를 커맨드 훅으로, 회사 도구는 세션 토큰이 붙은 MCP로 연결합니다. 엔진 고유 다중 에이전트는 끄고 주니어는 커널 세션으로 띄웁니다. 턴 한도와 세션 중 예산 상한이 없어서 어댑터가 완료된 행동 수와 시간으로 직접 끊고, 비용은 토큰 × 가격표로 계산합니다.

### 2. 생성되는 홈

위 표와 같습니다. 세 파일(`config.toml`, `hooks.json`, 래퍼 `bin/codex`)이 `.holdco/sessions/<id>/codex-home/`에 생기고, `.holdco/`는 모든 세션의 명령에서 읽기가 막혀 있으므로 에이전트는 자기 설정이나 토큰을 볼 수 없습니다. 규칙 우선순위는 `deny` > `write` > `read`이고, 네트워크는 부서가 도메인을 허용할 때만 켜며 그때는 Codex 프록시를 함께 켭니다(프록시 없이는 도메인 규칙이 적용되지 않음).

### 3. 확인한 것과 방법

SDK에 들어 있는 Codex CLI 0.164.0 바이너리로 Linux에서 모델 호출 없이 확인했습니다. 결과는 위 표와 같습니다. 차단해야 할 경로는 읽히지 않고, 작업 공간 밖 쓰기는 실패하고, 안쪽 쓰기는 됩니다. **`sandbox_mode`를 함께 쓰면 프로필이 조용히 무시되어 차단해야 할 파일이 읽혔고**, `none` 값은 설정 로드 자체가 실패했습니다. 이전 어댑터에 두 문제가 모두 있었고 지금은 고쳤습니다. 앞의 네 항목은 자동화되어 있습니다. 이 패키지의 `probe()`가 실행하고, CI의 `test/codex.live.test.ts`와 운영자 호스트의 `holdco doctor`가 에이전트 시작 전에 돌립니다.

### 4. 아직 열린 것

위 표와 같습니다. 래퍼를 통한 훅이 `codex exec`에서 실제로 발동하는지는 모델 호출이 있어야 보이므로 M3에서 확인하고, 그 전까지는 권한 프로필만으로 경계를 지킵니다. macOS 집행, 턴 종료 시에만 오는 사용량, 프리셋의 예시 가격도 남아 있습니다.
