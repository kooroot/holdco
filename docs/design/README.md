# Holdco — Build Design

> How Holdco becomes a product anyone can install: `bunx create-holdco`, choose a preset and engines, get a company that runs 24/7 on Claude Code, Codex, or both.
> Holdco를 누구나 설치할 수 있는 제품으로 만드는 방법입니다. `bunx create-holdco`로 프리셋과 엔진을 고르면 Claude Code, Codex, 또는 둘 다로 24/7 도는 회사가 만들어집니다.

---

## English

### Reading order

| File | Answers |
|---|---|
| `01-components.md` | What every company must have, what is optional, and why |
| `02-config.md` | The single configuration file and how it encodes those rules |
| `03-runtime.md` | The supervisor: how work starts, survives crashes, and stays within budget |
| `04-init-and-packaging.md` | What ships as a package, what is copied as templates, how `init` works |
| `05-security.md` | What an agent could try, what stops it, what is still open |
| `06-roadmap.md` | Milestones, exit criteria, tests, risks |
| `07-engines.md` | Claude Code and Codex per role: the engine contract, capability matrix, compensations, what was verified |
| `08-execution-and-release.md` | External executors, GitHub merges, the urgent inbox, canary rollout of organization changes, the replay gate |
| `../engines/claude-code.md`, `../engines/codex.md` | Each adapter in detail |

### What is already built (M0, M1, engine layer)

| Piece | Where | Status |
|---|---|---|
| Specification (constitution, governance, org, protocols, evals) as templates | `packages/kernel/templates/base`, `modules/*` | done; no `${…}` placeholders left |
| Enforcement hook: locks + interrupts, compiled, fail-closed; Claude and Codex payloads (`apply_patch`, `exec_command`) | `packages/kernel/src/hook.ts`, `hooks/guard.ts` | done, ~12 ms per tool call |
| Two-repository guard; project-fixed locks (incl. `.codex/`); junior worktree rule; worktree-only org edits | `hooks/guard.ts`, `policy/paths.ts` | done |
| Brief / return contracts as Effect Schema | `packages/kernel/src/protocol/` | done |
| `company.yaml` schema: modules, engines, roles, every composition rule | `config/company.ts` | done |
| Effective tier; diff-based tier for merges; graduation and demotion | `policy/` | done |
| Scaffold: presets + base + modules → validated company repo, git `r0` | `scaffold/`, `create-holdco` | done (non-interactive); wizard is M4 |
| Engine contract, neutral role files, compensations | `engine/` | done |
| Claude adapter | `packages/engine-claude` | done, typechecked against Agent SDK 0.3.310, unit-tested |
| Codex adapter + host probe | `packages/engine-codex` | done, typechecked against Codex SDK 0.164.0; sandbox verified against the real CLI |
| CLI: init, doctor (incl. engine probes), build-hook, config check, engines, validate, presets, schemas, examples | `packages/kernel/src/cli.ts` | done |
| Store, ticket state machine, company MCP tool server, supervisor loop, executors, digest, Operator CLI, one-shot `create-holdco` | `packages/kernel/src/{store,supervisor,cli}/` | done; simulated with a scripted engine over real git and MCP |
| Tests | `packages/*/test/` | 300+ passing, incl. supervisor simulations and the CLI end to end |

### Decision log

Every decision below was made against the five invariants in `01-components.md`. "Verified" means the API was confirmed by installing the package and reading its type definitions, not from memory.

