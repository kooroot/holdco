# Operator Guide · 운영자 가이드

> One command creates the company; a few minutes a week keep it honest. Everything the Operator does, in order.
> 명령 하나로 회사를 만들고, 일주일에 몇 분으로 회사를 정직하게 유지합니다. 운영자가 하는 일을 순서대로 정리했습니다.

---

## English

### 1. Create (once)

```bash
bunx holdco init              # interactive: answers become the company (bunx create-holdco is the same)
```

Until `@holdco/*` is on npm, run it from a checkout: `git clone https://github.com/kooroot/holdco && cd holdco && bun install && bunx holdco init`; the company is linked to the checkout's packages, so `git pull` in the checkout updates it.

The wizard asks for the directory, your GitHub handle (guessed from `gh`), the projects it works on (pick several from the git repositories near you, add paths, or have it create a new one), per project the command that proves it works (guessed from the repository; Verification runs it before every judge) and, with more than one, its class (core / experiment / maintenance / brand) and the effort split in percent, your plans' current usage with how hard to lean on them (pause at 90% and pace the week by default), the organization (full company or solo), how much it does on its own (autonomous by default: code merges need only Verification; you decide deploys, spend and anything irreversible), the models (Claude + Codex when both logins are found), a mission, the first objective, the voice of public posts (full preset), the language, and optionally a Telegram bot token. Then it scaffolds the company, registers the projects with their allocation, installs dependencies, compiles the guard, applies the models, writes the objective and the voice, saves the token to `~/.config/holdco/<company>.env` (mode 600; every `holdco` command loads it), pairs the bot with your chat, and runs `holdco doctor`. A company that passes doctor is one `bunx holdco smoke --cap 1` away from its first real ticket.

Scripted: `bunx holdco init <dir> --github <you> --project ../your-repo [--preset solo-dev|solo-codex|full] [--name n] [--mission "…"] [--timezone tz]` (or `create-holdco` with the same flags) does the scaffold, install, guard and doctor, and prints what is left:

| Left for you | Where |
|---|---|
| Engine access | **Claude: your Pro/Max login** (`claude login` once; usage draws from your plan, and Max/Team include monthly API credits that cover the Agent SDK). Doctor checks the login exactly as a session sees it; on a server without a keychain, `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` in the env file is the alternative. **Codex: an API key** (`OPENAI_API_KEY`); the ChatGPT login also works (`auth: subscription` copies `~/.codex/auth.json` into each session), but OpenAI recommends keys or Codex access tokens for scripted use, so that is your call. Set per engine in `company.yaml:engines.<id>.auth` |
| Alert tokens, keys | an env file outside the repo, mode 600 (`~/.config/holdco/<company>.env`), loaded by the service |
| The strategy's objectives | `governance/strategy.md` (replace the example row; the CEO opens tickets only for objectives listed here) |
| Codex prices, if Codex is in use | `company.yaml:engines.codex.prices` |
| A provider-side spend cap | at your model provider, then `budget.provider_cap_set: true` |

`holdco doctor` must pass before anything runs. It checks the config, the guard (real blocked and allowed calls on both engines), the Codex sandbox on this host, keys, projects, the strategy, canaries, the state database.

### 2. First run: the smoke test

```bash
cd my-co && bunx holdco smoke --cap 1     # one real ticket, at most $1 per session, ~3 sessions
```

Before anything runs unattended, let the company do one small thing with real models: `smoke` runs doctor, opens a T0 ticket ("put one file on a branch") on your first project, runs the senior, Verification and (with a CEO) one CEO cycle under a hard per-session cap, and prints the ticket's timeline, every session with its engine, model, turns and cost, and the spend. `done` means sessions, company tools, the guard, Verification and the kernel work together on this machine. Anything else: the events say where it stopped, and `.holdco/sessions/<id>/` holds each session's state.

### 3. Run

