# Operator Guide · 운영자 가이드

> One command creates the company; a few minutes a week keep it honest. Everything the Operator does, in order.
> 명령 하나로 회사를 만들고, 일주일에 몇 분으로 회사를 정직하게 유지합니다. 운영자가 하는 일을 순서대로 정리했습니다.

---

## English

### 1. Create (once)

```bash
bunx create-holdco my-co --github <you> --project ../your-repo \
  [--preset solo-dev|solo-codex|full] [--name n] [--mission "…"] [--timezone Asia/Seoul]
```

This scaffolds the company, registers your repository as the first project, renders `governance/strategy.md`, installs dependencies, compiles the guard binary and runs `holdco doctor`. What it cannot do for you is printed at the end:

| Left for you | Where |
|---|---|
| Engine access | **Claude: your Pro/Max login** (`claude login` once as the Operator; usage draws from your plan, and Max/Team include monthly API credits that cover the Agent SDK). **Codex: an API key** (`OPENAI_API_KEY`); the ChatGPT login also works (`auth: subscription` copies `~/.codex/auth.json` into each session), but OpenAI recommends keys or Codex access tokens for scripted use, so that is your call. Set per engine in `company.yaml:engines.<id>.auth` |
| Alert tokens, keys | an env file outside the repo, mode 600 (`~/.config/holdco/<company>.env`), loaded by the service |
| The strategy's objectives | `governance/strategy.md` (replace the example row; the CEO opens tickets only for objectives listed here) |
| Codex prices, if Codex is in use | `company.yaml:engines.codex.prices` |
| A provider-side spend cap | at your model provider, then `budget.provider_cap_set: true` |

`holdco doctor` must pass before anything runs. It checks the config, the guard (real blocked and allowed calls on both engines), the Codex sandbox on this host, keys, projects, the strategy, canaries, the state database.

### 2. Run

```bash
cd my-co && bunx holdco supervise        # foreground; put it under systemd/launchd for 24/7
```

The supervisor is LLM-free. Every `runtime.tick` it: pings the heartbeat, applies interrupts, reaps dead sessions, classifies verified work, routes approvals, expires unanswered inbox items, runs the scheduled jobs (CEO cycle, COO reviews, tripwires, audit watch, graduation proposals, Improvement cycle, digest, release), and dispatches sessions (Verification first, then executives, then production) within budget shares and slots. Sessions run on the engine and model `company.yaml:roles` names for each role.

### 3. Give it work

```bash
bunx holdco ticket new --title "Add CSV export" --goal "users can download their data" \
  --criteria "export button on the settings page; a test covers the CSV format" --action code.merge.app
```

Or write objectives into `governance/strategy.md` and let the CEO open tickets. A ticket's life: `triaged → in_progress (senior, 0..N juniors in their own worktrees) → ready_for_verification → verified → executed` or `awaiting_approval → your inbox`. Merges into your repository happen only after an independent Verification verdict and, until an action graduates, after approval (COO for T2, you for T3; without a COO every T2 comes to you).

### 4. Your weekly ten minutes

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

### 5. How it improves itself

Verification scores every ticket; you grade a blind sample weekly; agreement between the two is tracked per action type. When an action meets the graduation rule (enough samples, high agreement, a clean recent streak, no rollbacks or missed canaries) a proposal lands in your inbox; approving it moves the action one tier toward autonomy. Low agreement demotes it automatically. Once `modules.improvement.replay_min_tickets` labeled tickets exist, the weekly Improvement cycle diagnoses recurring failures and opens tickets for itself; its changes to `org/`, `protocols/` and `improvement/` are merged like any other work (verified, approved) and become a **candidate** release `rc-<n>`. If the candidate changes the judge (rubrics, the Verification charter or role), a replay gate first re-judges your labeled tickets with it and withdraws it unless agreement with your grades improves. Then `policy.release.canary_traffic` of production sessions run on the candidate for `policy.release.watch`; if their rejection rate stays within `max_regression` of the rest and nothing is demoted, it is promoted to `r<n>`, otherwise it is withdrawn, `main` is reverted and you are told. A demotion during the window still raises L4.

### 6. What is not automated in this version

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

위 명령 하나로 회사를 만들고, 내 레포를 첫 프로젝트로 등록하고, `governance/strategy.md`를 생성하고, 의존성 설치·가드 컴파일·`holdco doctor`까지 끝냅니다. 대신 해줄 수 없는 것은 끝에 출력됩니다. 엔진 접근(Claude는 Pro/Max 로그인 `claude login` 한 번, 사용량은 플랜에서 차감. Codex는 API 키. ChatGPT 로그인도 `auth: subscription`으로 되지만 OpenAI는 스크립트 용도엔 키를 권장), 알림 토큰(레포 밖 env 파일), 전략의 목표(예시 줄 교체, CEO는 여기 적힌 목표를 위해서만 티켓을 염), Codex 가격, 제공사 측 지출 상한.