| # | Decision | Why | Basis |
|---|---|---|---|
| D1 | Kernel ships as an npm package; modules are copied into the company repo as templates (shadcn-style) | The kernel must be upgradable and untouchable by agents; modules must be editable by Improvement | Lock model |
| D2 | One locked `company.yaml`. Required-fixed parts are absent from it, required-adjustable parts carry kernel floors, optional parts are switches | Config shape mirrors the component classes; 46 scattered placeholders collapse into one validated file | Implemented |
| D3 | Turning a module off tightens: no COO ⇒ T2 runs as T3. Demotion is automatic; promotion needs the Operator | Safety degrades toward more human approval, never less | Implemented, tested |
| D4 | Sessions run through engine SDKs inside the supervisor (Claude Agent SDK `query()`, Codex SDK threads), not by scripting CLIs | Abort, structured results, budgets and hooks under the kernel's control. Generalized by D35 | Verified, Agent SDK 0.3.310, Codex SDK 0.164.0 |
| D5 | One ticket per session; continuity lives in tickets, branches and returns, never in a long-lived context | Long contexts degrade judgment and cost; short sessions are crash-safe | Spec principle |
| D6 | State in SQLite under `.holdco/` via `@effect/sql-sqlite-bun`; unreadable to agents | Holds canaries and labels; leases need transactions | Verified, 4.0.6 |
| D7 | Agents reach the kernel only through role-scoped tools; identity is bound when the session is created, never taken from the agent | An agent can set environment variables in its own shell; it cannot change what the kernel bound to its session. Transport amended by D36 | Design |
| D8 | Tickets are leased with compare-and-set; a reaper reclaims expired leases; `max_attempts` then `blocked` | A session that dies mid-ticket must not strand the ticket | Design |
| D9 | Budget in three layers: per-session SDK cap, department ledger, provider hard cap outside our code | The last stop must be one no agent and no bug of ours can bypass | Verified (`maxBudgetUsd`, `total_cost_usd`) |
| D10 | Interrupts are active: matching running sessions are aborted, not just blocked at the next tool call | L1/L2 should stop a session now, not when it next acts | Verified (`abortController`, `interrupt()`) |
| D11 | Locks in layers: SDK `managedSettings` deny rules, OS sandbox, in-process guard over both repositories, project settings never loaded, binary hook for unsupervised sessions, tools instead of access, diff-based tier, CODEOWNERS | Each layer covers a hole in another (see `05-security.md`) | Options verified; managed-key survival confirmed in M3 (R1) |
| D12 | Project code stays in its own repositories; the supervisor injects the company layer into each session. Project sessions load no project config (Claude `settingSources: []`, Codex a per-session `CODEX_HOME`) and get the project's `AGENTS.md`/`CLAUDE.md` as text | No copying into projects; nothing a project file says can load hooks or servers into a session | Design; adapters implemented |
| D13 | Juniors may write only inside a worktree | SDK `AgentDefinition` has no `isolation` field; the guard sees `agent_id` / `agent_type` | Implemented, tested |
| D14 | Secrets never enter agent sessions; deploy and publish run through kernel executors after the tier check | Supersedes "Operations holds secrets" in `org/departments/operations.md` (spec change scheduled in M3) | Design |
| D15 | Alerts via Telegram, Slack, or webhook; heartbeat URL as a dead man's switch; doctor sends a real test message | "Alert the Operator" must name a channel that is proven to work | Implemented in schema |
| D16 | Superseded by D34 | — | — |
| D17 | Linux + systemd is the recommended host; macOS + launchd supported; `manual` is allowed but doctor warns it is not 24/7 | A laptop sleeps | Design |
| D18 | Supervisor runs on Bun; kernel logic uses `node:` modules where possible | `bun:sqlite`, compiled hook; Node-based orchestrators can host adapters later | Design |
| D19 | Verdicts and session reports use SDK `outputFormat: json_schema`, fed by the Effect-generated JSON Schemas | Structured output enforced by the model API, validated again by Effect | Verified |
| D20 | Improvement stays dormant until the replay set holds `replay_min_tickets` labeled tickets, even when enabled | Without enough ground truth, "eval gain" is noise | Design |
| D21 | Missing the weekly audit `freeze_after_missed` times freezes graduation and improvement (L3) | Makes "the audit is mandatory" enforceable | Schema; job in M3 |
| D22 | Every session has its own worktree: `t-<id>` per ticket, `t-<id>-<brief>` per junior, `v-<id>` for Verification, `imp-<id>` for Improvement | Concurrent sessions must never share a checkout | Design (review finding 6) |
| D23 | Sessions are built from the latest **release tag** of the company repo; Improvement edits only in its worktree; merges whose diff touches locked or approval-required paths are T3 | The organization changes once per release, and the judge or executives never change without the Operator | Implemented: guard + `tierForChange` (finding 1) |
| D24 | The guard resolves paths into the company repo *and* the project; every project locks `.claude/settings*`, hooks, agents, skills, `.mcp.json` | A project session could otherwise write company files by absolute path or plant a hook | Implemented, tested (findings 2, 3) |
| D25 | The ticket pipeline: every state has exactly one owner the supervisor dispatches; Verification and post-verification steps are dispatched; `blocked` exits through the CEO or the Operator; crashes and rejections count as attempts | No ticket can stop moving or loop forever | Design (findings 4, 5) |
| D26 | L1/L2 flag tickets as paused (branch, worktree, attempts kept); L4 is one-shot (roll back, clear itself, resume); `init` tags `r0` | Matches `interrupts.md` ("stops, keeps state"; "restarts agents") | Design (findings 7, 8) |
| D27 | Every tripwire in `interrupts.md` has a named detector | "Always trips" must be true in code | Design (finding 9) |
| D28 | Approvals follow `approvals.md` exactly: T2 and T3 pass CEO proposal → COO review; T3 then the inbox with the COO's position; with modules off, routing collapses toward the Operator | Dual control applies to both tiers | Design (finding 10) |
| D29 | Operator commands that loosen anything (approve, resume, promote, rollback, unblock) require an interactive terminal; agent shells cannot write the DB or control file anyway (sandbox) | An agent can set `OPERATOR_SESSION=1` in its own shell | Design (finding 2) |
| D30 | The kernel renders the deterministic digest itself; the CEO only adds narrative | Constitution 6.3: the digest may not be skipped | Design (finding 13) |
| D31 | Graduation floors 20 samples / 0.9 agreement; fixed conditions (last 10 agree, no rollback, no missed canary, not frozen); judge (engine, model) differs from every producer's | Floors were too far below the spec's defaults | Implemented, tested (finding 12) |
| D32 | A challenge-window job finalizes T2 actions; `holdco rollback` runs the recorded undo, marks `rolled_back`, demotes the action type; release-watch raises L4 | Rollback was unreachable | Design (finding 11) |
| D33 | One session gate for every job (interrupts, budget share, slots); slot priority Verification → executive → production; COO silence times out to the inbox | Executive jobs bypassed budget and interrupts | Design (finding 13) |

| D34 | The product is **Holdco**: CLI `holdco`, packages `@holdco/kernel`, `@holdco/engine-*`, entry `create-holdco`, state in `.holdco/`. Replaces the first name (Dure) | English and easy to remember, and it describes the design: one owner, projects run like portfolio companies, the owner sets the charter and budget, audits and intervenes. The bare name, the `@holdco` scope and `create-holdco` were all free on npm (checked 2026-10-26) | Naming |
| D35 | Engine-neutral sessions: the kernel builds a `SessionSpec`; an `Engine` (capabilities, `run`, optional `probe`) per package executes it and returns one `Outcome`. Every capability gap maps to a named kernel compensation; a test fails on an uncompensated gap | Claude Code and Codex differ in system prompts, hooks, cost reporting and budget caps; the rules must not | Implemented, tested |
| D36 | Company tools on one MCP endpoint served by the supervisor on `127.0.0.1`, one bearer token per session bound to (session, role, ticket); juniors' tokens carry no tools (amends D7) | Both engines speak MCP; an in-process server only exists on one of them | Design; adapters implemented |
| D37 | Delegation through the kernel: `delegate_start` / `delegate_wait`; native subagents off on every engine (`Agent`/`Task` disallowed; Codex `multi_agent = false`); a junior may run on a different engine from its senior | Junior worktree rule, per-task cap, budget and identity identical across engines; no reliance on subagent identity in hooks | Implemented in adapters; tools in M3 |
| D38 | `company.yaml` gains `engines` (auth env var, Codex price table) and `roles` (engine, model, effort per kind; per-department seniors). Independence is compared on (engine, model). Role files move to neutral `org/roles/*.md` with capabilities | Per-role choice without per-engine role files | Implemented, tested |
| D39 | `AGENTS.md` is the canonical company instruction file; `CLAUDE.md` is one line, `@AGENTS.md`. Instructions always reach a session as text from the release tag, never as engine config | One file both engines read; nothing in a worktree changes the next session's instructions | Implemented |
| D40 | Templates live in the kernel package; `examples/` are generated from presets and checked by a test. Presets: `solo-dev` (Claude), `solo-codex` (Codex), `full` (both; COO and judge on Codex) | A kernel version and its templates can never drift | Implemented, tested |
| D41 | Codex sandbox = permission profile in a kernel-owned `CODEX_HOME`; never `sandbox_mode`, `--sandbox` or `networkAccessEnabled` (any of them silently drops the profile); access values `read`/`write`/`deny`; hooks run through a wrapper adding `--dangerously-bypass-hook-trust`; doctor probes the profile with `codex sandbox` | Found by testing against the CLI binary: the first adapter wrote `sandbox_mode` (profile ignored, denied file readable) and `none` (config fails) | Verified, Codex CLI 0.164.0, Linux (R8 narrowed) |
| D42 | Every session denies reads of host credentials (`~/.config/holdco`, `~/.ssh`, cloud and package-manager credentials, `~/.codex`, `~/.claude`); Codex shells drop `*KEY*`/`*TOKEN*`/`*SECRET*` env vars | The env file holds every key; the engine homes hold the Operator's logins | Constant implemented; applied by the supervisor in M3 |