```bash
bunx holdco service install              # background: starts now, at login, and after crashes (launchd / systemd --user)
bunx holdco service status|logs|stop|restart|uninstall
bunx holdco supervise                    # the same thing in the foreground, for a look
```

`service install` writes the launchd agent (macOS) or systemd user unit (Linux) with your current `PATH` (so `bun`, `claude`, `codex`, `gh` are found), starts it, and prints the dashboard link and the log file (`.holdco/supervisor.log`). The env file is loaded by every `holdco` command, so the service sees the same tokens as your shell. A laptop still sleeps when closed; on power and open, `caffeinate` keeps it awake.

The supervisor also serves your **dashboard** on `127.0.0.1:7117` and prints its link (the link carries your Operator token, read from `.holdco/`, which agents cannot see). Without a running supervisor, `bunx holdco dashboard --open` serves it alone. Ten views: Home (today's numbers, activity, what is running), Inbox (approve or reject with the deadline in sight; `j`/`k`, `a`/`r`), Tickets (board with a drawer per ticket: timeline, sessions, verdict, diff), Audit (the weekly blind sample: diff and criteria first, the judge's verdict only after you grade), Quality (agreement per action type, promotion when eligible), Releases (the candidate under watch, promote or withdraw, action log with rollback), Sessions & spend, Organization (every seat, its model — change it there — and who is live), Controls (interrupts), Settings (the strategy, budget and rhythm, committed on save). `n` opens a new ticket from templates; a ticket's drawer takes notes that the next session on it reads as binding instructions, shows the branch's files rendered (research reports, drafts) beside the diff, and its **Live** tab follows the running session line by line — what it reads, runs, edits and says — then keeps that journal as the session's log. On a server, forward the port: `ssh -L 7117:127.0.0.1:7117 <host>`. Light and dark follow the OS; the language (English or Korean) follows the browser and can be set in Settings. Under the hood it is a React app (`packages/dashboard`, TanStack Router and Query, zyzz) over the kernel's Effect `HttpApi`; the API document is at `/api/openapi.json`, and from a checkout the client is built on first use, so there is no build step to remember.

**Telegram** turns your phone into the inbox. Once: create a bot with @BotFather, put its token in the env file as `TELEGRAM_BOT_TOKEN`, run `bunx holdco telegram setup` and send the bot any message; it pairs with your chat and commits the channel to `company.yaml`. From then on the supervisor delivers every inbox item with Approve / Reject buttons, and answers `/status`, `/tickets`, `/ticket <id>`, `/note <id> <text>` (a binding instruction for the next session on that ticket), `/unblock <id> <decision>`, `/new [department:] <title>`, `/pause <department> <reason>`, `/resume`, and `/halt` (with a confirmation button). Only your chat is obeyed; every action is the same kernel operation as the dashboard's. Messages come in the language the wizard asked for (`company.yaml:company.language`); `/lang ko` or `/lang en` changes it.

The supervisor is LLM-free. Every `runtime.tick` it: pings the heartbeat, applies interrupts, reaps dead sessions, classifies verified work, routes approvals, expires unanswered inbox items, runs the scheduled jobs (CEO cycle, COO reviews, tripwires, audit watch, graduation proposals, Improvement cycle, digest, release), and dispatches sessions (Verification first, then executives, then production) within budget shares and slots. Sessions run on the engine and model `company.yaml:roles` names for each role.

### 4. Give it work

```bash
bunx holdco ticket new --title "Add CSV export" --goal "users can download their data" \
  --criteria "export button on the settings page; a test covers the CSV format" --action code.merge.app
```

Or write objectives into `governance/strategy.md` and let the CEO open tickets. A ticket's life: `triaged → in_progress (senior, 0..N juniors in their own worktrees) → ready_for_verification → verified → executed` or `awaiting_approval → your inbox`. Merges into your repository happen only after an independent Verification verdict and, until an action graduates, after approval (COO for T2, you for T3; without a COO every T2 comes to you).

