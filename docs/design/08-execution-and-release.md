# 08 — Execution and Release: the parts that were left open

> Five mechanisms the first design named but did not specify: external executors, GitHub-based merges, the urgent inbox path, canary rollout of organization changes, and the replay gate. Each is defined here to the level the kernel implements.
> 처음 설계에서 이름만 있고 정의되지 않았던 다섯 장치 — 외부 실행기, GitHub 기반 머지, 긴급 인박스, 조직 변경의 카나리 배포, 리플레이 게이트 — 를 커널이 구현하는 수준까지 정의합니다.

---

## English

### 1. External executors (D50)

**Problem.** Deploys, publishes, outreach and credential actions had no executor, so every one landed in the inbox as "do it by hand". That is honest but it makes Operations and GTM departments pointless.

**Design.** The Operator declares, in `company.yaml`, how each such action is executed. The kernel runs it; agents never do.

```yaml
executors:
  deploy.staging:
    command: ["./scripts/deploy.sh", "staging", "{branch}"]
    cwd: project                       # project | company
    env: [DEPLOY_TOKEN]                # names from the Operator's env file; nothing else is passed
    undo: ["./scripts/deploy.sh", "staging", "{previous}"]
    timeout: 15m
  content.publish.company:
    command: ["bun", "scripts/publish.ts", "{deliverable}"]
    cwd: project
    env: [X_API_TOKEN]
```

- `command` and `undo` are argv arrays (no shell), with placeholders `{branch}`, `{ticket}`, `{deliverable}` (the path recorded in the ticket's `ticket_update` note), `{previous}` (the executor's recorded output `previous`, when the command prints a JSON line `{"previous": …}`).
- The process runs with the listed env names only, plus `PATH`/`HOME`, from the supervisor's environment (the env file). Secrets stay in the kernel (D14).
- Output and exit code go to `action_log.outputs`; the undo argv to `action_log.undo`, so `holdco rollback` can run it.
- An action with no executor entry still becomes a `manual_action` inbox item (D46).
- Gate `rollback-tested` requires Verification evidence of an exercised recovery test in an isolated environment. Declaring `undo` is a prerequisite, never proof. Doctor checks executable availability, not recovery success. An optional `postcheck` argv runs after the external command; a failed probe preserves the action log and undo, blocks the ticket, and alerts the Operator instead of retrying an already-applied action.
- The executor is itself an action at its registry tier: T0/T1 run after Verification; T2/T3 after approval, like merges.
- Executors run off the supervisor's tick (a child process with a kill-on-timeout); the ticket stays `verified`/`awaiting_approval` until the process ends. GitHub check-waiting is likewise one poll per tick until `merge_wait` passes, never a blocking sleep.
- `{deliverable}` is the path a senior writes in the `ticket_update` note as `deliverable: <path>` (`protocols/ticket-lifecycle.md`).
- **Crash safety (D85).** Before the command starts, the kernel claims the run: it commits an `action_log` row with `status = started` and an idempotency key `<ticket>:<action>`, passed to the command and the postcheck as `HOLDCO_IDEMPOTENCY_KEY`, and the run number as `HOLDCO_ATTEMPT`. The key is the same on every retry of that action on the ticket, so a script that applied part of its work and exited non-zero can recognise the repeat (and `HOLDCO_ATTEMPT` tells it that it is one). The claim is refused while a run of the same action on the same ticket is `started` or `unknown`, or when the ticket's state has changed since the supervisor read it; a ticket with a running command is not re-classified or re-routed. The result settles that row once (`done`); a late result for a row already settled changes nothing. A row still `started` when the supervisor boots, a command killed by its timeout or a signal, or a kernel error while it ran is an **unknown outcome**: the row becomes `unknown`, the ticket is blocked with a note starting `outcome unknown:`, and the Operator gets an urgent `recovery` item and a critical alert. The kernel never re-runs it on its own: approve = you checked it took effect (done); reject = declined, nothing is run again (open a new ticket to run it again). Moving a ticket out of `blocked` supersedes its open `blocked` inbox item, and expiry handles each inbox item on its own, so a stale item can no longer abort a tick. While the recovery item is open, the store refuses any other transition out of `blocked` (an unblock or a triage by the CEO, the CLI or the dashboard), and if a ticket ever reaches execution again the claim is refused and it is blocked again: to run the action again, open a new ticket. The CLI (`holdco inbox approve|reject`), the dashboard and Telegram all settle the item. A spawn error or a non-zero exit is still a known failure (rejected, retried within `max_attempts`).

