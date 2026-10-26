# 05 — Security: Threats, Layers, Residual Risk

---

## English

### 1. Threat model

The adversary is **an agent in this company**: misaligned, mistaken, or steered by prompt injection from content it reads (web pages, issues, dependencies, project files). It runs as the same OS user as the supervisor unless the sandbox confines it.

| Asset | What an agent might try | Why it matters |
|---|---|---|
| Standards: `evals/`, `governance/`, `company.yaml`, executive and judge definitions | Edit a rubric, weaken the judge, raise its own tier | Self-improvement turns into reward hacking |
| Control: `control/interrupts.json`, Operator CLI | Remove an interrupt, approve its own work | Defeats the Operator's stop button |
| Budget | Loop, over-spawn, raise caps | Money |
| Secrets | Read env vars, key files, transcripts | Production, accounts, funds |
| State DB | Read canaries and labels; forge verdicts or approvals | Defeats calibration and dual control |
| Future sessions | Plant hooks, MCP servers, or instructions in project files | Persistence beyond the session and outside the sandbox |
| Operator identity | Publish or commit to obligations in the Operator's name | Reputation, legal exposure |
| Production | Deploy, delete, rotate keys | Irreversible damage |

### 2. Layers

| Layer | Where | Covers | Gap it leaves |
|---|---|---|---|
| L-a Engine deny rules | Claude: `managedSettings` (policy tier, restrictive-only). Codex: permission profile entries (`read` for locked paths, `deny` for unreadable ones) | Edit/Write/Read tools and patches on locked paths; project files cannot loosen them | Claude: which keys survive filtering is unconfirmed (R1) |
| L-b OS sandbox | Claude: SDK `sandbox` (`bubblewrap` / Seatbelt), `failIfUnavailable`, `allowUnsandboxedCommands: false`. Codex: permission profile `holdco` in a kernel-owned `CODEX_HOME`, never mixed with `sandbox_mode` (D41) | Shell commands cannot write the company root (Improvement: except its worktree) or `.holdco/`, cannot read `.holdco/`, canaries or host credentials (D42); network allowlist; model keys kept out of shell env | Needs the platform sandbox (R2). Codex: verified on Linux by doctor's probe; macOS open (R8b) |
| L-c Guard | Claude: in-process `hooks.PreToolUse`. Codex: the compiled guard as a command hook, run with hook trust waived for the kernel's home only. Same decision code everywhere | Interrupts; company locks **resolved in both repositories**; project-fixed and configured locks; org files editable only from an Improvement worktree; junior worktree rule; juniors barred from company tools. Identity from the closure | A bug here is a bug in every session |
| L-d Project settings not loaded | Claude: `settingSources: []` for project sessions. Codex: per-session `CODEX_HOME` that trusts no project; `project_doc_max_bytes = 0` | Nothing in a project's `.claude/`, `.codex/`, `.mcp.json`, hooks or worktree `AGENTS.md` reaches a session | — |
| L-e Binary hook | `.claude/settings.json` and `.codex/hooks.json` wrappers | Sessions started in the company repo outside the supervisor, on either engine; symlink-aware; fail-closed | Shell heuristics only (R3); a hand-started Codex session runs the hook only after the Operator trusts it |
| L-f Tools instead of access | role-scoped tools on the company MCP endpoint, one token per session (D36); executors | Agents never hold the DB, merge rights, or production secrets | Handlers must validate every input |
| L-g Release and diff gates | sessions built from the release tag; `tierForChange` | A live edit cannot change the next session; a merge touching locked or approval-required paths is T3 | — |
| L-h Merge-time | CODEOWNERS + branch protection | Anything that slips through still cannot merge into a locked path | Relies on the Operator's GitHub account (R7) |
| L-i Outside our code | Provider spend cap; external heartbeat | Last stop for money; an alert when everything is down | Operator-configured, not verifiable by doctor |

### 3. Specific holes, and what closes them

