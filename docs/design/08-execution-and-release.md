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
- Gate `rollback-tested` means: the executor has an `undo`. Doctor fails an executor whose command's first element is not executable.
- The executor is itself an action at its registry tier: T0/T1 run after Verification; T2/T3 after approval, like merges.

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
배포·게시·외부 연락·자격 증명 행동은 `company.yaml:executors`에 운영자가 argv 배열로 선언합니다. 커널이 선언된 환경변수 이름만 넘겨 실행하고(시크릿은 커널에만, D14), 출력과 되돌리기 argv를 행동 로그에 기록해 `holdco rollback`이 되돌릴 수 있게 합니다. 플레이스홀더는 `{branch}`, `{ticket}`, `{deliverable}`, `{previous}`. 실행기가 없는 행동은 지금처럼 `manual_action` 인박스로 갑니다. `rollback-tested` 게이트는 `undo`가 있다는 뜻이고, doctor가 명령 실행 파일 존재를 확인합니다.

### 2. GitHub 기반 머지 (D51)
프로젝트별 `merge: local | github`. `github`면 브랜치를 push하고 PR을 열어(`gh pr create`, 기존 PR 재사용) `gh pr merge`로 머지합니다. 브랜치 보호와 CODEOWNERS가 그 시점에 적용되고, 거절되면 티켓은 사유와 함께 `rejected`. 체크가 녹색이 될 때까지 `merge_wait`(기본 20분) 기다리고 실패하면 반려. 되돌리기는 머지 커밋 revert 후 push.

### 3. 긴급 인박스 (D52)
인박스 항목에 `urgency`. 긴급(COO의 카나리 승인, core 프로젝트의 CEO·COO 불일치나 cannot-score나 장기 blocked, L5)은 즉시 critical 알림, 나머지는 하루 한 번 `inbox.batch_at`에 요약(`inbox-batch` 작업)과 다이제스트. 시한 초과 거절은 둘 다 적용.

### 4. 조직 변경의 카나리 배포 (D53)
개선 머지가 들어오면 `r<n>`이 아니라 `rc-<n>` 후보 태그를 만들고, 새로 배분되는 생산 세션 중 `canary_traffic` 비율만 후보 조직으로 띄웁니다(검증·경영진은 제외, `sessions.release`에 기록). `release.watch` 동안 후보 세션의 반려율이 기준선 + `max_regression`을 넘지 않고 후보에 귀속되는 강등·트립와이어가 없으면 `r<n>`으로 승격, 아니면 후보를 철회하고 `main`을 릴리스 태그로 되돌리고 운영자에게 알립니다. 에이전트는 자기가 어느 릴리스로 도는지 모릅니다. `holdco release`는 카나리를 건너뛰고 즉시 승격.

### 5. 리플레이 게이트 (D54)
리플레이 세트는 운영자가 블라인드 채점한 티켓입니다. 후보 조직의 루브릭·심판 역할로 그 티켓들의 고정된 브랜치를 다시 판정해 운영자 라벨과의 일치율을 재고, 기록된 판정의 일치율과 비교한 것이 평가 상승입니다. 후보가 `evals/rubrics/`, 검증 헌장, 검증 역할 파일을 건드릴 때만 돌고(생산자 쪽 변경은 카나리가 검사), 샘플은 최근 라벨 티켓 최대 `weekly_sample × 4`, 비용은 개선 몫. 게이트: 일치율 ≥ 기존 + `min_gain`, 행동 유형별 하락 ≤ `max_regression`. 실패하면 카나리 트래픽 전에 후보 철회.

### 6. 다루지 않는 것
대화형 마법사, npm 배포, 이 레포의 CI는 패키징(M4)이고 설계가 아닙니다. 운영자 여러 명은 첫 불변식(사람 한 명)에 따라 범위 밖.