### Known approximations

- Canary attribution is by time: any demotion while a candidate is under watch withdraws it, whether or not a candidate session caused it. Safe side; may withdraw a good candidate.
- The canary comparison is a raw rejection-rate difference over the watch window. Since D86 it is used only above a sample floor (`min_sessions`, `min_verdicts`; §4); above the floor it is still a raw difference, not a significance test. When `canary_traffic` is 1 the baseline has no production sessions in the window and its rate counts as 0, the strictest comparison.
- Two different things stop a duplicate under D85. The kernel's own guard is the durable claim: a run is claimed in the same write-locked transaction that checks for a `started` or `unknown` run of the action on the ticket, so the kernel never launches it twice. The idempotency key is for the target: the key is stable per (ticket, action), so it deduplicates at the target across the kernel's retries of a known failure (and a script's own retries inside a run), while `HOLDCO_ATTEMPT` says which run this is. Whether an interrupted command left its target consistent is the script's business and the Operator's call (the recovery item).
- A timeout kills the command's whole process group and settles the result within a short grace period even if a stray descendant holds the output pipes; once the deadline has passed the run is an unknown outcome whatever exit code arrives later. What the command printed before it was lost is kept on the `unknown` row (the tail of stdout and stderr), and when the executor declares a `postcheck` it is run once (at most 2 minutes) and its answer is stored on the row and summarised on the recovery item; the status stays unknown, since a probe is evidence, not proof. The captured output is checkpointed on the row (still `started`) before the postcheck runs, so a crash during the probe still leaves the evidence for boot recovery; only a crash while the command itself runs leaves just the reason.
- **Graceful stop.** `stop()` no longer abandons a running executor: it waits up to `runtime.executor_stop_grace` (default 30s), starts no new executor meanwhile, and only then kills the process groups, which become unknown outcomes (no postcheck is run at shutdown). The generated systemd unit sets `KillMode=mixed` (SIGTERM goes to the supervisor only, so the executors are not cut off before the grace) and `TimeoutStopSec` = grace + 60s; the launchd plist sets `ExitTimeOut` the same way. The abort also covers the postcheck, and a run's abort listener is removed when it ends.
- Promotion tags the company repository's `HEAD`, as before D86. An Improvement merge that lands while a candidate waits (now possibly longer: the extension and the Operator's answer) is part of what gets promoted; tagging the exact candidate commit is an open item.
- Canary verdicts are attributed by ticket: a ticket with sessions on both releases counts on both sides.
- The merge executor (local and GitHub) is not yet behind the D85 write-ahead row; a crash mid-merge is recovered by git state (a merge is close to idempotent), not by the action log.
- Replay sessions bypass the budget gate (they are few and capped per session); their cost is charged to Improvement's share after the fact.

### 2. GitHub-based merges (D51)

**Problem.** The v1 merge executor merges locally and pushes `main`. Teams that gate merges on GitHub branch protection, CODEOWNERS and CI never see a pull request.

**Design.** Per project, `merge: local | github`.