| Hole | Closed by | Status |
|---|---|---|
| A project session writes `/…/company/company.yaml` or `control/interrupts.json` by absolute path | L-c resolves the path into the company repo and blocks it; L-b denies the shell route | guard implemented, tested |
| An agent plants a hook or MCP server in a project for the next session (`.claude/`, `.codex/`, `.mcp.json`) | L-d (never loaded); `PROJECT_FIXED_LOCKED` in L-c; diff gate makes such a merge T3 | implemented, tested |
| An agent edits the worktree's `AGENTS.md` to steer the next session on the same ticket | instructions come from the release tag and the project's default branch, never from the worktree (D39); Codex `project_doc_max_bytes = 0` | implemented in adapters |
| A Codex session's sandbox silently falls back to the legacy mode | the adapter never sets `sandbox_mode`, `--sandbox` or `networkAccessEnabled`; doctor probes that a denied path is unreadable before agents start | implemented, verified on Linux |
| A Codex session spawns its own subagents outside the kernel | `features.multi_agent = false`; delegation only through `delegate_start` (D37) | implemented |
| Improvement edits the judge or an executive definition in the live checkout | L-c allows org edits only inside its worktree; L-g builds sessions from the release tag; `tierForChange` makes the merge T3 | implemented, tested |
| An agent sets `AGENT_DEPT=improvement` in its shell | Identity is bound in the session closure (L-c, L-f) | by construction |
| An agent runs `holdco inbox approve` or `resume` | Loosening commands need an interactive terminal (D29); L-b denies writes to `.holdco/` and `control/` | design |
| An agent writes a script, then runs it to modify the DB or a locked file | L-b; L-h | design |
| A symlink points at a locked file | `realpath` resolution in L-c and L-e | implemented, tested |
| A junior writes into the main checkout or calls company tools | juniors are kernel sessions whose writable root is their worktree and whose token has no tools (D37); L-c also checks `agent_id` / `agent_type` when reported | implemented (guard); tools in M3 |
| An agent reads secrets | No production secrets in sessions (D14); host credential paths denied (D42); Codex shells drop `*KEY*`/`*TOKEN*`/`*SECRET*` env vars | adapters implemented; credential list applied in M3 |
| An agent edits `node_modules/` to change the hook | Compiled hook embeds its dependencies; `node_modules/` locked | implemented |
| An agent spends without limit | Session gate; Claude `maxBudgetUsd`; Codex: adapter action limit and timeout, metering from the price table; ledger; provider cap | adapters implemented |
| An agent forges an approval | Approvals are written only by kernel tools after role checks, or by the Operator's terminal | design |
| The COO stops judging | Canaries (unreadable), disagreement-rate monitoring, canary approval → L3 | design |
| Prompt injection via research content | `junior-reader` has no write tools; findings are data in a return form; Verification is independent | design |

### 4. Residual risk

| # | Risk | Status | Plan |
|---|---|---|---|
| R1 | `managedSettings` drops "non-allowlisted keys"; which deny and sandbox keys survive is undocumented | open | M3 spike: start a session with managed deny rules, attempt blocked writes, assert failure. Independent of the answer, L-c now resolves both repositories and blocks Edit/Write into the company root, and L-b covers the shell; L-a is defense in depth, not the only barrier |
| R2 | Sandbox unavailable on some hosts | open | Doctor fails; sessions refuse to start. No unsandboxed mode in v1 |
| R3 | Binary hook's shell heuristics are not a sandbox | accepted | It guards only unsupervised sessions; supervised ones rely on L-b |
| R4 | `total_cost_usd` is an estimate | accepted | Reconciliation; provider cap |
| R5 | Supervisor and sessions share an OS user | open | M7: sessions as a separate OS user or in a container with the company repo read-only |
| R6 | The repo token can push arbitrary branches | accepted | Branch protection; merges only by the kernel executor |
| R7 | The Operator's GitHub account is the root of trust for CODEOWNERS | accepted | 2FA / hardware key; a separate GitHub App for the executor |
| R8 | Codex configuration keys come from documentation, not SDK types | **narrowed** | Verified on Codex CLI 0.164.0 / Linux: `--strict-config` accepts every key; `codex sandbox` shows denied reads and outside writes fail; two bugs found and fixed (D41). Open: R8a hooks firing under `codex exec` (needs a model turn, M3 smoke); R8b macOS Seatbelt (doctor probe runs there). The profile, not the hook, is the boundary meanwhile |
| R9 | Codex reports usage only at turn end, so spend inside a turn is not capped by the engine | accepted | Cap reserved from the share before dispatch; adapter action limit and timeout; reconciliation; provider cap |

