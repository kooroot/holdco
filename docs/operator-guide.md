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

The wizard asks for the directory, your GitHub handle (guessed from `gh`), the first project (git repositories near you are listed), the organization (full company or solo), the models (Claude + Codex when both logins are found), a mission, the first objective, the voice of public posts (full preset), and optionally a Telegram bot token. Then it scaffolds the company, registers the project, installs dependencies, compiles the guard, applies the models, writes the objective and the voice, saves the token to `~/.config/holdco/<company>.env` (mode 600; every `holdco` command loads it), pairs the bot with your chat, and runs `holdco doctor`. A company that passes doctor is one `bunx holdco smoke --cap 1` away from its first real ticket.

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
bunx holdco supervise                    # foreground; put it under systemd/launchd for 24/7
```

The supervisor also serves your **dashboard** on `127.0.0.1:7117` and prints its link (the link carries your Operator token, read from `.holdco/`, which agents cannot see). Without a running supervisor, `bunx holdco dashboard --open` serves it alone. Ten views: Home (today's numbers, activity, what is running), Inbox (approve or reject with the deadline in sight; `j`/`k`, `a`/`r`), Tickets (board with a drawer per ticket: timeline, sessions, verdict, diff), Audit (the weekly blind sample: diff and criteria first, the judge's verdict only after you grade), Quality (agreement per action type, promotion when eligible), Releases (the candidate under watch, promote or withdraw, action log with rollback), Sessions & spend, Organization (every seat, its model — change it there — and who is live), Controls (interrupts), Settings (the strategy, budget and rhythm, committed on save). `n` opens a new ticket from templates; a ticket's drawer takes notes that the next session on it reads as binding instructions, shows the branch's files rendered (research reports, drafts) beside the diff, and its **Live** tab follows the running session line by line — what it reads, runs, edits and says — then keeps that journal as the session's log. On a server, forward the port: `ssh -L 7117:127.0.0.1:7117 <host>`. Light and dark follow the OS. Under the hood it is a React app (`packages/dashboard`, TanStack Router and Query, zyzz) over the kernel's Effect `HttpApi`; the API document is at `/api/openapi.json`, and from a checkout the client is built on first use, so there is no build step to remember.

**Telegram** turns your phone into the inbox. Once: create a bot with @BotFather, put its token in the env file as `TELEGRAM_BOT_TOKEN`, run `bunx holdco telegram setup` and send the bot any message; it pairs with your chat and commits the channel to `company.yaml`. From then on the supervisor delivers every inbox item with Approve / Reject buttons, and answers `/status`, `/tickets`, `/ticket <id>`, `/note <id> <text>` (a binding instruction for the next session on that ticket), `/unblock <id> <decision>`, `/new [department:] <title>`, `/pause <department> <reason>`, `/resume`, and `/halt` (with a confirmation button). Only your chat is obeyed; every action is the same kernel operation as the dashboard's.

The supervisor is LLM-free. Every `runtime.tick` it: pings the heartbeat, applies interrupts, reaps dead sessions, classifies verified work, routes approvals, expires unanswered inbox items, runs the scheduled jobs (CEO cycle, COO reviews, tripwires, audit watch, graduation proposals, Improvement cycle, digest, release), and dispatches sessions (Verification first, then executives, then production) within budget shares and slots. Sessions run on the engine and model `company.yaml:roles` names for each role.

### 4. Give it work

```bash
bunx holdco ticket new --title "Add CSV export" --goal "users can download their data" \
  --criteria "export button on the settings page; a test covers the CSV format" --action code.merge.app