| D43 | The supervisor is plain async TypeScript with an injected clock and injected engines; Effect is used for schemas and validation. Effect services and `TestClock` are deferred | Shipping a loop that is tested over real git and real MCP mattered more than the service abstraction; the seams (`now`, `engines`, `notifier`, `store`) give the same testability | Implemented |
| D44 | Company tools are served from the kernel package itself with `@modelcontextprotocol/sdk` (stateful Streamable HTTP, one transport per session, JSON responses) | Verified against the SDK: a stateless transport cannot serve two requests; one server+transport per session binding keeps tokens and tool lists per session | Verified, SDK 1.32.2 |
| D45 | Gates are evidenced by Verification: every gate an action lists except `verification-approved` must appear as passed in the verdict's `gates`, or the kernel rejects the ticket back with the missing gate named | The kernel cannot run a project's CI; the judge can, and must say so with evidence | Implemented, tested |
| D46 | Actions without an executor become `manual_action` inbox items the Operator performs and approves; `merge` and `branch` are built in, everything else is declared by the Operator (D50) | Honest about what is automated; nothing silently no-ops | Implemented |
| D47 | `create-holdco` is one shot: scaffold → first project registered → `governance/strategy.md` rendered from `company.yaml` → `bun install` → guard built → doctor. `--github` is required; the remaining Operator inputs are printed | A company that cannot run after one command is not a product | Implemented, tested |
| D48 | Self-improvement is gated on the Operator's labels: the Improvement cycle stays dormant until `replay_min_tickets` tickets are blind-graded (D20), then opens at most two tickets a week for itself; its merges become candidate releases (D53); release-watch raises L4 on a demotion within `policy.release.watch` | Without ground truth, "improvement" is drift | Implemented |

| D49 | `engines.<id>.auth: api_key \| subscription`. Claude defaults to the Operator's Pro/Max login (Anthropic: Agent SDK usage draws from plan limits; Max/Team include API credits); Codex defaults to an API key, with `subscription` copying `~/.codex/auth.json` into the session home (OpenAI recommends keys for scripted use). Costs stay in USD at API rates so budgets and tripwires are unchanged; doctor checks `claude auth status` / `codex login status` | Running 24/7 on API billing alone is expensive; a plan the Operator already pays for should be usable where the provider allows it | Implemented, tested |
| D50 | `company.yaml:executors.<action>`: an argv (no shell) with placeholders `{branch} {ticket} {deliverable} {previous}`, an env allowlist, an optional `undo` and timeout. The kernel runs it at the action's tier (T0/T1 after the verdict, T2/T3 after approval), records output and undo in the action log, and `holdco rollback` runs the undo. `rollback-tested` is evidenced by the undo's existence; doctor checks the command exists | Operations and GTM are pointless if every deploy or post is a manual item; the Operator, not an agent, decides what the kernel may run | Implemented, tested (`08-execution-and-release.md`) |
| D51 | Per project `merge: local \| github`. `github` pushes the branch, opens or reuses a PR, waits for checks (`merge_wait`, default 20m), merges with `gh pr merge --merge`; a GitHub refusal (branch protection, CODEOWNERS) rejects the ticket with the reason. Undo is the merge-commit revert | Teams gate on GitHub; the L-h layer should actually be in the loop | Implemented, tested with a scripted `gh` |
| D52 | Inbox items carry `urgency`. Urgent (blocked or cannot-score on a `core` project past `blocked_after`, CEO–COO objection on a `core` project, candidate withdrawal) alerts at critical severity at once; routine items are summarized once a day at `policy.inbox.batch_at` and in the digest. Timeout-to-reject applies to both | `approvals.md` promised "urgent: immediately"; the kernel only timed items out | Implemented, tested |
| D53 | An Improvement merge tags `rc-<n>`, a candidate. `policy.release.canary_traffic` of new production sessions (never Verification, never executives) run on the candidate organization, recorded in `sessions.release`. After `policy.release.watch` it is promoted to `r<n>` if candidate sessions' rejection rate ≤ baseline + `max_regression` and no demotion occurred; otherwise it is withdrawn, organization paths on `main` revert to the release, and an urgent inbox item is filed. L4 withdraws the candidate. `holdco release` promotes at once; `holdco release withdraw` withdraws | Switching every session to a new organization at once left L4 as the only safety net | Implemented, tested |
| D55 | Operator notes: comments on a ticket (`ticket_comments`) are a binding prompt section for every later session on it (senior and judge), newest last; a running session does not see them. The dashboard is the second front for every Operator operation (tickets, notes, roles, settings, approvals, grading, releases, interrupts), on 127.0.0.1 with a token agents cannot read | The Operator needs to steer work without a terminal and without breaking "one session, one ticket"; a chat with an agent would | Implemented, tested |
| D56 | Telegram bridge: the supervisor long-polls the Operator's bot; inbox items are delivered with Approve/Reject buttons, and commands (status, tickets, note, unblock, new, pause/resume, halt-with-confirmation) run through `act`, so the kernel's rules apply unchanged. Only the paired chat is obeyed; `holdco telegram setup` pairs by the first message received | 24/7 operation means decisions arrive when the Operator is away from a keyboard | Implemented, tested against a fake Bot API |
| D57 | The dashboard is a typed contract, not a page: `packages/kernel/src/dashboard/contract.ts` defines the API as an Effect `HttpApi` (six endpoints, every input and output an Effect Schema), the kernel serves it from `Bun.serve` through `HttpApiBuilder` + `HttpRouter.toWebHandler` with OpenAPI at `/api/openapi.json`, and the client (`packages/dashboard`: React 19, TanStack Router and Query, zyzz for styling, Vite) derives a typed `HttpApiClient` from the same definition, so a shape change fails `tsc` on both sides. The built client ships as `dashboard-dist/` in the kernel package; a checkout builds it on demand when `holdco dashboard` finds it missing or stale | One source for the server handlers, the browser client and the API document; a single hand-written HTML file could not be typed against the kernel, and the Operator's UI is where the product is judged, so it needs the same toolchain as the kernel (Effect) and room to grow | Implemented; the client is checked by `bun run typecheck:dashboard` and screenshots, the server by `dashboard.test.ts` |
| D58 | Onboarding is a wizard: `holdco init` (or `create-holdco`) with no arguments asks seven things (directory, GitHub handle, first project from nearby repositories, organization, models from the logins found, mission, first objective; voice for the full preset; Telegram token optional) and then does every follow-up the Operator used to do by hand — models preset, objective into the strategy, voice into the rubric, token into `~/.config/holdco/<company>.env`, bot pairing, doctor. Every `holdco` command loads that env file, so `supervise` by hand equals the service. `models preset` drops an engine no role uses | Each manual step after scaffolding was a place to stop; the first run must be one command and one `smoke` | Implemented; the file edits are unit-tested, the full flow was driven through a pty |
| D59 | Session journal and live feed: every SessionEvent but `activity` is appended to `.holdco/sessions/<id>/events.jsonl` as it happens (the Claude adapter now translates SDK messages into `message`, `tool`, `command` and `file_change` events, so the loop tripwire covers both engines). `GET /api/session/:id/events?after=n` serves the lines incrementally, from any process; the ticket drawer's Live tab follows a running session (2s polling, auto-scroll) and shows the same journal as a log once it ends. Home's "Running now" opens it | "Is it doing the right thing?" has to be answerable while the session runs, not from a report afterwards; a journal on disk makes that work for `holdco dashboard` alone and survives a supervisor restart | Implemented, tested (journal, endpoint, browser polling against a seeded feed) |
| D60 | The CEO is woken for work only it can move: a ticket in `new` (triage) or at `needs_proposal` (the T2/T3 approval path) that changed after its last run wakes it within `WORK_WAKE_MS` (2 min), debounced; work it already saw waits for `ceo_cycle`. The dashboard states what every open ticket waits on (`Snapshot.waiting`: session, CEO triage, CEO proposal, COO review, your decision, a free slot, a lease, the kernel) with the expected time, on Home when nothing runs, on every board card and in the drawer | A verified T2 ticket sat for the 24h cycle with "0 sessions running" and no explanation; the Operator must never have to guess why the company is quiet | Implemented, tested (wake once per batch, not per tick) |
| D54 | Replay gate: when a candidate changes `evals/rubrics/`, the Verification charter or the judge's role file, the kernel re-judges up to `audit.weekly_sample × 4` labeled tickets (frozen branches, candidate rubric and judge, charged to Improvement) before any canary traffic. Agreement with the Operator's labels must rise by `min_gain` with no action type regressing by more than `max_regression`, else the candidate is withdrawn | D20 promised a replay; nothing ran one. Judge changes cannot be canaried: the canary's metric is the judge | Implemented, tested |