- `github`: the executor pushes the ticket branch, opens a PR (`gh pr create`, idempotent on an existing PR), and merges it with `gh pr merge --merge` using the Operator's `gh` login (an org-scoped token in the env file). Branch protection and CODEOWNERS apply at that moment, which is the L-h layer in `05-security.md` doing its job; a refused merge becomes a `rejected` ticket with GitHub's reason.
- `ci-green`: with `github`, Verification can cite `gh pr checks`; the kernel additionally waits for checks to be green before merging (`merge_wait`, default 20m) and rejects on failure.
- Undo: `gh pr revert`-equivalent is a revert commit of the merge on the default branch, pushed.
- `local` (default) stays as today for repositories without a remote.

### 3. Urgent inbox path (D52)

**Problem.** `approvals.md` promised "urgent items: immediately"; the kernel only timed items out.

**Design.** Inbox items carry `urgency: routine | urgent`. Urgent items alert the Operator the moment they are filed (critical severity); routine items are summarized once a day at `policy.inbox.batch_at` (the `inbox-batch` job) and in the digest. Urgent by construction: a COO canary approval, a CEO–COO objection on a `core` project, `cannot-score` on a `core` project, a blocked ticket older than `blocked_after` on a `core` project, any L5. Everything else is routine. The timeout-to-reject rule applies to both.

### 4. Canary rollout of organization changes (D53)

**Problem.** An Improvement merge changed `main` and the next release switched every session to it at once; the only safety net was L4 after the fact.

**Design.** Releases have two steps.

1. **Candidate.** When Improvement's merge lands, the kernel tags `rc-<n>` instead of `r<n>`. For `policy.release.canary_traffic` of newly dispatched *production* sessions (not Verification, not executives), the kernel builds the session's organization from `rc-<n>`; the rest keep the current release. `sessions.release` records which one each session ran on.
2. **Promotion.** After `policy.release.watch`, the candidate is promoted to `r<n>` if, over the window, its sessions are not worse than the baseline: rejection rate on candidate sessions ≤ baseline + `max_regression`, and no demotion or tripwire attributable to a candidate session. Otherwise the candidate is withdrawn (`releases.status = withdrawn`), `main` is reverted to the release tag, and the Operator is told. A demotion during the window still raises L4 as before (D26), which now also withdraws the candidate.

3. **Sample floor (D86).** The rate comparison counts only with enough evidence: at least `policy.release.min_sessions` finished production sessions on the candidate (default 3; replay-gate sessions do not count) and `min_verdicts` verdicts on their tickets (default 2). The defaults are deliberately low: below the floor the Operator is asked anyway, so the floor only has to stop a promotion on almost no evidence, and a company with little traffic should not be asked about every candidate. Below the floor at the end of the watch, the candidate is neither promoted nor withdrawn on its rate: the watch is extended once by `watch`; if the sample is still short at the end of the extension, the Operator gets a `canary_sample` inbox item (approve = promote as it is; reject = withdraw). If nobody answers by `policy.inbox.timeout`, `policy.release.on_sample_timeout` decides: `withdraw` (default: shipping an unjudged change is the riskier mistake, and the item says what happens), `promote` (for a single-operator company that would rather ship than silently lose improvements to an unanswered question), or `hold` (keep the candidate on canary traffic and ask again; if the sample reaches the floor meanwhile, the rates decide). The weekly digest reports how often the floor bit (extensions, questions, and how they ended) so the floor and the timeout policy can be tuned from data. A demotion during the window withdraws at any time, floor or not. Once the question is asked, the Operator's answer governs even if the sample later reaches the floor; a candidate settled another way (a demotion, a manual release) closes the question.

Sessions never see which release they run; the choice is the kernel's. `holdco release` (manual) promotes immediately when the Operator wants to skip the canary.

### 5. Replay gate (D54)

**Problem.** D20 said Improvement stays dormant until enough labeled tickets exist, and the release process promised a replay; nothing ran one.

**Design.** The replay set is the labeled tickets (the Operator's blind grades, D48). Replay re-judges them: for each labeled ticket whose branch head still exists, a Verification session is run with the *candidate* organization (its rubrics and the judge's role file) against the frozen branch, and the new verdict is compared to the Operator's label. Agreement under the candidate vs agreement of the recorded verdicts is the eval gain.