```

Or write objectives into `governance/strategy.md` and let the CEO open tickets. A ticket's life: `triaged → in_progress (senior, 0..N juniors in their own worktrees) → ready_for_verification → verified → executed` or `awaiting_approval → your inbox`. Merges into your repository happen only after an independent Verification verdict and, until an action graduates, after approval (COO for T2, you for T3; without a COO every T2 comes to you).

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

마법사가 묻는 것: 디렉토리, GitHub 핸들(`gh`에서 추측), 첫 프로젝트(근처 git 저장소를 골라줌), 조직(풀 컴퍼니 / 솔로), 모델(두 로그인이 다 있으면 Claude + Codex), 미션, 첫 목표, 공개 글의 목소리(풀 프리셋), 선택으로 Telegram 봇 토큰. 그다음 스캐폴드 → 프로젝트 등록 → 의존성 설치 → 가드 빌드 → 모델 적용 → 목표·목소리 기록 → 토큰을 `~/.config/holdco/<회사>.env`(mode 600, 모든 `holdco` 명령이 읽음)에 저장 → 봇과 채팅 짝 맺기 → `holdco doctor`까지 한 번에 합니다. doctor를 통과한 회사는 `bunx holdco smoke --cap 1` 한 줄이면 첫 실제 티켓을 돕니다.

스크립트용: `bunx holdco init <dir> --github <you> --project ../your-repo [--preset …]`(또는 같은 플래그의 `create-holdco`)는 스캐폴드·설치·가드·doctor만 하고 남은 일을 출력합니다.

### 2. 첫 실행: 스모크 테스트

`bunx holdco smoke --cap 1`. 무인으로 돌리기 전에 실제 모델로 작은 일 하나를 시킵니다. doctor를 돌리고, 첫 프로젝트에 T0 티켓("파일 하나를 브랜치에 올려라")을 열고, 세션당 상한 $1로 시니어·검증·(CEO가 있으면) CEO 주기 한 번을 돌린 뒤 티켓 타임라인, 세션별 엔진·모델·턴·비용, 총 지출을 출력합니다. `done`이면 세션·회사 도구·가드·검증·커널이 이 머신에서 함께 돌아간다는 뜻입니다. 아니면 이벤트가 어디서 멈췄는지 알려주고, `.holdco/sessions/<id>/`에 세션별 상태가 남습니다.

### 3. 돌리기

`bunx holdco supervise`. 슈퍼바이저가 **대시보드**를 `127.0.0.1:7117`에 함께 띄우고 링크를 출력합니다(링크에 운영자 토큰이 들어 있고, 토큰은 에이전트가 못 읽는 `.holdco/`에 있음). 슈퍼바이저 없이도 `bunx holdco dashboard --open`으로 볼 수 있습니다. 화면 열 개: 홈(오늘의 숫자, 활동, 실행 중), 인박스(시한을 보며 승인·거절, `j`/`k`, `a`/`r`), 티켓 보드(티켓마다 타임라인·세션·판정·diff 서랍), 감사(주간 블라인드 샘플 — diff와 기준을 먼저 보고 채점하면 그때 심판 판정이 열림), 품질(행동 유형별 일치율, 조건 충족 시 승격), 릴리스(감시 중인 후보, 승격·철회, 롤백 가능한 행동 로그), 세션·지출, 조직(자리마다 모델 — 여기서 바꿈 — 과 실행 중 표시), 제어(인터럽트), 설정(전략·예산·리듬, 저장 시 커밋). `n`으로 템플릿에서 새 티켓을 열고, 티켓 서랍의 메모는 다음 세션이 구속력 있는 지시로 읽으며, 브랜치의 파일(리서치 보고서, 초안)을 diff 옆에 렌더링해 보여주고, **Live** 탭은 실행 중인 세션이 무엇을 읽고 실행하고 고치고 말하는지 줄 단위로 따라가다가 끝나면 그 저널을 세션 로그로 남깁니다. 서버에서는 `ssh -L 7117:127.0.0.1:7117 <host>`로 포트를 연결합니다. 라이트·다크는 OS 설정을 따릅니다. 내부는 커널의 Effect `HttpApi` 위에 올린 React 앱(`packages/dashboard`, TanStack Router·Query, zyzz)이고, API 문서는 `/api/openapi.json`에 있으며, 체크아웃에서는 처음 쓸 때 클라이언트를 알아서 빌드하므로 따로 기억할 빌드 단계가 없습니다.

**Telegram**은 폰을 인박스로 만듭니다. 한 번만: @BotFather로 봇을 만들고 토큰을 env 파일에 `TELEGRAM_BOT_TOKEN`으로 넣은 뒤 `bunx holdco telegram setup`을 실행하고 봇에게 아무 메시지나 보내면 채팅과 짝을 맺고 채널을 `company.yaml`에 커밋합니다. 이후 슈퍼바이저가 모든 인박스 항목을 승인/거절 버튼과 함께 보내고, `/status`, `/tickets`, `/ticket <id>`, `/note <id> <내용>`(그 티켓의 다음 세션에 대한 구속력 있는 지시), `/unblock <id> <결정>`, `/new [부서:] <제목>`, `/pause <부서> <사유>`, `/resume`, `/halt`(확인 버튼)에 답합니다. 운영자의 채팅만 따르며, 모든 동작은 대시보드와 같은 커널 작업입니다. 24/7이면 systemd/launchd 아래에 둡니다. 슈퍼바이저에는 LLM이 없습니다. 매 틱마다 하트비트, 인터럽트 적용, 죽은 세션 회수, 검증된 작업 분류, 승인 경로, 인박스 시한 만료, 예약 작업(CEO 주기, COO 검토, 트립와이어, 감사 감시, 승격 제안, 개선 주기, 다이제스트, 릴리스), 그리고 예산 몫과 슬롯 안에서의 세션 배분(검증 → 경영진 → 생산 순)을 수행합니다. 세션은 `company.yaml:roles`가 역할마다 지정한 엔진과 모델로 돕니다.

### 4. 일 주기

`holdco ticket new --title … --criteria "a; b" --action code.merge.app`로 직접 열거나, `governance/strategy.md`에 목표를 적고 CEO가 열게 둡니다. 티켓은 `triaged → in_progress(시니어 + 주니어 0~N명, 각자 워크트리) → ready_for_verification → verified → 실행` 또는 `awaiting_approval → 인박스`로 흐릅니다. 내 레포로의 머지는 독립된 검증 판정 뒤에만, 그리고 행동이 승격되기 전까지는 승인(T2는 COO, T3는 운영자, COO가 없으면 T2도 운영자) 뒤에만 일어납니다.

### 5. 매주 10분

위 표와 같습니다. `status`, `inbox`(T3 결정, CEO·COO 불일치, 막힌 티켓, 실행기 없는 행동, 승격 제안, 철회된 후보. 긴급 항목은 즉시 알림, 나머지는 `inbox.batch_at`에 하루 한 번 요약. 무응답은 시한 후 자동 거절), `audit`(블라인드 채점. 이 채점이 심판을 보정하는 정답이며, 건너뛰면 승격과 개선이 동결), 다이제스트 읽기, `interrupt`/`resume`, `rollback`, `promote`, `release`. 느슨하게 하는 명령은 대화형 터미널 없이는 실행되지 않습니다.

### 6. 자기개선이 일어나는 방식

검증이 모든 티켓을 채점하고, 운영자가 매주 블라인드 샘플을 채점하고, 둘의 일치율을 행동 유형별로 추적합니다. 승격 규칙을 충족하면 인박스에 제안이 오고, 승인하면 한 단계 자율 쪽으로 이동합니다. 일치율이 낮으면 자동 강등됩니다. 라벨 붙은 티켓이 `replay_min_tickets`개 쌓이면 주간 개선 주기가 반복되는 실패를 진단해 스스로 티켓을 열고, 그 변경(`org/`, `protocols/`, `improvement/`)은 다른 작업과 똑같이 검증·승인을 거쳐 **후보** 릴리스 `rc-<n>`이 됩니다. 후보가 심판(루브릭, 검증 헌장·역할)을 바꾸면 먼저 리플레이 게이트가 운영자가 채점한 티켓을 후보로 다시 판정해 일치율이 오르지 않으면 철회합니다. 그 뒤 생산 세션의 `policy.release.canary_traffic`만 `policy.release.watch` 동안 후보 조직으로 돌고, 반려율이 나머지보다 `max_regression` 이상 나쁘지 않고 강등이 없으면 `r<n>`으로 승격, 아니면 철회하고 `main`을 되돌린 뒤 알립니다. 감시 기간 안의 강등은 여전히 L4를 겁니다.

### 7. 이 버전에서 자동화되지 않은 것

배포·게시·외부 연락·자격 증명 행동은 `company.yaml:executors`에 운영자가 실행 방법(셸 없는 argv, 플레이스홀더 `{branch} {ticket} {deliverable} {previous}`, 환경변수 허용 목록, 선택적 `undo`)을 선언했을 때만 커널이 실행합니다. 선언이 없는 행동은 "manual action" 인박스 항목으로 와서 운영자가 직접 수행하고 승인합니다. 머지를 GitHub(브랜치 보호, CODEOWNERS, CI)로 거쳐야 하는 프로젝트는 `merge: github`로 두면 커널이 PR을 열고 체크를 기다려 운영자의 `gh` 로그인으로 머지합니다. Codex 훅은 샌드박스까지 확인했고 실제 차단은 모델 세션을 돌려봐야 합니다(R8a).