Findings 1–14 came from an independent review of the first draft; each maps to a decision above or to a correction in the files. A second review of the templates (`docs/reviews/2026-10-26-template-audit.md`) drove the protocol schemas, the tool list, the gate vocabulary and the template rewrite.

### Decisions left to the Operator

These are inputs to `init`, not blockers for building: monthly budget, host, first project, alert channel, GitHub handle, which engines and models per role, and current Codex prices.

---

## 한국어

### 읽는 순서

| 파일 | 답하는 질문 |
|---|---|
| `01-components.md` | 모든 회사에 반드시 있어야 하는 것, 선택인 것, 그 이유 |
| `02-config.md` | 하나의 설정 파일과, 그 파일이 위 규칙을 어떻게 담는지 |
| `03-runtime.md` | 슈퍼바이저: 일이 어떻게 시작되고, 크래시에서 살아남고, 예산 안에 머무는지 |
| `04-init-and-packaging.md` | 무엇을 패키지로, 무엇을 템플릿으로 복사하는지, `init`이 어떻게 동작하는지 |
| `05-security.md` | 에이전트가 무엇을 시도할 수 있고, 무엇이 막고, 무엇이 아직 열려 있는지 |
| `06-roadmap.md` | 마일스톤, 완료 기준, 테스트, 위험 |
| `07-engines.md` | 역할별 Claude Code·Codex: 엔진 계약, 기능 비교표, 보완책, 확인한 것 |
| `08-execution-and-release.md` | 외부 실행기, GitHub 머지, 긴급 인박스, 조직 변경의 카나리 배포, 리플레이 게이트 |
| `../engines/claude-code.md`, `../engines/codex.md` | 어댑터별 상세 |

### 이미 만든 것 (M0, M1, 엔진 레이어)

템플릿으로 옮긴 명세(플레이스홀더 없음), Claude와 Codex 입력을 모두 다루는 컴파일 집행 훅(툴 호출당 약 12ms, 실패 시 차단), 두 레포 가드(프로젝트 고정 잠금에 `.codex/` 포함), Effect Schema 계약, 모듈·엔진·역할과 모든 구성 규칙을 담은 `company.yaml` 스키마, 실효·diff 기반 등급과 승격·강등, 프리셋에서 검증된 회사 레포를 만드는 스캐폴드(`r0` 태그 포함, 대화형 마법사는 M4), 엔진 계약·중립 역할 파일·보완책, Claude 어댑터(Agent SDK 0.3.310 타입으로 검사), Codex 어댑터와 호스트 실측(Codex SDK 0.164.0 타입으로 검사, 실제 CLI로 샌드박스 확인), CLI(init, 엔진 실측이 들어간 doctor, build-hook, config check, engines, validate, presets, schemas, examples), 테스트 275개 통과.

### 결정 로그

모든 결정은 `01-components.md`의 다섯 불변식을 기준으로 내렸습니다. "확인됨"은 기억이 아니라 패키지를 설치해 타입 정의를 직접 읽어 확인했다는 뜻입니다.

