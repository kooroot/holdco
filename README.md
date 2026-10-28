# Holdco

> **A self-improving agent company, run by one person, on Claude Code, Codex, or both.**
> **1인이 운영하는 자기개선형 에이전트 회사. Claude Code, Codex, 또는 둘 다로.** 한국어는 아래에 있습니다.

---

## English

### What it is

Holdco turns a folder into a company whose staff are AI agents. One human, the Operator, sits on the board. A CEO and a COO run the company with dual control; departments (research, engineering, GTM, operations, or your own) each have a senior agent that spawns 0..N juniors in isolated worktrees; an independent Verification department judges all work; an Improvement department proposes changes to how the company works. Agents work around the clock and approve each other's work. The Operator audits, follows up, and interrupts when the company drifts.

The rules are not prompts. A small kernel, deterministic and LLM-free, enforces them: locked paths, action tiers, budgets, interrupts, and a release process for every change to the organization.

### The name

A holding company owns operating companies and lets each one run itself: it appoints the leadership, sets the charter and the budget, reads the reports, and steps in when something goes wrong. That is the Operator's job here. Each project is run like a portfolio company by agents; the Operator owns, audits and can intervene.

### Design premise

The scarcest resource in a one-person company is the Operator's attention, so every choice trades agent effort for it:

- The Operator is an **auditor, not an approver**. Agents act first; the Operator can challenge and roll back.
- Blocking approval is reserved for actions that are **irreversible and high-stakes**.
- **Autonomy is earned**: an action type graduates only after the evaluator has matched the Operator's own judgment often enough.
- The Operator verifies **the system** (is the judge still calibrated?), not individual outputs.

```
                 ┌────────────────────────────┐
                 │  BOARD — Operator (human)  │  constitution · governance · evals · company.yaml
                 └─────────────┬──────────────┘
                               │ strategy · veto · interrupts · weekly audit
             ┌─────────────────┴─────────────────┐
             │   CEO  ◄──── dual control ────►  COO  │
             └─────────────────┬─────────────────┘
        ┌──────────┬───────────┼───────────┬──────────┐
     Research  Engineering    GTM      Operations   …       produce   (senior + 0..N juniors)
        └──────────┴─────┬─────┴───────────┘
                Verification & Security                    judge
                         │
                     Improvement                           improve
```

### Any role on any engine

```yaml
# company.yaml
engines:
  claude: { auth: subscription }                         # your Claude Pro/Max login; or auth: api_key + auth_env
  codex:  { auth: api_key, auth_env: OPENAI_API_KEY, prices: { gpt-6.1-sol: { input_per_mtok: 5, cached_input_per_mtok: 0.5, output_per_mtok: 40 } } }

roles:
  ceo:           { engine: claude, model: opus }
  coo:           { engine: codex,  model: gpt-6.1-sol, effort: high }   # second key, second provider
  senior:        { engine: claude, model: opus }
  verification:  { engine: codex,  model: gpt-6.1-sol, effort: high }   # judge on another provider
  improvement:   { engine: claude, model: opus }
  junior_worker: { engine: claude, model: sonnet }
  junior_reader: { engine: claude, model: haiku }
```

The kernel builds one session spec; an engine adapter runs it. Where an engine lacks a guarantee (Codex has no system prompt option, no cost reporting, no in-process hooks), the kernel names what it does instead, and `holdco engines` shows the list. Independence is checked on (engine, model): the judge can never share a producer's, nor the COO the CEO's. Details: `docs/design/07-engines.md`.

| Preset | Engines | For |
|---|---|---|
| `solo-dev` | Claude Code | one developer, engineering only, CEO, no COO |
| `solo-codex` | Codex | the same on Codex |
| `full` | both | every department, CEO + COO, Improvement; producers on Claude, COO and judge on Codex |

### Quick start

The packages are not on npm yet (M4). From this repository, until then:

```bash
bun install && bun test                              # 300+ tests: guard, config, scaffold, engines, supervisor simulations, CLI
for p in kernel engine-claude engine-codex; do (cd packages/$p && bun link); done   # make @holdco/* resolvable locally

bun packages/create-holdco/src/index.ts ../my-co --github <you> --project ../your-repo --preset solo-dev
cd ../my-co && bun link @holdco/kernel @holdco/engine-claude && bunx holdco build-hook && bunx holdco doctor
```

Then, logged in with `claude login` (or with your API key exported) and an objective written into `governance/strategy.md`:

```bash
bunx holdco supervise                                # the company runs; Ctrl-C stops it cleanly
bunx holdco ticket new --title "…" --criteria "a; b" --action code.merge.app
bunx holdco status · inbox · audit                   # your weekly ten minutes (docs/operator-guide.md)
```

After publishing, the first block becomes `bunx create-holdco my-co --github <you> --project ../your-repo`.

### Repository

```
packages/
  kernel/          @holdco/kernel: config schema, policy, guard + compiled hook, protocols, engine contract,
                   scaffold, CLI `holdco`; templates/ (base, modules, presets) live here
  engine-claude/   @holdco/engine-claude: Claude Agent SDK adapter
  engine-codex/    @holdco/engine-codex: Codex SDK adapter, generated CODEX_HOME, host probe
  create-holdco/     create-holdco: entry point
examples/          company.<preset>.yaml, generated from the presets
docs/design/       components, config, supervisor, packaging, security, roadmap, engines
docs/engines/      claude-code.md, codex.md
```

A company created by `init` holds the constitution, governance, evals and `company.yaml` (Operator only, enforced at runtime and by CODEOWNERS), the organization in `org/` (departments, roles, skills; changed only by Improvement, through releases), `AGENTS.md` for every engine, and kernel state in `.holdco/` (unreadable to agents). Project code stays in its own repositories.

### Status

