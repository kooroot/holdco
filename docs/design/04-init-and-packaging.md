# 04 — Packaging and `init`

---

## English

### 1. What ships how (D1)

| Part | Shipped as | Why |
|---|---|---|
| Supervisor, hook, CLI, config schema, protocol schemas, engine contract, store, executors | **Kernel package** `@holdco/kernel`, pinned by version in the company repo | Agents must not edit it; it must be upgradable |
| One adapter per engine | **Engine packages** `@holdco/engine-claude`, `@holdco/engine-codex`; init adds only the ones `company.yaml` uses | A Claude-only company never installs the Codex SDK, and the reverse |
| Constitution, governance prose, Verification charter and rubric, protocols prose, `AGENTS.md` (with `CLAUDE.md` importing it), `.claude/settings.json`, `.codex/hooks.json` | **Base template**, copied at init, locked | Readable in the repo; changes arrive through `holdco upgrade` as a reviewable diff |
| Department charters, role files (`org/roles/`), skills (`org/skills/`), department rubrics, default actions and envelopes | **Module templates**, copied at init when the module is on | Improvement evolves these files; a package update must never overwrite them |
| `company.yaml` | **Generated** by init | The Operator's settings |

### 2. Product repository layout (implemented)

```
holdco/                                 monorepo, Bun workspaces
  packages/
    kernel/                           @holdco/kernel        bin: holdco
      src/   config/ policy/ hooks/ schema/ protocol/ engine/ scaffold/  cli.ts hook.ts
      templates/
        base/                         always copied
        modules/                      executive-ceo, executive-coo, research, engineering,
          <id>/org/… evals/rubrics/…  gtm, operations, improvement
          <id>/module.yaml            default actions, envelopes, dependencies
        presets/                      full.yaml, solo-dev.yaml, solo-codex.yaml
      schema/                         generated JSON Schemas (brief, return, company, preset)
      test/
    engine-claude/                    @holdco/engine-claude  (Claude Agent SDK)
    engine-codex/                     @holdco/engine-codex   (Codex SDK)
    create-holdco/                      create-holdco          (thin: calls the kernel scaffold)
  examples/                           company.<preset>.yaml, generated from the presets
  docs/design/  docs/engines/
```

Templates live inside the kernel package so that a kernel version and its templates can never drift apart. The examples are generated (`bun run examples`) and checked by a test, so they always match what `init` produces.

### 3. A company repository after init

```
my-co/
  company.yaml                        locked
  CONSTITUTION.md  AGENTS.md  CLAUDE.md   locked (base); CLAUDE.md is one line: @AGENTS.md
  governance/  evals/  control/       locked (base + generated)
  org/  protocols/  improvement/      editable by Improvement (modules + base prose)
    org/roles/                        one file per role: kind, department, capabilities, prompt
    org/skills/                       engine-neutral skills (SKILL.md)
  .claude/settings.json               locked; registers the hook wrapper for Claude Code
  .codex/hooks.json                   locked; registers the same hook for Codex
  .claude/hooks/pre-tool-use          built locally (holdco build-hook), never committed
  reports/                            written by CEO and Operations through tools
  .holdco/                              state.db, sessions (incl. per-session engine homes), backups;
                                      gitignored, unreadable to agents
  package.json                        @holdco/kernel + the engines in use, at an exact version
```

Project code is not here (D12): each project stays in its own repository and is registered with `holdco project add`.

### 4. `create-holdco`

Today `bunx create-holdco <dir> --github <handle> --project <repo> [--preset <name>] [--name] [--mission] [--timezone]` does steps 1–7 below in one shot (implemented and tested): it registers the first project, renders `governance/strategy.md` from `company.yaml`, installs, builds the guard and runs doctor, then prints what is left for the Operator (keys, objectives, prices). `--github` is required. The guided wizard is M4, built with `effect/cli` (`Command`, `Prompt.Select`, `Prompt.MultiSelect`, `Prompt.Confirm`, `Prompt.Int`, `Prompt.String`; exports verified in 4.0.6).