| # | 결정 | 이유 |
|---|---|---|
| D1 | 커널은 npm 패키지, 모듈은 회사 레포에 템플릿으로 복사(shadcn 방식) | 커널은 업그레이드 가능하고 에이전트가 손댈 수 없어야 하며, 모듈은 개선팀이 고칠 수 있어야 함 |
| D2 | 잠긴 `company.yaml` 하나. 필수·고정은 파일에 없고, 필수·강도 설정은 커널 하한과 함께, 옵션은 스위치로 | 설정 모양이 구성요소 분류와 일치. 흩어진 플레이스홀더 46개가 검증되는 파일 하나로 모임 (구현 완료) |
| D3 | 모듈을 끄면 엄격해짐: COO가 없으면 T2가 T3로. 강등은 자동, 승격은 운영자만 | 안전은 사람 결재가 늘어나는 쪽으로만 후퇴함 (구현·테스트 완료) |
| D4 | 세션은 CLI를 스크립트로 돌리지 않고 슈퍼바이저 안에서 엔진 SDK로 실행(Claude Agent SDK `query()`, Codex SDK 스레드) | 중단, 구조화된 결과, 예산, 훅을 커널이 통제. D35로 일반화 (Agent SDK 0.3.310, Codex SDK 0.164.0에서 확인) |
| D5 | 세션은 티켓당 하나. 연속성은 티켓·브랜치·반환서에 두고 긴 컨텍스트에 두지 않음 | 긴 컨텍스트는 판단을 흐리고 비용을 키움. 짧은 세션은 크래시에 안전 |
| D6 | 상태는 `.holdco/`의 SQLite(`@effect/sql-sqlite-bun`), 에이전트는 읽을 수 없음 | 카나리와 라벨이 들어 있고, 임대에는 트랜잭션이 필요 (4.0.6에서 확인) |
| D7 | 에이전트는 역할별 도구로만 커널에 접근. 신원은 세션 생성 시점에 고정되고 에이전트가 보낸 값은 믿지 않음 | 에이전트는 자기 셸에서 환경변수를 바꿀 수 있지만 커널이 세션에 묶은 것은 바꿀 수 없음. 전송 방식은 D36에서 수정 |
| D8 | 티켓은 compare-and-set으로 임대, 만료된 임대는 회수, `max_attempts` 초과 시 `blocked` | 티켓 처리 중 죽은 세션이 티켓을 붙잡고 있으면 안 됨 |
| D9 | 예산은 세 겹: SDK 세션 상한, 부서 원장, 우리 코드 밖의 제공사 하드 한도 | 마지막 차단선은 어떤 에이전트도, 우리 버그도 우회할 수 없어야 함 (확인됨) |
| D10 | 인터럽트는 능동적: 다음 툴 호출을 막는 데 그치지 않고 실행 중인 세션을 즉시 중단 | L1/L2는 다음 행동 때가 아니라 지금 멈춰야 함 (확인됨) |
| D11 | 잠금은 여러 겹: SDK `managedSettings` deny 규칙, OS 샌드박스, 두 레포를 아는 프로세스 내 가드, 프로젝트 설정 미로드, 슈퍼바이저 밖 세션용 바이너리 훅, 접근 대신 도구, diff 기반 등급, CODEOWNERS | 각 겹이 다른 겹의 구멍을 막음 (`05-security.md`). 옵션은 확인, managed 키 유지 여부는 M3에서 확인(R1) |
| D12 | 프로젝트 코드는 각자의 레포에 두고, 슈퍼바이저가 세션마다 회사 레이어를 주입. 프로젝트 세션은 프로젝트 설정을 로드하지 않고(Claude `settingSources: []`, Codex 세션별 `CODEX_HOME`) 프로젝트 `AGENTS.md`·`CLAUDE.md`는 텍스트로만 받음 | 프로젝트에 아무것도 복사하지 않고, 프로젝트 파일이 세션에 훅이나 서버를 로드시킬 수 없음 |
| D13 | 주니어는 워크트리 안에만 쓸 수 있음 | SDK `AgentDefinition`에 `isolation` 필드가 없음. 가드가 `agent_id`·`agent_type`을 보고 강제 (구현·테스트 완료) |
| D14 | 시크릿은 에이전트 세션에 절대 들어가지 않음. 배포·게시는 등급 검사 후 커널 실행기가 수행 | `org/departments/operations.md`의 "운영 부서가 시크릿 보유"를 대체 (명세 수정은 M3) |
| D15 | 알림은 Telegram·Slack·webhook, 하트비트 URL을 데드맨 스위치로, doctor가 실제 테스트 메시지 발송 | "운영자에게 경보"는 동작이 증명된 채널을 가리켜야 함 |
| D16 | D34로 대체 | — |
| D17 | 권장 호스트는 Linux + systemd, macOS + launchd 지원, `manual`은 허용하되 doctor가 24/7이 아니라고 경고 | 노트북은 잠듦 |
| D18 | 슈퍼바이저는 Bun 위에서, 커널 로직은 가능한 한 `node:` 모듈로 | `bun:sqlite`, 컴파일 훅. 나중에 Node 기반 오케스트레이터가 어댑터를 호스팅 가능 |
| D19 | 판정과 세션 보고서는 SDK `outputFormat: json_schema`에 Effect가 생성한 JSON Schema를 넣어 강제 | 모델 API가 구조를 강제하고, Effect가 한 번 더 검증 (확인됨) |
| D20 | 개선팀은 켜져 있어도 라벨 붙은 리플레이 티켓이 `replay_min_tickets`개 쌓일 때까지 휴면 | 정답 데이터가 부족하면 "평가 상승"은 노이즈 |
| D21 | 주간 감사를 `freeze_after_missed`번 건너뛰면 승격과 개선이 동결(L3) | "감사는 의무"를 실제로 강제 (스키마 완료, 작업은 M3) |
| D22 | 모든 세션은 자기 워크트리를 가짐: 티켓 `t-<id>`, 주니어 `t-<id>-<brief>`, 검증 `v-<id>`, 개선 `imp-<id>` | 동시 세션이 체크아웃을 공유하면 안 됨 (리뷰 지적 6) |
| D23 | 세션은 회사 레포의 최신 **릴리스 태그**로 조립. 개선팀은 워크트리에서만 수정. diff가 잠긴 경로나 승인 필요 경로를 건드리는 머지는 T3 | 조직은 릴리스 단위로만 바뀌고, 심판과 경영진은 운영자 없이 절대 바뀌지 않음 (가드 + `tierForChange` 구현, 지적 1) |
| D24 | 가드가 경로를 회사 레포와 프로젝트 양쪽으로 해석. 모든 프로젝트에서 `.claude/settings*`, 훅, 에이전트, 스킬, `.mcp.json` 잠금 | 그렇지 않으면 프로젝트 세션이 절대 경로로 회사 파일을 쓰거나 훅을 심을 수 있음 (구현·테스트 완료, 지적 2·3) |
| D25 | 티켓 파이프라인: 모든 상태에 슈퍼바이저가 배분하는 주인이 정확히 하나. 검증과 검증 이후 단계도 배분됨. `blocked`는 CEO나 운영자를 통해 빠져나감. 크래시와 반려는 시도 횟수로 셈 | 어떤 티켓도 멈추거나 무한히 돌 수 없음 (지적 4·5) |
| D26 | L1/L2는 티켓에 일시정지 표시(브랜치·워크트리·시도 횟수 유지), L4는 일회성(롤백 후 스스로 해제하고 재개), `init`이 `r0` 태그 생성 | `interrupts.md`의 "멈추고 상태 유지", "에이전트 재시작"과 일치 (지적 7·8) |
| D27 | `interrupts.md`의 모든 트립와이어에 감지기가 지정됨 | "항상 발동"이 코드에서 사실이어야 함 (지적 9) |
| D28 | 승인은 `approvals.md`를 그대로 따름: T2와 T3 모두 CEO 제안 → COO 검토, T3는 COO 입장을 붙여 인박스로. 모듈이 꺼지면 경로가 운영자 쪽으로 접힘 | 이중 통제는 두 등급 모두에 적용 (지적 10) |
| D29 | 무언가를 느슨하게 하는 운영자 명령(승인, 재개, 승격, 롤백, 해제)은 대화형 터미널을 요구. 에이전트 셸은 어차피 샌드박스 때문에 DB나 컨트롤 파일을 쓸 수 없음 | 에이전트는 자기 셸에서 `OPERATOR_SESSION=1`을 설정할 수 있음 (지적 2) |
| D30 | 다이제스트의 결정론적 부분은 커널이 직접 렌더링하고 CEO는 서술만 더함 | 헌법 6.3: 다이제스트는 생략 불가 (지적 13) |
| D31 | 승격 하한 샘플 20개·일치율 0.9, 고정 조건(최근 10개 일치, 롤백 없음, 카나리 놓침 없음, 동결 아님), 판정자 (엔진, 모델)은 모든 생산자와 달라야 함 | 하한이 명세 기본값보다 너무 낮았음 (구현·테스트 완료, 지적 12) |
| D32 | 이의제기 창 작업이 T2 행동을 확정. `holdco rollback`이 기록된 되돌리기를 실행하고 `rolled_back` 표시와 해당 행동 유형 강등. 릴리스 감시가 L4를 검 | 롤백에 도달할 경로가 없었음 (지적 11) |
| D33 | 모든 작업에 하나의 세션 관문(인터럽트, 예산 몫, 슬롯). 슬롯 우선순위는 검증 → 경영진 → 생산. COO 무응답은 시한이 지나면 인박스로 | 경영진 작업이 예산과 인터럽트를 우회했음 (지적 13) |