- Runs when a candidate touches `evals/rubrics/`, `org/departments/verification.md` or `org/roles/verification-senior.md` (judge-side changes); producer-side changes are tested by the canary instead.
- Sample: up to `policy.audit.weekly_sample × 4` most recent labeled tickets, cost charged to the Improvement share.
- Gate: candidate agreement ≥ recorded agreement + `min_gain`, and no single action type's agreement drops by more than `max_regression`; a failed gate withdraws the candidate before any canary traffic.
- The replay never writes to the frozen tickets; results go to `replays`.

### 6. What this does not cover

Interactive wizard, npm publishing, CI for the repository itself: packaging, not design (M4). Multi-Operator companies: out of scope by the first invariant (one human).

---

## 한국어

### 1. 외부 실행기 (D50)
배포·게시·외부 연락·자격 증명 행동은 `company.yaml:executors`에 운영자가 argv 배열로 선언합니다. 커널이 선언된 환경변수 이름만 넘겨 실행하고(시크릿은 커널에만, D14), 출력과 되돌리기 argv를 행동 로그에 기록해 `holdco rollback`이 되돌릴 수 있게 합니다. 플레이스홀더는 `{branch}`, `{ticket}`, `{deliverable}`, `{previous}`. 실행기가 없는 행동은 지금처럼 `manual_action` 인박스로 갑니다. 명령 실행 전에 커널이 `status = started`와 멱등 키(`HOLDCO_IDEMPOTENCY_KEY`로 명령에도 전달)를 가진 행동 로그 행을 먼저 커밋하고(D85), 부팅 때 아직 `started`인 행이나 시한 초과·시그널로 죽은 명령은 **결과 불명**으로 처리합니다: 티켓은 blocked, 운영자에게 긴급 `recovery` 항목과 critical 알림이 가고, 커널은 절대 스스로 다시 실행하지 않습니다(승인 = 반영 확인, 완료; 거절 = 거절, 재실행 없음). 그 티켓의 같은 행동이 `started`나 `unknown`이면 실행 확보가 거부되므로, 다시 하려면 새 티켓을 엽니다. 멱등 키는 (티켓, 행동)마다 고정이라 커널의 재시도에도 같은 값이고(실행 회차는 `HOLDCO_ATTEMPT`), 일부만 적용하고 0이 아닌 코드로 끝난 스크립트가 대상 쪽에서 반복을 알아볼 수 있습니다. 시한 초과는 명령의 프로세스 그룹 전체를 종료하고, 그 전까지의 출력(stdout/stderr 끝부분)은 `unknown` 행에 남으며, `postcheck`가 선언돼 있으면 한 번(최대 2분) 실행해 결과를 행과 복구 항목에 붙입니다(상태는 불명 그대로: 확인 결과는 증거이지 증명이 아님). 정상 종료(`stop()`)는 실행 중인 실행기를 `runtime.executor_stop_grace`(기본 30초)까지 기다리고 그동안 새 실행기를 시작하지 않으며, 그 뒤에야 프로세스 그룹을 죽여 결과 불명으로 만듭니다(서비스 매니저의 정지 제한시간이 그보다 길어야 함). `blocked`에서 나가는 티켓의 열린 `blocked` 인박스 항목은 대체되고, 만료는 항목별로 처리됩니다. `rollback-tested`는 격리된 환경에서 복구를 실행한 검증 증거를 요구합니다. `undo` 선언은 전제조건이며 복구 성공 증거가 아닙니다. `postcheck` 명령을 설정하면 외부 작업 후 실제 상태를 검사하고, 실패 시 되돌리기 정보와 로그를 보존한 채 작업을 차단해 운영자에게 알립니다.