**Several projects, one company.** A company works on as many repositories as you register; one subscription login is one rate limit, so one company that allocates beats several that compete. Each project carries a class (core is dispatched first; experiments have kill criteria), a share of effort, its own verify command and locks. The CEO sees share against actual spend every cycle and opens the next ticket where a project is under its share. Change any of it whenever your priorities do — Settings → Projects in the dashboard (add a path, re-weight, change class or verify, remove) or:

```bash
bunx holdco project list                                  # class, share, spend this month, open tickets
bunx holdco project add ../other-repo --class experiment --share 20% --verify "bun test"
bunx holdco project set gap-trade --share 0.4 --class core
bunx holdco project remove old-repo                       # refused while it has open tickets; --force declines them
```

A share is also budget: a project's share of `budget.monthly_usd` is its cap for the month, and once it is spent no new work session starts there until next month or a bigger share (`budget.project_shares: soft` keeps the steering and drops the cap). The dashboard shows spend against cap per project, the stall line says "spent its share" instead of going quiet, and the Operator is told once. `min_tier` per project (Settings → Min tier, or `--min-tier T3`) floors every action there — a payments repository stays Operator-approved while a toy project is autonomous. Two companies on one machine: set `runtime.dashboard_port` on the second.

How verified branches land is per project too: `merge: github` (the wizard offers it for repositories with workflows) opens a pull request and merges when the checks pass, so the repository's CI gates every merge; `merge: local` merges and pushes at once, and the kernel then watches the CI run of that commit — a red one opens a ticket with the failing step and its log, instead of a vague "fix CI". `bunx holdco project set <id> --merge github` switches.

Every change is one commit to `company.yaml`. Removing a project never touches its repository.

**The real budget is your subscription.** Dollars are metered for comparability, but what actually runs out is the plans' rate-limit windows — Claude Code's 5-hour and 7-day, Codex's 5-hour and weekly. The kernel reads them from the same usage endpoints `/usage` and `/status` use (with your login on this host; Claude: `CLAUDE_CODE_OAUTH_TOKEN`, the keychain, or `~/.claude/.credentials.json`; Codex: `~/.codex/auth.json`), polls every five minutes, and also takes the rate-limit events sessions themselves report. They show as percentages on Home and in the dashboard's sidebar, on Sessions & spend, in `holdco status`, in Telegram's `/quota` and the daily brief (the weekly audit is there too: `/audit` sends the sample as blind cards with Pass / Fail buttons), and `holdco quota` reads them on demand. Policy (`budget.quota`): an engine past `pause_at` (default 90%) starts no new session until the window resets — the Operator is told once, and the stall line says so instead of going quiet; with `pace` (default on), when the 7-day window is more than `pace_margin` (15) points ahead of the clock, only core projects, Verification and the executive run until the week is back on pace. The CEO sees the same lines every cycle.

**Reading it in your language.** With `company.language: ko`, everything an agent wrote that you see — titles, goals, done criteria, the senior's and the judge's words, inbox items — is translated once by the cheapest model you have (Claude haiku, or the cheapest Codex model), cached, and shown translated on the dashboard (hover for the original) and in Telegram. Agents still work in English; the records stay English. It costs cents (capped at $1 a day, charged to a `translator` role).

### 5. Your weekly ten minutes