| D34 | 제품 이름은 **Holdco**: 명령어 `holdco`, 패키지 `@holdco/kernel`·`@holdco/engine-*`, 진입점 `create-holdco`, 상태 폴더 `.holdco/`. 첫 이름(두레)을 대체 | 영어로 기억하기 쉽고 설계를 그대로 설명함: 소유자 한 명, 계열사처럼 운영되는 프로젝트들, 정관과 예산을 정하고 감사하고 개입하는 소유자. npm에서 이름, `@holdco` 스코프, `create-holdco`가 모두 비어 있었음(2026-10-26 확인) |
| D35 | 엔진 중립 세션: 커널이 `SessionSpec`을 만들고, 패키지별 `Engine`(기능, `run`, 선택적 `probe`)이 실행해 `Outcome` 하나를 돌려줌. 엔진의 빈칸은 모두 이름 붙은 커널 보완책에 대응하고, 보완책 없는 빈칸은 테스트가 실패 | Claude Code와 Codex는 시스템 프롬프트·훅·비용 보고·예산 상한이 다르지만 규칙은 같아야 함 (구현·테스트 완료) |
| D36 | 회사 도구는 슈퍼바이저가 `127.0.0.1`에 띄운 MCP 엔드포인트 하나로, 세션마다 (세션, 역할, 티켓)에 묶인 토큰. 주니어 토큰에는 도구 없음 (D7 수정) | 두 엔진 모두 MCP를 쓰고, 프로세스 내 서버는 한쪽에만 있음 |
| D37 | 위임은 커널이: `delegate_start`·`delegate_wait`. 모든 엔진에서 고유 서브에이전트 끔(`Agent`/`Task` 금지, Codex `multi_agent = false`). 주니어 엔진은 시니어와 달라도 됨 | 주니어 워크트리 규칙, 작업당 상한, 예산, 신원이 엔진과 무관하게 같음 |
| D38 | `company.yaml`에 `engines`(키 환경변수, Codex 가격표)와 `roles`(종류별 엔진·모델·강도, 부서별 시니어) 추가. 독립성은 (엔진, 모델)로 비교. 역할 파일은 중립적인 `org/roles/*.md`로 | 엔진별 역할 파일 없이 역할마다 선택 (구현·테스트 완료) |
| D39 | 회사 지시문의 원본은 `AGENTS.md`, `CLAUDE.md`는 `@AGENTS.md` 한 줄. 지시문은 항상 릴리스 태그의 텍스트로만 세션에 들어가고 엔진 설정으로 로드되지 않음 | 두 엔진이 같은 파일을 읽고, 워크트리의 어떤 것도 다음 세션의 지시문을 바꾸지 못함 |
| D40 | 템플릿은 커널 패키지 안에, `examples/`는 프리셋에서 생성하고 테스트로 확인. 프리셋은 `solo-dev`(Claude), `solo-codex`(Codex), `full`(둘 다, COO와 심판은 Codex) | 커널 버전과 템플릿이 어긋날 수 없음 (구현·테스트 완료) |
| D41 | Codex 샌드박스는 커널 소유 `CODEX_HOME`의 권한 프로필만 사용. `sandbox_mode`·`--sandbox`·`networkAccessEnabled`는 절대 쓰지 않음(어느 하나라도 프로필을 조용히 무시시킴). 접근 값은 `read`/`write`/`deny`. 훅은 `--dangerously-bypass-hook-trust`를 붙이는 래퍼로 실행. doctor가 `codex sandbox`로 프로필을 실측 | 실제 CLI 바이너리로 테스트하다 발견: 첫 어댑터는 `sandbox_mode`(프로필 무시, 차단 파일이 읽힘)와 `none`(설정 로드 실패)을 썼음 (Codex CLI 0.164.0, Linux에서 확인, R8 축소) |
| D42 | 모든 세션에서 호스트 자격 증명 읽기 차단(`~/.config/holdco`, `~/.ssh`, 클라우드·패키지 매니저 자격 증명, `~/.codex`, `~/.claude`). Codex 셸은 `*KEY*`·`*TOKEN*`·`*SECRET*` 환경변수를 넘기지 않음 | env 파일에 모든 키가, 엔진 홈에 운영자 로그인이 있음 (상수 구현, 적용은 M3 슈퍼바이저) |