```
$ bunx create-holdco my-co
◆ Preset              ● solo-dev  ○ solo-codex  ○ full  ○ custom
◆ Engines             ◼ Claude Code  ◻ Codex                          (at least one)
◆ Departments         ◼ engineering  ◻ research  ◻ gtm  ◻ operations     (Verification is always included)
◆ Executive           ○ none (I write tickets)  ● CEO  ○ CEO + COO
◆ Self-improvement    ○ on  ● off
◆ Auto-graduation     ○ on  ● off
◆ Models per role     ● preset defaults  ○ choose     → engine, model, effort for each role kind
◆ Judge on a second engine?  ● yes (if both engines)  ○ no
◆ Monthly budget USD  100        Session cap USD  3
◆ Provider spend cap  ● I have set one  ○ not yet  (doctor will warn)
◆ Host                ○ Linux (systemd)  ● macOS (launchd)  ○ manual
◆ Alerts              ● Telegram  ○ Slack  ○ webhook     → env var names, chat id
◆ First project       path ../app   class core
◆ GitHub handle       <you>
```

Then, in order, stopping at the first failure:

1. Write `company.yaml` from the preset plus answers; run `config check` on it.
2. Copy `templates/base` and the enabled modules; merge each module's `module.yaml` into `actions`, `envelopes`, `budget.shares`.
3. Write CODEOWNERS with the handle; `git init`; first commit; tag it `r0` (sessions are built from the latest release tag, and L4 always has a tag to return to).
4. `bun install`; `holdco build-hook` (compiles the guard into `.claude/hooks/pre-tool-use`, used by both engines).
5. Create `.holdco/`, run migrations.
6. Print where secrets go: `~/.config/holdco/<company>.env` (outside the repo, mode 600), listing exactly the env var names the config references (engine keys from `engines.*.auth_env`, alert tokens, heartbeat URL).
7. `holdco doctor`, including a real test alert.
8. Generate the service file (not started). Print: `holdco service start` when ready.

Non-interactive: `--preset solo-dev --yes`, or `--config ./company.yaml` to start from an existing file.

### 5. Commands after init

| Command | Who | Does |
|---|---|---|
| `holdco supervise` | service manager | the supervisor |
| `holdco doctor` | Operator, service `ExecStartPre` | preflight; nonzero = do not start |
| `holdco status` | Operator | running sessions, queue, budget, interrupts, last heartbeat |
| `holdco inbox [approve\|reject <id>]` | Operator | the approval inbox |
| `holdco audit` | Operator | weekly blind sample grading; writes labels |
| `holdco interrupt <L1-L5> <target> --reason` / `resume` | Operator | write the control file |
| `holdco ticket new` / `unblock <id>` | Operator | open tickets (required when executive is `none`); release a `blocked` ticket |
| `holdco rollback <action-log-id>` | Operator | run the recorded undo step, mark the ticket `rolled_back`, demote the action type, open a follow-up ticket |
| `holdco release` | Operator | tag the current default branch as a release (after the Operator edits org files by hand, or whenever Improvement is off) |
| `holdco promote <action>` | Operator | apply an approved graduation to `company.yaml` and commit |
| `holdco project add <path> --class …` | Operator | register a project; its `locked` list starts with `AGENTS.md`, `CLAUDE.md` and `.github/**` (the kernel adds `.claude/settings*`, hooks, agents, skills, `.mcp.json` and `.codex/` on top) |
| `holdco engines` | Operator | per engine: which roles use it, and what the kernel compensates for (implemented) |
| `holdco add department <name>` / `remove department <name>` | Operator | copy a module (or a blank custom charter; the custom rubric is left for the Operator), or remove one together with its actions and budget share |
| `holdco upgrade` | Operator | bump the kernel; show base-template changes as a diff; never touch module files |
| `holdco service [install]` | Operator | print or write the systemd user unit / launchd plist for `runtime.host` (implemented) |
| `holdco digest` | Operator | render this week's digest now (implemented) |
| `holdco audit [sample\|grade <id> approve\|reject\|done]` | Operator | the blind sample, one grade per ticket, close the week (implemented) |

Commands that loosen anything (`inbox approve`, `resume`, `promote`, `rollback`, `unblock`) refuse to run without an interactive terminal (D29). An agent's shell has no terminal, and the sandbox already denies agent shells write access to `.holdco/` and the company root, so these commands fail from inside a session twice over. `OPERATOR_SESSION=1` only tells the hook that an interactive session belongs to the Operator; the CLI never trusts it.

### 6. Service files