Built and tested without a model: the kernel's enforcement and policy layers, configuration, templates and one-shot scaffolding, both engine adapters (typechecked against the real SDKs; Codex sandbox verified against the real CLI), the state store and ticket state machine, the company tool server (real MCP), the supervisor loop (dispatch, leases, interrupts, tripwires, approvals, declared executors and GitHub merges, urgent inbox, candidate releases with canary traffic and the replay gate, digest), the Operator CLI, and the Operator's dashboard (inbox, ticket board, blind audit with diffs, quality, releases, spend, controls). Not yet done: a live session on a real API key (M3's smoke test), the interactive wizard and service files (M4), npm publishing. See `docs/operator-guide.md` to run it and `docs/design/06-roadmap.md` for what is left.

---

## 한국어

### 이게 무엇인가

Holdco는 폴더 하나를 AI 에이전트가 직원인 회사로 만듭니다. 사람 한 명(운영자)이 이사회에 앉습니다. CEO와 COO가 이중 통제로 회사를 운영하고, 부서(리서치, 엔지니어링, GTM, 운영, 또는 직접 만든 부서)마다 시니어 에이전트가 작업 크기에 따라 주니어를 0~N명 격리된 워크트리에 띄웁니다. 독립된 검증 부서가 모든 작업을 판정하고, 개선 부서가 회사의 일하는 방식을 바꾸자고 제안합니다. 에이전트는 24시간 일하며 서로의 작업을 결재하고, 운영자는 감사하고, 팔로업하고, 회사가 엇나가면 인터럽트를 겁니다.

규칙은 프롬프트가 아닙니다. LLM이 없는 결정론적 커널이 잠긴 경로, 행동 등급, 예산, 인터럽트, 조직 변경의 릴리스 절차를 강제합니다.

### 이름

지주회사(holding company)는 계열사를 소유하되 각 회사가 스스로 돌아가게 둡니다. 경영진을 정하고, 정관과 예산을 정하고, 보고를 읽고, 문제가 생기면 개입합니다. 여기서 운영자가 하는 일이 바로 그것입니다. 프로젝트 하나하나를 에이전트들이 계열사처럼 운영하고, 운영자는 소유하고 감사하고 개입합니다.

### 설계 전제

1인 회사에서 가장 희소한 자원은 운영자의 주의력입니다. 그래서 운영자는 **결재권자가 아니라 감사관**이고, 사람을 기다리는 결재는 **되돌릴 수 없고 위험이 큰** 행동에만 쓰며, **자율성은 평가기가 운영자의 판단과 충분히 일치한 뒤에야 획득**하고, 운영자는 개별 산출물이 아니라 **시스템**(심판이 아직 보정되어 있는가)을 검증합니다. 조직도는 위 다이어그램과 같습니다.

### 어떤 역할이든 원하는 엔진으로

위 `company.yaml` 예시처럼 `engines`에 쓸 엔진과 키 환경변수를, `roles`에 역할 종류마다 엔진·모델·추론 강도를 적습니다. 커널은 세션 명세 하나를 만들고 엔진 어댑터가 실행합니다. 엔진에 없는 보장(Codex의 시스템 프롬프트, 비용 보고, 프로세스 내 훅 등)은 커널이 무엇으로 메우는지 이름을 붙여 두며, `holdco engines`가 목록을 보여줍니다. 독립성은 (엔진, 모델) 쌍으로 확인해서, 심판은 어떤 생산자와도, COO는 CEO와 같을 수 없습니다. 프리셋은 위 표와 같습니다(`solo-dev`, `solo-codex`, `full`). 자세한 내용은 `docs/design/07-engines.md`.

### 빠른 시작

패키지는 아직 npm에 없습니다(M4). 위 명령처럼 이 레포에서 설치와 테스트(Codex 샌드박스 실측 포함 275개)를 하고, `create-holdco`로 회사를 만들고, 로컬 패키지를 링크한 뒤, 가드를 빌드하고, `holdco engines`로 배정과 보완책을 확인하고, 키를 넣어 `holdco doctor`를 통과시킵니다. 배포 후에는 앞의 두 단계가 `bunx create-holdco my-co`가 됩니다.

### 레포 구조

위 트리와 같습니다. 커널(`@holdco/kernel`, 명령어 `holdco`, 템플릿 포함), Claude 어댑터, Codex 어댑터(세션별 `CODEX_HOME` 생성과 호스트 실측), 진입점 `create-holdco`로 나뉩니다. `init`으로 만든 회사에는 헌법·거버넌스·평가·`company.yaml`(운영자만, 실행 시점과 CODEOWNERS로 강제), 조직(`org/`: 부서·역할·스킬, 개선팀만 릴리스로 변경), 모든 엔진이 읽는 `AGENTS.md`, 커널 상태(`.holdco/`, 에이전트 읽기 불가)가 들어갑니다. 프로젝트 코드는 각자의 레포에 그대로 둡니다.

### 상태

모델 없이 만들고 테스트한 것: 커널의 집행·정책 레이어, 설정, 템플릿과 한 번에 끝나는 스캐폴드, 두 엔진 어댑터(실제 SDK 타입으로 검사, Codex 샌드박스는 실제 CLI로 확인), 상태 저장소와 티켓 상태 머신, 회사 도구 서버(실제 MCP), 슈퍼바이저 루프(배분, 임대, 인터럽트, 트립와이어, 승인, 실행기, 다이제스트, 릴리스), 운영자 CLI. 아직 안 된 것: 실제 API 키로 세션 돌리기(M3 실사용 테스트), 대화형 마법사와 서비스 파일(M4), npm 배포, 리플레이 스위트. 돌리는 법은 `docs/operator-guide.md`, 남은 일은 `docs/design/06-roadmap.md`.