| D43 | 슈퍼바이저는 시계와 엔진을 주입받는 평범한 비동기 TypeScript. Effect는 스키마와 검증에 사용. Effect 서비스와 `TestClock`은 뒤로 미룸 | 서비스 추상화보다 실제 git·MCP 위에서 테스트되는 루프를 먼저 내놓는 게 중요했고, 주입 지점(`now`, `engines`, `notifier`, `store`)이 같은 테스트 가능성을 줌 |
| D44 | 회사 도구는 커널 패키지가 `@modelcontextprotocol/sdk`로 직접 제공(상태 유지 Streamable HTTP, 세션마다 전송 하나, JSON 응답) | SDK로 확인: 무상태 전송은 요청 두 개를 처리하지 못함. 세션 바인딩마다 서버+전송 하나가 토큰과 도구 목록을 세션별로 유지 |
| D45 | 게이트는 검증이 증거로 보임: 행동이 나열한 게이트 중 `verification-approved`를 뺀 전부가 판정의 `gates`에 통과로 있어야 하고, 아니면 커널이 빠진 게이트 이름과 함께 반려 | 커널은 프로젝트의 CI를 돌릴 수 없고 심판은 돌릴 수 있으니 증거와 함께 말해야 함 |
| D46 | 실행기 없는 행동은 운영자가 수행하고 승인하는 `manual_action` 인박스 항목. `merge`와 `branch`는 내장, 그 외는 운영자가 선언(D50) | 무엇이 자동화됐는지 정직하게. 조용히 아무것도 안 하는 일은 없음 |
| D47 | `create-holdco`는 한 번에: 스캐폴드 → 첫 프로젝트 등록 → `company.yaml`에서 `governance/strategy.md` 렌더링 → `bun install` → 가드 빌드 → doctor. `--github`은 필수, 남은 운영자 입력은 출력 | 명령 하나로 돌아가지 않는 회사는 제품이 아님 |
| D48 | 자기개선은 운영자 라벨에 묶임: 블라인드 채점된 티켓이 `replay_min_tickets`개가 될 때까지 개선 주기는 휴면(D20), 그 뒤 주당 최대 두 개의 자기 티켓을 염. 개선 머지는 릴리스 태그를 만들고, `policy.release.watch` 안의 강등은 L4를 걺 | 정답 없는 "개선"은 표류 |