```ini
# ~/.config/systemd/user/holdco-my-co.service
[Unit]
Description=Holdco company: my-co
After=network-online.target

[Service]
WorkingDirectory=%h/companies/my-co
EnvironmentFile=%h/.config/holdco/my-co.env
ExecStartPre=%h/companies/my-co/node_modules/.bin/holdco doctor
ExecStart=%h/companies/my-co/node_modules/.bin/holdco supervise
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

(`loginctl enable-linger` so a user service survives logout.)

macOS: a LaunchAgent plist with `KeepAlive` and `RunAtLoad`, the same two commands, and the env file loaded by a small wrapper. A Mac sleeps; the wrapper runs `caffeinate -s` while the supervisor is up, and doctor warns that a laptop is not a 24/7 host.

### 7. Doctor, expanded

| Check | Fails when |
|---|---|
| Config | `company.yaml` missing or invalid |
| Hook | binary missing, not executable, or behavioral checks fail (blocks a governance write, allows a src write, fails closed on bad input) |
| Settings | `.claude/settings.json` does not register the wrapper (implemented) |
| Sandbox | dependencies missing on this OS |
| Secrets | an env var named in the config is unset |
| Alerts | test message to every channel fails |
| Engines | an engine in `company.yaml` has no installed adapter, or its `auth_env` is unset (implemented); a minimal call fails (M3) |
| Codex hooks | `.codex/hooks.json` does not register the hook; a Codex-style patch to `governance/` is not blocked (implemented) |
| Codex read denial | a session with the generated permission profile can read `.holdco/` (M3 probe, R8) |
| Store | cannot open or migrate `.holdco/state.db` |
| Projects | a path is not a git repository |
| Modules | GTM on but the voice guide still has placeholders; a custom department without a rubric (warning) |
| Host | `manual` (warning); `provider_cap_set: false` (warning); CEO and COO on the same engine (warning) |
| Schemas | generated JSON Schemas are stale |

---

## 한국어

### 1. 무엇을 어떻게 배포하는가 (D1)

| 부분 | 배포 방식 | 이유 |
|---|---|---|
| 슈퍼바이저, 훅, CLI, 설정 스키마, 프로토콜 스키마, 엔진 계약, 저장소, 실행기 | **커널 패키지** `@holdco/kernel`, 회사 레포에서 버전 고정 | 에이전트가 고칠 수 없어야 하고 업그레이드할 수 있어야 함 |
| 엔진별 어댑터 | **엔진 패키지** `@holdco/engine-claude`, `@holdco/engine-codex`. init은 `company.yaml`이 쓰는 것만 추가 | Claude만 쓰는 회사는 Codex SDK를 설치하지 않고, 반대도 마찬가지 |
| 헌법, 거버넌스 문서, 검증 헌장과 루브릭, 프로토콜 문서, `AGENTS.md`(`CLAUDE.md`가 이를 불러옴), `.claude/settings.json`, `.codex/hooks.json` | **기본 템플릿**, init 때 복사되고 잠김 | 레포 안에서 읽을 수 있고, 변경은 `holdco upgrade`가 검토 가능한 diff로 가져옴 |
| 부서 헌장, 역할 파일(`org/roles/`), 스킬(`org/skills/`), 부서 루브릭, 기본 행동과 위임 범위 | **모듈 템플릿**, 켠 모듈만 init 때 복사 | 개선팀이 발전시키는 파일이므로 패키지 업데이트가 절대 덮어쓰면 안 됨 |
| `company.yaml` | init이 **생성** | 운영자의 설정 |

### 2. 제품 레포 구조 (구현 완료)

위 트리와 같습니다. Bun 워크스페이스 모노레포이고, 커널(`@holdco/kernel`, 명령어 `holdco`), 엔진 어댑터 둘(`@holdco/engine-claude`, `@holdco/engine-codex`), 얇은 진입점(`create-holdco`)으로 나뉩니다. 템플릿은 커널 패키지 안에 두어 커널 버전과 템플릿이 어긋날 수 없게 했고, `examples/`는 프리셋에서 생성되며 테스트가 최신 여부를 확인합니다.

### 3. init 이후의 회사 레포

위 트리와 같습니다. 잠긴 영역(설정, 헌법, `AGENTS.md`·`CLAUDE.md`, 거버넌스, 평가, 컨트롤, 두 엔진의 훅 등록 파일), 개선팀이 고칠 수 있는 영역(조직: 부서·역할·스킬, 프로토콜, 개선), 커널 상태(`.holdco/`: DB, 세션별 엔진 홈, 백업. gitignore, 에이전트 읽기 불가)로 나뉩니다. 프로젝트 코드는 여기 없습니다(D12). 각 프로젝트는 자기 레포에 있고 `holdco project add`로 등록합니다.

### 4. `create-holdco`

지금은 `bunx create-holdco <dir> --preset <이름> --github <핸들>`로 질문 없이 만듭니다(아래 1~3단계, 모든 프리셋에 대해 구현·테스트 완료). 대화형 마법사는 M4이며 `effect/cli`(`Command`, `Prompt.Select`, `MultiSelect`, `Confirm`, `Int`, `String`, 4.0.6에서 export 확인)로 만듭니다. 엔진 선택, 역할별 모델, 심판을 두 번째 엔진에 둘지 묻는 질문이 추가됩니다. 질문 흐름은 위 예시와 같고, 답을 받은 뒤 순서대로 진행하며 첫 실패에서 멈춥니다.

1. 프리셋과 답으로 `company.yaml` 작성, `config check` 실행
2. 기본 템플릿과 켠 모듈 복사, 각 모듈의 `module.yaml`을 `actions`·`envelopes`·`budget.shares`에 병합
3. 핸들로 CODEOWNERS 작성, `git init`, 첫 커밋, `r0` 태그(세션은 최신 릴리스 태그로 조립되고, L4가 돌아갈 태그가 항상 있어야 함)
4. `bun install`, `holdco build-hook`(가드를 `.claude/hooks/pre-tool-use`로 컴파일, 두 엔진이 같이 사용)
5. `.holdco/` 생성, 마이그레이션
6. 시크릿 위치 안내: `~/.config/holdco/<company>.env`(레포 밖, 권한 600), 설정이 참조하는 환경변수 이름을 정확히 나열
7. `holdco doctor`(실제 테스트 알림 포함)
8. 서비스 파일 생성(시작은 안 함). 준비되면 `holdco service start`

질문 없이 만들려면 `--preset solo-dev --yes`, 기존 파일로 시작하려면 `--config ./company.yaml`.

### 5. init 이후 명령

위 표와 같습니다. 리뷰 이후 `ticket unblock`, `rollback`(기록된 되돌리기 실행, `rolled_back` 표시, 행동 유형 강등, 후속 티켓), `release`(운영자가 조직 파일을 직접 고친 뒤나 개선팀이 꺼져 있을 때 수동으로 릴리스 태그), `remove department`가 추가됐습니다. `project add`는 `locked` 목록을 `AGENTS.md`, `CLAUDE.md`, `.github/**`로 시작합니다(커널이 `.claude/settings*`, 훅, 에이전트, 스킬, `.mcp.json`, `.codex/`를 그 위에 고정으로 추가). `holdco engines`는 엔진마다 어느 역할이 쓰는지와 커널이 무엇을 보완하는지 보여줍니다(구현 완료).

무언가를 느슨하게 하는 명령(`inbox approve`, `resume`, `promote`, `rollback`, `unblock`)은 대화형 터미널 없이는 실행을 거부합니다(D29). 에이전트 셸에는 터미널이 없고, 샌드박스가 이미 에이전트 셸의 `.holdco/`와 회사 루트 쓰기를 막으므로 세션 안에서는 두 번 실패합니다. `OPERATOR_SESSION=1`은 대화형 세션이 운영자의 것임을 훅에 알릴 뿐이며, CLI는 이 값을 절대 믿지 않습니다. 특히 `holdco audit`(주간 블라인드 채점, 라벨 기록), `holdco promote`(승인된 승격을 설정에 반영하고 커밋), `holdco upgrade`(커널 업그레이드, 기본 템플릿 변경을 diff로 보여주고 모듈 파일은 절대 건드리지 않음)가 이 설계의 핵심 명령입니다.

### 6. 서비스 파일

Linux는 위 systemd 사용자 유닛 예시처럼 `Restart=always`, 시작 전 doctor, 레포 밖 env 파일을 씁니다(로그아웃 후에도 살아 있도록 `loginctl enable-linger`). macOS는 `KeepAlive`·`RunAtLoad`가 걸린 LaunchAgent plist를 쓰고, 맥은 잠들기 때문에 래퍼가 슈퍼바이저가 떠 있는 동안 `caffeinate -s`를 돌리며, doctor가 노트북은 24/7 호스트가 아니라고 경고합니다.

### 7. 확장된 doctor

위 표와 같습니다. 설정, 훅(Claude식 쓰기와 Codex식 패치 차단, 허용 동작까지), 두 엔진의 훅 등록, 샌드박스 의존성, 설정이 참조하는 환경변수, 알림 채널 테스트, 엔진 어댑터 설치와 키(구현 완료), Codex 읽기 차단 실측(M3, R8), 상태 DB, 프로젝트 경로, 모듈 조건(GTM 목소리 가이드, 사용자 정의 부서 루브릭), 호스트와 제공사 한도 경고, CEO·COO가 같은 엔진이면 경고, 생성 스키마 최신 여부를 확인합니다.