---

## 한국어

### 1. 위협 모델

공격자는 **회사 안의 에이전트**입니다. 정렬이 어긋났거나, 실수했거나, 읽은 콘텐츠의 프롬프트 인젝션에 조종당한 경우입니다. 샌드박스가 가두지 않으면 슈퍼바이저와 같은 OS 사용자로 돕니다. 지킬 자산은 위 표와 같으며, 리뷰 이후 **통제 장치**(컨트롤 파일, 운영자 CLI)와 **미래 세션**(프로젝트 파일에 훅·MCP 서버·지시를 심어 세션을 넘어 지속되는 공격)이 추가됐습니다.

### 2. 방어 겹

위 표와 같습니다. 리뷰 이후 바뀐 점:
- **L-c 프로세스 내 가드**가 회사 레포와 프로젝트 레포 **양쪽으로 경로를 해석**합니다. 프로젝트 고정 잠금과 설정된 잠금, 조직 파일은 개선팀 워크트리에서만 수정 가능, 주니어 워크트리 규칙, 주니어의 회사 도구 호출 차단이 들어갔습니다(구현·테스트 완료).
- **L-d 프로젝트 설정 미로드**(`settingSources: []`)가 새로 생겼습니다. 프로젝트의 `.claude/`, `.mcp.json`, 훅은 세션에 아무것도 전달하지 못합니다.
- **L-g 릴리스·diff 관문**이 새로 생겼습니다. 라이브 수정은 다음 세션을 바꾸지 못하고, 잠긴 경로나 승인 필요 경로를 건드리는 머지는 T3입니다.
- **엔진별 겹.** 같은 겹을 엔진마다 다른 장치로 구현합니다. Claude는 managed deny 규칙, SDK 샌드박스, 프로세스 내 훅, `settingSources: []`. Codex는 커널 소유 `CODEX_HOME`의 권한 프로필(`sandbox_mode`와 절대 섞지 않음), 신뢰 절차를 커널 홈에 한해 생략한 커맨드 훅, 어떤 프로젝트도 신뢰하지 않는 홈과 `project_doc_max_bytes = 0`입니다. 판정 코드는 어디서나 같습니다.

### 3. 구체적인 구멍과 막는 장치

위 표와 같습니다. 리뷰가 찾은 세 가지 심각한 구멍은 모두 코드로 막고 테스트했습니다. 프로젝트 세션이 절대 경로로 회사 설정이나 컨트롤 파일을 쓰는 경로, 프로젝트에 훅이나 MCP 서버를 심는 경로, 개선팀이 라이브 체크아웃에서 심판이나 경영진 정의를 고치는 경로입니다. 에이전트가 운영자 CLI로 승인이나 재개를 시도하는 경로는 대화형 터미널 요구(D29)와 샌드박스가 막습니다.

### 4. 남은 위험

위 표와 같습니다. 엔진 레이어가 들어오면서 R8(Codex 설정 키가 SDK 타입이 아니라 문서에서 옴)과 R9(Codex는 턴이 끝날 때만 사용량을 알려줘서 턴 중 지출을 엔진이 막지 못함)가 추가됐습니다. R8은 Codex CLI 0.164.0으로 Linux에서 직접 확인해 크게 줄였습니다. 모든 키가 `--strict-config`를 통과하고, `codex sandbox`로 차단 경로 읽기와 작업 공간 밖 쓰기가 실패하는 것을 확인했으며, 그 과정에서 프로필이 무시되던 버그 두 개를 찾아 고쳤습니다(D41). 남은 것은 `codex exec`에서 훅이 실제로 발동하는지(R8a, M3)와 macOS(R8b)이고, 그동안 경계는 훅이 아니라 권한 프로필입니다. R1의 대체 수단 설명을 바로잡았습니다. 이제 L-c가 두 레포를 모두 해석해 회사 루트로의 Edit/Write를 막고 L-b가 셸 경로를 막으므로, managed 키가 걸러지더라도 L-a는 유일한 방벽이 아니라 추가 방어선입니다.