| D49 | `engines.<id>.auth: api_key \| subscription`. Claude는 운영자의 Pro/Max 로그인이 기본(Anthropic: Agent SDK 사용량은 플랜 한도에서 차감, Max/Team엔 API 크레딧 포함), Codex는 API 키가 기본이고 `subscription`이면 `~/.codex/auth.json`을 세션 홈에 복사(OpenAI는 스크립트 용도엔 키 권장). 비용은 API 요율의 USD로 계속 계산해 예산·트립와이어는 그대로. doctor가 `claude auth status`·`codex login status`를 확인 | API 과금만으로 24/7은 비싸고, 운영자가 이미 내는 플랜을 제공사가 허용하는 범위에서 쓸 수 있어야 함 |
| D50 | `company.yaml:executors.<action>`: 셸 없는 argv와 플레이스홀더 `{branch} {ticket} {deliverable} {previous}`, 환경변수 허용 목록, 선택적 `undo`와 timeout. 커널이 행동의 등급대로 실행(T0/T1은 판정 뒤, T2/T3은 승인 뒤), 출력과 되돌리기를 행동 로그에 기록, `holdco rollback`이 undo를 실행. `rollback-tested`는 undo의 존재로 증명, doctor가 명령 존재를 확인 | 배포·게시가 전부 수동 항목이면 운영·GTM 부서가 무의미. 커널이 무엇을 실행할지는 에이전트가 아니라 운영자가 정함 |
| D51 | 프로젝트별 `merge: local \| github`. `github`면 브랜치 push, PR 열기(기존 재사용), 체크 대기(`merge_wait`, 기본 20분), `gh pr merge --merge`. GitHub의 거절(브랜치 보호, CODEOWNERS)은 사유와 함께 티켓 반려. 되돌리기는 머지 커밋 revert | 팀은 GitHub에서 게이트하므로 L-h 계층이 실제로 끼어 있어야 함 |
| D52 | 인박스 항목에 `urgency`. 긴급(core 프로젝트의 `blocked_after` 지난 blocked·cannot-score, core 프로젝트의 CEO·COO 불일치, 후보 철회)은 즉시 critical 알림, 나머지는 하루 한 번 `policy.inbox.batch_at`에 요약과 다이제스트. 시한 초과 거절은 둘 다 적용 | `approvals.md`가 "긴급은 즉시"를 약속했지만 커널은 시한 초과만 처리했음 |
| D53 | 개선 머지는 후보 `rc-<n>`을 태그. 새 생산 세션의 `policy.release.canary_traffic`만(검증·경영진 제외) 후보 조직으로 돌고 `sessions.release`에 기록. `policy.release.watch` 뒤 후보 세션 반려율 ≤ 기준선 + `max_regression`이고 강등이 없으면 `r<n>`으로 승격, 아니면 철회하고 `main`의 조직 경로를 릴리스로 되돌리고 긴급 인박스 항목 등록. L4는 후보를 철회. `holdco release`는 즉시 승격, `holdco release withdraw`는 철회 | 모든 세션을 한 번에 새 조직으로 바꾸면 안전망이 L4뿐 |
| D55 | 운영자 메모: 티켓의 코멘트(`ticket_comments`)는 그 티켓의 이후 모든 세션(시니어·심판) 프롬프트에 구속력 있는 섹션으로 들어감(최신이 마지막, 실행 중인 세션은 못 봄). 대시보드는 모든 운영자 작업(티켓, 메모, 역할, 설정, 승인, 채점, 릴리스, 인터럽트)의 두 번째 입구이며 127.0.0.1에서 에이전트가 못 읽는 토큰으로 보호 | 터미널 없이, "세션 하나 = 티켓 하나"를 깨지 않고 일을 조종해야 함. 에이전트와의 채팅은 그 원칙을 깸 |
| D56 | Telegram 브리지: 슈퍼바이저가 운영자의 봇을 롱폴링. 인박스 항목은 승인/거절 버튼과 함께 전달되고, 명령(status, tickets, note, unblock, new, pause/resume, 확인 버튼이 있는 halt)은 `act`를 거쳐 커널 규칙이 그대로 적용됨. 짝지은 채팅만 따르며 `holdco telegram setup`이 첫 메시지로 짝을 맺음 | 24/7 운영이면 결정은 키보드 앞이 아닐 때 도착함 |
| D57 | 대시보드는 페이지가 아니라 타입 있는 계약: `packages/kernel/src/dashboard/contract.ts`가 API를 Effect `HttpApi`로 정의(엔드포인트 6개, 모든 입출력이 Effect Schema)하고, 커널은 `Bun.serve` 위에서 `HttpApiBuilder` + `HttpRouter.toWebHandler`로 서빙하며 `/api/openapi.json`을 냄. 클라이언트(`packages/dashboard`: React 19, TanStack Router·Query, zyzz 스타일링, Vite)는 같은 정의에서 타입 있는 `HttpApiClient`를 끌어내므로 모양이 바뀌면 양쪽 `tsc`가 실패함. 빌드된 클라이언트는 커널 패키지의 `dashboard-dist/`로 배포되고, 체크아웃에서는 `holdco dashboard`가 없거나 오래됐을 때 알아서 빌드함 | 서버 핸들러·브라우저 클라이언트·API 문서의 소스가 하나. 손으로 쓴 HTML 한 장은 커널과 타입으로 묶을 수 없고, 운영자 UI는 제품이 평가받는 자리이므로 커널과 같은 도구(Effect)와 성장할 여지가 필요 |
| D58 | 온보딩은 마법사: 인자 없는 `holdco init`(또는 `create-holdco`)이 일곱 가지(디렉토리, GitHub 핸들, 근처 저장소에서 첫 프로젝트, 조직, 발견된 로그인에 따른 모델, 미션, 첫 목표; 풀 프리셋은 목소리; Telegram 토큰은 선택)를 묻고, 운영자가 손으로 하던 후속 작업을 전부 함 — 모델 프리셋, 전략에 목표, 루브릭에 목소리, `~/.config/holdco/<회사>.env`에 토큰, 봇 짝 맺기, doctor. 모든 `holdco` 명령이 그 env 파일을 읽으므로 손으로 띄운 `supervise`도 서비스와 같음. `models preset`은 어떤 역할도 안 쓰는 엔진을 제거 | 스캐폴드 뒤의 수동 단계 하나하나가 멈추는 지점이었음. 첫 실행은 명령 하나와 `smoke` 하나여야 함 |
| D59 | 세션 저널과 라이브 피드: `activity`를 뺀 모든 SessionEvent가 발생 즉시 `.holdco/sessions/<id>/events.jsonl`에 추가됨(Claude 어댑터가 SDK 메시지를 `message`·`tool`·`command`·`file_change` 이벤트로 바꾸므로 루프 트립와이어가 두 엔진 모두에 적용됨). `GET /api/session/:id/events?after=n`이 줄을 증분으로 서빙하며 프로세스에 무관. 티켓 서랍의 Live 탭이 실행 중인 세션을 따라가고(2초 폴링, 자동 스크롤) 끝난 뒤에는 같은 저널을 로그로 보여줌. 홈의 "Running now"에서 바로 열림 | "제대로 하고 있나"는 세션이 도는 동안 답할 수 있어야지 끝난 뒤 보고서로는 늦음. 디스크의 저널이면 `holdco dashboard` 단독으로도 되고 슈퍼바이저 재시작에도 남음 |
| D60 | CEO만 움직일 수 있는 일이 생기면 CEO를 깨움: `new`(분류) 또는 `needs_proposal`(T2/T3 승인 경로) 상태로 마지막 실행 이후 바뀐 티켓이 있으면 `WORK_WAKE_MS`(2분) 안에 디바운스해서 실행하고, 이미 본 일은 `ceo_cycle`을 기다림. 대시보드는 열린 모든 티켓이 무엇을 기다리는지(`Snapshot.waiting`: 세션, CEO 분류, CEO 제안서, COO 검토, 당신의 결정, 빈 슬롯, 리스, 커널)와 예상 시각을 홈(아무것도 안 돌 때)·보드 카드·서랍에 보여줌 | 검증된 T2 티켓이 "세션 0"인 채 설명 없이 24시간 주기를 기다리고 있었음. 운영자가 회사가 왜 조용한지 추측해야 해서는 안 됨 |
| D54 | 리플레이 게이트: 후보가 `evals/rubrics/`, 검증 헌장, 심판 역할 파일을 바꾸면 카나리 전에 라벨 티켓 최대 `audit.weekly_sample × 4`개를 다시 판정(고정 브랜치, 후보 루브릭·심판, 개선 몫으로 과금). 운영자 라벨과의 일치율이 `min_gain` 이상 오르고 행동 유형별 하락이 `max_regression` 이하여야 하며 아니면 후보 철회 | D20이 리플레이를 약속했지만 아무것도 돌지 않았음. 심판 변경은 카나리로 못 잼—카나리의 척도가 심판이기 때문 |

지적 1~14는 초안에 대한 독립 리뷰에서 나왔고, 각각 위 결정이나 파일 수정으로 반영했습니다. 템플릿에 대한 두 번째 리뷰(`docs/reviews/2026-10-26-template-audit.md`)가 프로토콜 스키마, 도구 목록, 게이트 어휘, 템플릿 재작성을 이끌었습니다.

### 운영자에게 남은 결정

빌드를 막는 것이 아니라 `init`의 입력입니다. 월 예산, 호스트, 첫 프로젝트, 알림 채널, GitHub 핸들, 역할별 엔진과 모델, 현재 Codex 가격.