### 2. GitHub 기반 머지 (D51)
프로젝트별 `merge: local | github`. `github`면 브랜치를 push하고 PR을 열어(`gh pr create`, 기존 PR 재사용) `gh pr merge`로 머지합니다. 브랜치 보호와 CODEOWNERS가 그 시점에 적용되고, 거절되면 티켓은 사유와 함께 `rejected`. 체크가 녹색이 될 때까지 `merge_wait`(기본 20분) 기다리고 실패하면 반려. 되돌리기는 머지 커밋 revert 후 push.

### 3. 긴급 인박스 (D52)
인박스 항목에 `urgency`. 긴급(COO의 카나리 승인, core 프로젝트의 CEO·COO 불일치나 cannot-score나 장기 blocked, L5)은 즉시 critical 알림, 나머지는 하루 한 번 `inbox.batch_at`에 요약(`inbox-batch` 작업)과 다이제스트. 시한 초과 거절은 둘 다 적용.

### 4. 조직 변경의 카나리 배포 (D53)
개선 머지가 들어오면 `r<n>`이 아니라 `rc-<n>` 후보 태그를 만들고, 새로 배분되는 생산 세션 중 `canary_traffic` 비율만 후보 조직으로 띄웁니다(검증·경영진은 제외, `sessions.release`에 기록). `release.watch` 동안 후보 세션의 반려율이 기준선 + `max_regression`을 넘지 않고 후보에 귀속되는 강등·트립와이어가 없으면 `r<n>`으로 승격, 아니면 후보를 철회하고 `main`을 릴리스 태그로 되돌리고 운영자에게 알립니다. 에이전트는 자기가 어느 릴리스로 도는지 모릅니다. `holdco release`는 카나리를 건너뛰고 즉시 승격. 반려율 비교는 표본이 충분할 때만 씁니다(D86): 후보 세션 `min_sessions`개(기본 3), 그 티켓의 판정 `min_verdicts`개(기본 2). 기본값을 낮게 둔 이유: 미달이면 어차피 운영자에게 묻기 때문에 플로어는 근거가 거의 없는 승격만 막으면 되고, 트래픽이 적은 회사가 후보마다 질문을 받으면 안 됩니다. 감시가 끝났을 때 미달이면 승격하지 않고 감시를 한 번 연장하고, 그래도 부족하면 운영자에게 `canary_sample` 항목(승인 = 승격, 거절 = 철회). `inbox.timeout`까지 무응답이면 `policy.release.on_sample_timeout`이 결정합니다: `withdraw`(기본: 판정되지 않은 변경을 내보내는 쪽이 더 위험), `promote`(무응답 질문 때문에 개선이 조용히 사라지느니 내보내겠다는 1인 회사용), `hold`(후보를 카나리 트래픽에 유지하고 다시 물음; 그사이 표본이 플로어를 채우면 반려율이 결정). 주간 다이제스트가 플로어가 걸린 횟수(연장, 질문, 결말)를 보고해 데이터로 조정할 수 있습니다. 강등은 언제든 즉시 철회.

### 5. 리플레이 게이트 (D54)
리플레이 세트는 운영자가 블라인드 채점한 티켓입니다. 후보 조직의 루브릭·심판 역할로 그 티켓들의 고정된 브랜치를 다시 판정해 운영자 라벨과의 일치율을 재고, 기록된 판정의 일치율과 비교한 것이 평가 상승입니다. 후보가 `evals/rubrics/`, 검증 헌장, 검증 역할 파일을 건드릴 때만 돌고(생산자 쪽 변경은 카나리가 검사), 샘플은 최근 라벨 티켓 최대 `weekly_sample × 4`, 비용은 개선 몫. 게이트: 일치율 ≥ 기존 + `min_gain`, 행동 유형별 하락 ≤ `max_regression`. 실패하면 카나리 트래픽 전에 후보 철회.

### 6. 다루지 않는 것
대화형 마법사, npm 배포, 이 레포의 CI는 패키징(M4)이고 설계가 아닙니다. 운영자 여러 명은 첫 불변식(사람 한 명)에 따라 범위 밖.
