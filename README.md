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

Until `@holdco/*` is on npm, start from this repository:

```bash
git clone https://github.com/kooroot/holdco && cd holdco && bun install
bunx holdco init                                     # the wizard: nine answers, then a company that passes doctor
```

The wizard asks for the directory, your GitHub handle, the first project (a repository near you, or a new one it creates), the organization, the models (Claude + Codex when both logins are found — no API keys needed), a mission, the first objective, the voice of public posts, the language, and optionally a Telegram bot token. It scaffolds, installs, compiles the guard, applies the models, pairs the bot and runs `holdco doctor`. Then:

```bash
cd ../my-co
bunx holdco smoke --cap 1        # one real ticket end to end, ≤ $1 per session
bunx holdco service install      # 24/7 in the background (launchd / systemd --user); prints the dashboard link
```

From there the company runs itself: the CEO opens tickets from `governance/strategy.md`, seniors work in worktrees, Verification judges on the other engine, T2/T3 actions go through the COO's second key, and the Operator gets a **dashboard** (ten views, a live feed of what each session is doing, blind weekly audit, Korean or English) and a **Telegram bot** (every decision with Approve / Reject buttons, `/status`, `/new`, `/note`, `/pause`, `/halt`). Ten minutes a week: `docs/operator-guide.md`.

### Product feedback

Feed real product incidents into `holdco observe <file.json>`, reuse scoped Operator
judgments with `holdco decision add|list|revoke`, and declare executor `postcheck`
commands to verify the observed result before closing work. See
[Product feedback and decision memory](docs/design/09-product-feedback.md) for setup,
recovery behavior and the migration of `rollback-tested` to evidence-based checks.

### Repository

```
packages/
  kernel/          @holdco/kernel: config schema, policy, guard + compiled hook, protocols, engine contract,
                   scaffold + wizard, supervisor, Telegram bridge, dashboard API (Effect HttpApi), CLI `holdco`
  dashboard/       @holdco/dashboard: the Operator's dashboard — React 19, TanStack Router/Query, zyzz,
                   typed client derived from the kernel's HttpApi
  engine-claude/   @holdco/engine-claude: Claude Agent SDK adapter
  engine-codex/    @holdco/engine-codex: Codex SDK adapter, generated CODEX_HOME, host probe
  create-holdco/   create-holdco: entry point (same wizard as `holdco init`)
examples/          company.<preset>.yaml, generated from the presets
docs/design/       components, config, supervisor, packaging, security, roadmap, engines, execution & release,
                   and the decision log (D1–D61)
docs/engines/      claude-code.md, codex.md
```

A company created by the wizard holds the constitution, governance, evals and `company.yaml` (Operator only, enforced at runtime and by CODEOWNERS), the organization in `org/` (departments, roles, skills; changed only by Improvement, through releases), `AGENTS.md` for every engine, and kernel state in `.holdco/` (unreadable to agents: the ticket database, session journals, the dashboard token). Project code stays in its own repositories.

### Status

Running for real: a company created by the wizard on a Mac, Claude (Pro/Max login) producing and Codex (ChatGPT login) judging, passes doctor, completes `smoke`, and the CEO opens work from the strategy; the Operator approves from Telegram and watches sessions live on the dashboard. 360+ tests cover the guard, config, scaffold, engine adapters, supervisor simulations, dashboard API, Telegram bridge and CLI. Not yet done: npm publishing (so `bunx create-holdco` works outside a checkout), a week of dogfooding, and routines. `docs/design/06-roadmap.md` has the rest.

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

`@holdco/*`가 npm에 올라가기 전에는 이 레포에서 시작합니다:

```bash
git clone https://github.com/kooroot/holdco && cd holdco && bun install
bunx holdco init                                     # 마법사: 아홉 가지 답하면 doctor를 통과하는 회사가 생김
```

마법사는 디렉토리, GitHub 핸들, 첫 프로젝트(근처 저장소 또는 새로 만들 저장소), 조직, 모델(Claude·Codex 로그인이 둘 다 있으면 자동으로 둘 다 — API 키 불필요), 미션, 첫 목표, 공개 글의 목소리, 언어, 선택으로 Telegram 봇 토큰을 묻고, 스캐폴드·설치·가드 빌드·모델 적용·봇 짝 맺기·`holdco doctor`까지 합니다. 그다음:

```bash
cd ../my-co
bunx holdco smoke --cap 1        # 실제 티켓 하나를 끝까지, 세션당 ≤ $1
bunx holdco service install      # 24/7 백그라운드 (launchd / systemd --user); 대시보드 링크 출력
```

이후 회사는 스스로 돌아갑니다. CEO가 `governance/strategy.md`에서 티켓을 열고, 시니어가 워크트리에서 일하고, 검증이 다른 엔진에서 판정하고, T2/T3 행동은 COO의 두 번째 열쇠를 거칩니다. 운영자에게는 **대시보드**(화면 열 개, 세션이 지금 뭘 하는지 보는 라이브 피드, 주간 블라인드 감사, 한국어·영어)와 **Telegram 봇**(모든 결정이 승인/거절 버튼과 함께, `/status`, `/new`, `/note`, `/pause`, `/halt`)이 있습니다. 매주 10분: `docs/operator-guide.md`.

### 레포 구조

위 트리와 같습니다. 커널(`@holdco/kernel`: 설정·정책·가드·스캐폴드와 마법사·슈퍼바이저·Telegram 브리지·대시보드 API, 명령어 `holdco`), 대시보드(`@holdco/dashboard`: React + TanStack + zyzz, 커널의 HttpApi에서 파생된 타입 클라이언트), Claude 어댑터, Codex 어댑터, 진입점 `create-holdco`(`holdco init`과 같은 마법사)로 나뉩니다. 마법사로 만든 회사에는 헌법·거버넌스·평가·`company.yaml`(운영자만, 실행 시점과 CODEOWNERS로 강제), 조직(`org/`), 모든 엔진이 읽는 `AGENTS.md`, 커널 상태(`.holdco/`: 티켓 DB, 세션 저널, 대시보드 토큰 — 에이전트 읽기 불가)가 들어갑니다. 프로젝트 코드는 각자의 레포에 그대로 둡니다.

### 상태

실제로 돌아갑니다: 맥에서 마법사로 만든 회사가 Claude(Pro/Max 로그인)로 생산하고 Codex(ChatGPT 로그인)로 판정하며, doctor 통과, `smoke` 완료, CEO가 전략에서 일을 열고, 운영자는 Telegram에서 승인하고 대시보드에서 세션을 실시간으로 봅니다. 360개 넘는 테스트가 가드·설정·스캐폴드·엔진 어댑터·슈퍼바이저 시뮬레이션·대시보드 API·Telegram 브리지·CLI를 덮습니다. 아직 안 된 것: npm 배포(체크아웃 밖에서 `bunx create-holdco`), 일주일 실사용, 루틴. 나머지는 `docs/design/06-roadmap.md`.