`holdco doctor`가 통과해야만 돌아갑니다. 설정, 가드(두 엔진의 실제 차단·허용 호출), 이 호스트의 Codex 샌드박스, 키, 프로젝트, 전략, 카나리, 상태 DB를 확인합니다.

### 2. 돌리기

`bunx holdco supervise`. 24/7이면 systemd/launchd 아래에 둡니다. 슈퍼바이저에는 LLM이 없습니다. 매 틱마다 하트비트, 인터럽트 적용, 죽은 세션 회수, 검증된 작업 분류, 승인 경로, 인박스 시한 만료, 예약 작업(CEO 주기, COO 검토, 트립와이어, 감사 감시, 승격 제안, 개선 주기, 다이제스트, 릴리스), 그리고 예산 몫과 슬롯 안에서의 세션 배분(검증 → 경영진 → 생산 순)을 수행합니다. 세션은 `company.yaml:roles`가 역할마다 지정한 엔진과 모델로 돕니다.

### 3. 일 주기

`holdco ticket new --title … --criteria "a; b" --action code.merge.app`로 직접 열거나, `governance/strategy.md`에 목표를 적고 CEO가 열게 둡니다. 티켓은 `triaged → in_progress(시니어 + 주니어 0~N명, 각자 워크트리) → ready_for_verification → verified → 실행` 또는 `awaiting_approval → 인박스`로 흐릅니다. 내 레포로의 머지는 독립된 검증 판정 뒤에만, 그리고 행동이 승격되기 전까지는 승인(T2는 COO, T3는 운영자, COO가 없으면 T2도 운영자) 뒤에만 일어납니다.

### 4. 매주 10분

위 표와 같습니다. `status`, `inbox`(T3 결정, CEO·COO 불일치, 막힌 티켓, 실행기 없는 행동, 승격 제안, 철회된 후보. 긴급 항목은 즉시 알림, 나머지는 `inbox.batch_at`에 하루 한 번 요약. 무응답은 시한 후 자동 거절), `audit`(블라인드 채점. 이 채점이 심판을 보정하는 정답이며, 건너뛰면 승격과 개선이 동결), 다이제스트 읽기, `interrupt`/`resume`, `rollback`, `promote`, `release`. 느슨하게 하는 명령은 대화형 터미널 없이는 실행되지 않습니다.

### 5. 자기개선이 일어나는 방식

검증이 모든 티켓을 채점하고, 운영자가 매주 블라인드 샘플을 채점하고, 둘의 일치율을 행동 유형별로 추적합니다. 승격 규칙을 충족하면 인박스에 제안이 오고, 승인하면 한 단계 자율 쪽으로 이동합니다. 일치율이 낮으면 자동 강등됩니다. 라벨 붙은 티켓이 `replay_min_tickets`개 쌓이면 주간 개선 주기가 반복되는 실패를 진단해 스스로 티켓을 열고, 그 변경(`org/`, `protocols/`, `improvement/`)은 다른 작업과 똑같이 검증·승인을 거쳐 **후보** 릴리스 `rc-<n>`이 됩니다. 후보가 심판(루브릭, 검증 헌장·역할)을 바꾸면 먼저 리플레이 게이트가 운영자가 채점한 티켓을 후보로 다시 판정해 일치율이 오르지 않으면 철회합니다. 그 뒤 생산 세션의 `policy.release.canary_traffic`만 `policy.release.watch` 동안 후보 조직으로 돌고, 반려율이 나머지보다 `max_regression` 이상 나쁘지 않고 강등이 없으면 `r<n>`으로 승격, 아니면 철회하고 `main`을 되돌린 뒤 알립니다. 감시 기간 안의 강등은 여전히 L4를 겁니다.

### 6. 이 버전에서 자동화되지 않은 것

배포·게시·외부 연락·자격 증명 행동은 `company.yaml:executors`에 운영자가 실행 방법(셸 없는 argv, 플레이스홀더 `{branch} {ticket} {deliverable} {previous}`, 환경변수 허용 목록, 선택적 `undo`)을 선언했을 때만 커널이 실행합니다. 선언이 없는 행동은 "manual action" 인박스 항목으로 와서 운영자가 직접 수행하고 승인합니다. 머지를 GitHub(브랜치 보호, CODEOWNERS, CI)로 거쳐야 하는 프로젝트는 `merge: github`로 두면 커널이 PR을 열고 체크를 기다려 운영자의 `gh` 로그인으로 머지합니다. Codex 훅은 샌드박스까지 확인했고 실제 차단은 모델 세션을 돌려봐야 합니다(R8a).