| Command | What it is |
|---|---|
| `holdco status` | running sessions, open tickets, spend, interrupts, inbox |
| `holdco inbox` · `inbox approve <id>` · `inbox reject <id>` | T3 decisions, CEO–COO disagreements, blocked tickets, actions with no declared executor (you run them), graduation proposals, withdrawn candidates. Urgent items alert you at once; routine ones are summarized daily at `policy.inbox.batch_at`. Unanswered items reject themselves after `policy.inbox.timeout` |
| `holdco audit` · `audit grade <ticket> approve\|reject` · `audit done` | blind-grade the weekly sample; your grades are the ground truth the judge is calibrated against. Skipping `freeze_after_missed` weeks freezes graduation and Improvement (L3) |
| `reports/digests/<date>.md` | the kernel's weekly digest (goals, spend, verdicts, agreement, executive health, pending items, assumptions) plus the CEO's narrative |
| `holdco interrupt L1\|L2\|L3\|L4\|L5 <target> --reason …` · `holdco resume …` | stop an agent, a department, Improvement, roll the organization back one release, or halt everything |
| `holdco rollback <action-log-id>` | revert a merge, or run a declared executor's `undo`, within or after its challenge window; the action type is demoted and a follow-up ticket opens |
| `holdco promote <action>` | apply an approved graduation (one tier down) to `company.yaml` |
| `holdco release` · `release withdraw` | promote the current candidate (or tag a release by hand); withdraw a candidate and revert `main` to the release |
| `holdco models` (alias `roles`) · `models set <role> <engine:model[:effort]>` · `models preset claude\|codex\|dual` | see and change which engine and model plays each role; validated (the judge never shares a producer's model). The defaults table is in `docs/design/02-config.md` |

Commands that loosen anything (`inbox approve`, `resume`, `promote`, `rollback`, `ticket unblock`) refuse to run without an interactive terminal; agents have none.

### 6. How it improves itself

Verification scores every ticket; you grade a blind sample weekly; agreement between the two is tracked per action type. When an action meets the graduation rule (enough samples, high agreement, a clean recent streak, no rollbacks or missed canaries) a proposal lands in your inbox; approving it moves the action one tier toward autonomy. Low agreement demotes it automatically. Once `modules.improvement.replay_min_tickets` labeled tickets exist, the weekly Improvement cycle diagnoses recurring failures and opens tickets for itself; its changes to `org/`, `protocols/` and `improvement/` are merged like any other work (verified, approved) and become a **candidate** release `rc-<n>`. If the candidate changes the judge (rubrics, the Verification charter or role), a replay gate first re-judges your labeled tickets with it and withdraws it unless agreement with your grades improves. Then `policy.release.canary_traffic` of production sessions run on the candidate for `policy.release.watch`; if their rejection rate stays within `max_regression` of the rest and nothing is demoted, it is promoted to `r<n>`, otherwise it is withdrawn, `main` is reverted and you are told. A demotion during the window still raises L4.

**Seeing why.** Every session's prompt is kept with its journal: in a ticket's Log tab, pick the session and press *prompt*. And the Improvement cycle need not wait for its week — `bunx holdco improve --now` starts it so you can watch its first candidate go through replay, canary and release.

### 7. What is not automated in this version

Deploys, publishes, outreach and credential actions run only if you declare how in `company.yaml`:

```yaml
executors:
  deploy.staging:
    command: ["./scripts/deploy.sh", "staging", "{branch}"]   # argv, no shell; {branch} {ticket} {deliverable} {previous}
    cwd: project
    env: [DEPLOY_TOKEN]                                        # only these names reach the process
    undo: ["./scripts/deploy.sh", "staging", "{previous}"]      # {previous} comes from a {"previous": …} line the command prints
    timeout: 15m
```

An action with no entry reaches your inbox as a "manual action" item with the branch and the request; you perform it and approve the item. Projects whose merges must go through GitHub (branch protection, CODEOWNERS, CI) set `merge: github`; the kernel opens the pull request, waits for checks and merges with your `gh` login. Codex hooks are verified for the sandbox but not for live blocking until a model session has been run (R8a).

---

## 한국어

### 1. 만들기 (한 번)

```bash
bunx holdco init              # 대화형: 답한 대로 회사가 만들어짐 (bunx create-holdco도 같음)
```

`@holdco/*`가 npm에 올라가기 전에는 체크아웃에서: `git clone https://github.com/kooroot/holdco && cd holdco && bun install && bunx holdco init`. 회사는 체크아웃의 패키지에 링크되므로 체크아웃에서 `git pull`하면 갱신됩니다.

마법사가 묻는 것: 디렉토리, GitHub 핸들(`gh`에서 추측), 작업할 프로젝트들(근처 git 저장소에서 여러 개 선택, 경로 추가, 또는 새 저장소 생성), 프로젝트마다 동작을 증명하는 명령(저장소에서 추측; 검증이 심판 전에 실행)과 — 둘 이상이면 — 구분(core / experiment / maintenance / brand)과 노력 배분(%), 조직(풀 컴퍼니 / 솔로), 자율 수준(기본 자율: 코드 머지는 검증만 통과하면 됨, 배포·지출·되돌릴 수 없는 건 당신이 결정), 모델(두 로그인이 다 있으면 Claude + Codex), 미션, 첫 목표, 공개 글의 목소리(풀 프리셋), 언어, 선택으로 Telegram 봇 토큰. 그다음 스캐폴드 → 프로젝트 등록 → 의존성 설치 → 가드 빌드 → 모델 적용 → 목표·목소리 기록 → 토큰을 `~/.config/holdco/<회사>.env`(mode 600, 모든 `holdco` 명령이 읽음)에 저장 → 봇과 채팅 짝 맺기 → `holdco doctor`까지 한 번에 합니다. doctor를 통과한 회사는 `bunx holdco smoke --cap 1` 한 줄이면 첫 실제 티켓을 돕니다.

스크립트용: `bunx holdco init <dir> --github <you> --project ../your-repo [--preset …]`(또는 같은 플래그의 `create-holdco`)는 스캐폴드·설치·가드·doctor만 하고 남은 일을 출력합니다.

### 2. 첫 실행: 스모크 테스트

`bunx holdco smoke --cap 1`. 무인으로 돌리기 전에 실제 모델로 작은 일 하나를 시킵니다. doctor를 돌리고, 첫 프로젝트에 T0 티켓("파일 하나를 브랜치에 올려라")을 열고, 세션당 상한 $1로 시니어·검증·(CEO가 있으면) CEO 주기 한 번을 돌린 뒤 티켓 타임라인, 세션별 엔진·모델·턴·비용, 총 지출을 출력합니다. `done`이면 세션·회사 도구·가드·검증·커널이 이 머신에서 함께 돌아간다는 뜻입니다. 아니면 이벤트가 어디서 멈췄는지 알려주고, `.holdco/sessions/<id>/`에 세션별 상태가 남습니다.

### 3. 돌리기

`bunx holdco service install` — 백그라운드로 지금 시작하고, 로그인 시·크래시 후에도 다시 뜹니다(macOS launchd / Linux systemd --user). 현재 `PATH`를 그대로 넣으므로 `bun`, `claude`, `codex`, `gh`가 그대로 잡히고, 대시보드 링크와 로그 파일(`.holdco/supervisor.log`)을 출력합니다. `service status|logs|stop|restart|uninstall`. 닫힌 노트북은 여전히 잠들며, 열어두고 전원을 꽂으면 `caffeinate`가 깨어 있게 합니다. 터미널에서 직접 보려면 `bunx holdco supervise`. 슈퍼바이저가 **대시보드**를 `127.0.0.1:7117`에 함께 띄우고 링크를 출력합니다(링크에 운영자 토큰이 들어 있고, 토큰은 에이전트가 못 읽는 `.holdco/`에 있음). 슈퍼바이저 없이도 `bunx holdco dashboard --open`으로 볼 수 있습니다. 화면 열 개: 홈(오늘의 숫자, 활동, 실행 중), 인박스(시한을 보며 승인·거절, `j`/`k`, `a`/`r`), 티켓 보드(티켓마다 타임라인·세션·판정·diff 서랍), 감사(주간 블라인드 샘플 — diff와 기준을 먼저 보고 채점하면 그때 심판 판정이 열림), 품질(행동 유형별 일치율, 조건 충족 시 승격), 릴리스(감시 중인 후보, 승격·철회, 롤백 가능한 행동 로그), 세션·지출, 조직(자리마다 모델 — 여기서 바꿈 — 과 실행 중 표시), 제어(인터럽트), 설정(전략·예산·리듬, 저장 시 커밋). `n`으로 템플릿에서 새 티켓을 열고, 티켓 서랍의 메모는 다음 세션이 구속력 있는 지시로 읽으며, 브랜치의 파일(리서치 보고서, 초안)을 diff 옆에 렌더링해 보여주고, **Live** 탭은 실행 중인 세션이 무엇을 읽고 실행하고 고치고 말하는지 줄 단위로 따라가다가 끝나면 그 저널을 세션 로그로 남깁니다. 서버에서는 `ssh -L 7117:127.0.0.1:7117 <host>`로 포트를 연결합니다. 라이트·다크는 OS 설정을, 언어(한국어·영어)는 브라우저를 따르며 설정에서 바꿀 수 있습니다. 내부는 커널의 Effect `HttpApi` 위에 올린 React 앱(`packages/dashboard`, TanStack Router·Query, zyzz)이고, API 문서는 `/api/openapi.json`에 있으며, 체크아웃에서는 처음 쓸 때 클라이언트를 알아서 빌드하므로 따로 기억할 빌드 단계가 없습니다.

**Telegram**은 폰을 인박스로 만듭니다. 한 번만: @BotFather로 봇을 만들고 토큰을 env 파일에 `TELEGRAM_BOT_TOKEN`으로 넣은 뒤 `bunx holdco telegram setup`을 실행하고 봇에게 아무 메시지나 보내면 채팅과 짝을 맺고 채널을 `company.yaml`에 커밋합니다. 이후 슈퍼바이저가 모든 인박스 항목을 승인/거절 버튼과 함께 보내고, `/status`, `/tickets`, `/ticket <id>`, `/note <id> <내용>`(그 티켓의 다음 세션에 대한 구속력 있는 지시), `/unblock <id> <결정>`, `/new [부서:] <제목>`, `/pause <부서> <사유>`, `/resume`, `/halt`(확인 버튼)에 답합니다. 운영자의 채팅만 따르며, 모든 동작은 대시보드와 같은 커널 작업입니다. 메시지는 마법사에서 고른 언어(`company.yaml:company.language`)로 오고, `/lang ko`·`/lang en`으로 바꿉니다. 슈퍼바이저에는 LLM이 없습니다. 매 틱마다 하트비트, 인터럽트 적용, 죽은 세션 회수, 검증된 작업 분류, 승인 경로, 인박스 시한 만료, 예약 작업(CEO 주기, COO 검토, 트립와이어, 감사 감시, 승격 제안, 개선 주기, 다이제스트, 릴리스), 그리고 예산 몫과 슬롯 안에서의 세션 배분(검증 → 경영진 → 생산 순)을 수행합니다. 세션은 `company.yaml:roles`가 역할마다 지정한 엔진과 모델로 돕니다.

### 4. 일 주기

`holdco ticket new --title … --criteria "a; b" --action code.merge.app`로 직접 열거나, `governance/strategy.md`에 목표를 적고 CEO가 열게 둡니다. 티켓은 `triaged → in_progress(시니어 + 주니어 0~N명, 각자 워크트리) → ready_for_verification → verified → 실행` 또는 `awaiting_approval → 인박스`로 흐릅니다. 내 레포로의 머지는 독립된 검증 판정 뒤에만, 그리고 행동이 승격되기 전까지는 승인(T2는 COO, T3는 운영자, COO가 없으면 T2도 운영자) 뒤에만 일어납니다.

**프로젝트 여러 개, 회사 하나.** 회사는 등록한 만큼의 저장소에서 일합니다. 구독 로그인 하나가 레이트 리밋 하나이므로, 배분하는 회사 하나가 경쟁하는 회사 여럿보다 낫습니다. 프로젝트마다 구분(core가 먼저 배정되고 experiment는 중단 기준을 가짐), 노력 배분, 자체 검증 명령과 잠금이 있습니다. CEO는 매 사이클 배분 대비 실제 지출을 보고 배분에 못 미치는 프로젝트의 다음 티켓부터 엽니다. 우선순위가 바뀌면 언제든 바꾸세요 — 대시보드 설정 → 프로젝트(경로 추가, 재배분, 구분·검증 변경, 제거) 또는:

```bash
bunx holdco project list                                  # 구분, 배분, 이번 달 지출, 열린 티켓
bunx holdco project add ../other-repo --class experiment --share 20% --verify "bun test"
bunx holdco project set gap-trade --share 0.4 --class core
bunx holdco project remove old-repo                       # 열린 티켓이 있으면 거부; --force는 전부 거절 처리
```

배분은 예산이기도 합니다. 프로젝트의 배분 × `budget.monthly_usd`가 그 달의 상한이고, 다 쓰면 다음 달이나 배분을 늘리기 전까지 새 작업 세션이 시작되지 않습니다(`budget.project_shares: soft`면 유도만 하고 상한은 없음). 대시보드는 프로젝트별 지출/상한을 보여주고, 정체 진단은 조용히 멈추는 대신 "배분을 다 씀"이라고 말하며, 운영자에게 한 번 알립니다. 프로젝트별 `min_tier`(설정 → 최소 등급, 또는 `--min-tier T3`)는 그 프로젝트의 모든 행동 등급 하한입니다 — 결제 저장소는 운영자 승인으로, 장난감 프로젝트는 자율로. 한 머신에 회사 둘이면 두 번째에 `runtime.dashboard_port`를 지정합니다.

검증된 브랜치가 어떻게 들어가는지도 프로젝트별입니다: `merge: github`(워크플로가 있는 저장소에는 마법사가 제안)는 PR을 열고 체크가 통과하면 머지하므로 저장소의 CI가 모든 머지를 지키고, `merge: local`은 바로 머지·푸시하되 커널이 그 커밋의 CI 실행을 지켜봅니다 — 빨개지면 막연한 "CI 고쳐" 대신 실패 단계와 로그를 담은 티켓이 열립니다. `bunx holdco project set <id> --merge github`로 전환.

모든 변경은 `company.yaml`에 커밋 하나입니다. 프로젝트 제거는 저장소를 건드리지 않습니다.

**진짜 예산은 구독입니다.** 달러는 비교를 위해 계량하지만 실제로 바닥나는 건 구독의 레이트 리밋 창 — Claude Code의 5시간·7일, Codex의 5시간·주간 — 입니다. 커널은 `/usage`·`/status`가 쓰는 사용량 엔드포인트를 이 호스트의 로그인으로 읽고(Claude: `CLAUDE_CODE_OAUTH_TOKEN`, 키체인, 또는 `~/.claude/.credentials.json`; Codex: `~/.codex/auth.json`), 5분마다 폴링하며, 세션 자체가 보고하는 레이트 리밋 이벤트도 반영합니다. 홈과 대시보드 사이드바, 세션·지출 화면, `holdco status`, 텔레그램 `/quota`와 일일 브리핑(주간 감사도 거기서: `/audit`이 샘플을 통과/반려 버튼이 달린 블라인드 카드로 보냄)에 퍼센트로 보이고 `holdco quota`로 즉시 읽을 수 있습니다. 정책(`budget.quota`): `pause_at`(기본 90%)을 넘긴 엔진은 창이 리셋될 때까지 새 세션을 시작하지 않고 — 운영자에게 한 번 알리고 정체 진단이 이유를 말함 — `pace`(기본 켜짐)는 7일 창이 시계보다 `pace_margin`(15)p 이상 앞서면 주간 페이스로 돌아올 때까지 core 프로젝트·검증·경영진만 돌립니다. CEO도 매 사이클 같은 줄을 봅니다.

**당신의 언어로 읽기.** `company.language: ko`면 에이전트가 쓴 글 중 당신이 보는 것 — 제목, 목표, 완료 조건, 시니어와 심판의 말, 인박스 항목 — 은 가장 싼 모델(Claude haiku 또는 가장 싼 Codex 모델)이 한 번 번역해 캐시하고, 대시보드(원문은 호버)와 텔레그램에 번역으로 보입니다. 에이전트는 여전히 영어로 일하고 기록도 영어입니다. 비용은 몇 센트(하루 $1 상한, `translator` 역할에 과금).

### 5. 매주 10분

위 표와 같습니다. `status`, `inbox`(T3 결정, CEO·COO 불일치, 막힌 티켓, 실행기 없는 행동, 승격 제안, 철회된 후보. 긴급 항목은 즉시 알림, 나머지는 `inbox.batch_at`에 하루 한 번 요약. 무응답은 시한 후 자동 거절), `audit`(블라인드 채점. 이 채점이 심판을 보정하는 정답이며, 건너뛰면 승격과 개선이 동결), 다이제스트 읽기, `interrupt`/`resume`, `rollback`, `promote`, `release`. 느슨하게 하는 명령은 대화형 터미널 없이는 실행되지 않습니다.

### 6. 자기개선이 일어나는 방식

검증이 모든 티켓을 채점하고, 운영자가 매주 블라인드 샘플을 채점하고, 둘의 일치율을 행동 유형별로 추적합니다. 승격 규칙을 충족하면 인박스에 제안이 오고, 승인하면 한 단계 자율 쪽으로 이동합니다. 일치율이 낮으면 자동 강등됩니다. 라벨 붙은 티켓이 `replay_min_tickets`개 쌓이면 주간 개선 주기가 반복되는 실패를 진단해 스스로 티켓을 열고, 그 변경(`org/`, `protocols/`, `improvement/`)은 다른 작업과 똑같이 검증·승인을 거쳐 **후보** 릴리스 `rc-<n>`이 됩니다. 후보가 심판(루브릭, 검증 헌장·역할)을 바꾸면 먼저 리플레이 게이트가 운영자가 채점한 티켓을 후보로 다시 판정해 일치율이 오르지 않으면 철회합니다. 그 뒤 생산 세션의 `policy.release.canary_traffic`만 `policy.release.watch` 동안 후보 조직으로 돌고, 반려율이 나머지보다 `max_regression` 이상 나쁘지 않고 강등이 없으면 `r<n>`으로 승격, 아니면 철회하고 `main`을 되돌린 뒤 알립니다. 감시 기간 안의 강등은 여전히 L4를 겁니다.

**왜 그랬는지 보기.** 모든 세션의 프롬프트가 저널과 함께 남습니다: 티켓의 로그 탭에서 세션을 고르고 *프롬프트*를 누르세요. 개선 사이클도 주를 기다릴 필요 없이 `bunx holdco improve --now`로 시작해 첫 후보가 리플레이·카나리·릴리스를 거치는 걸 지켜볼 수 있습니다.

### 7. 이 버전에서 자동화되지 않은 것

배포·게시·외부 연락·자격 증명 행동은 `company.yaml:executors`에 운영자가 실행 방법(셸 없는 argv, 플레이스홀더 `{branch} {ticket} {deliverable} {previous}`, 환경변수 허용 목록, 선택적 `undo`)을 선언했을 때만 커널이 실행합니다. 선언이 없는 행동은 "manual action" 인박스 항목으로 와서 운영자가 직접 수행하고 승인합니다. 머지를 GitHub(브랜치 보호, CODEOWNERS, CI)로 거쳐야 하는 프로젝트는 `merge: github`로 두면 커널이 PR을 열고 체크를 기다려 운영자의 `gh` 로그인으로 머지합니다. Codex 훅은 샌드박스까지 확인했고 실제 차단은 모델 세션을 돌려봐야 합니다(R8a).
