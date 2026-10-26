# Interrupts & Rollback

> 🔒 **Locked.** Operator only. / 🔒 **잠금.** 운영자만 수정합니다.

---

## English

The Operator watches rather than approves, so the ability to stop the company must be immediate, graduated, and impossible for agents to delay (Constitution, Article 7).

### 1. Interrupt levels

Use the lowest level that contains the problem. `holdco interrupt <L> <target> --reason "<why>"` raises one; `holdco resume <L> <target>` clears it.

| Level | Name | Target | Effect | Typical trigger |
|---|---|---|---|---|
| **L1** | Pause agent | one role (`engineering-senior`, ...) | Its running session is aborted; its tickets get `interrupt_flag` and keep their state and attempts; nothing is re-dispatched until `resume` | One agent looping or misbehaving |
| **L2** | Pause department | one department | Every session of that department is aborted; its tickets are flagged as in L1 | A department producing bad output |
| **L3** | Freeze improvement | `*` | No `improvement.merge` executes and no release is tagged; the current release stays live; production continues | Behavior drifting after a release, missed audits, a canary approved |
| **L4** | Roll back release | `*` | **One-shot**: the kernel restores `org/`, `protocols/`, `improvement/` from the previous release tag, tags a new release, and clears itself. Sessions already running finish on the old tag; new ones read the new tag | A release made things worse |
| **L5** | Global halt | `*` | All sessions aborted; no dispatch; all T1 envelopes suspended; the Operator revokes credentials by hand | Security incident, runaway spend, legal risk |

### 2. Mechanics

- Interrupts are issued outside the agents' reach: `control/interrupts.json`, written only by `holdco interrupt` / `holdco resume` and the tripwires, read by the kernel **before every tool call and before every dispatch**. Agents cannot write to it; a blocked tool call tells the agent to stop.
- L1, L2, L3 and L5 are idempotent and reversible with the matching `holdco resume`. L4 is a one-shot action: it needs no resume and leaves no flag. `holdco init` tags `r0`, so L4 always has a target.
- A flagged ticket is not penalised: an interrupt never counts as an attempt.
- L5 suspends envelopes in the kernel; API keys, deploy keys, posting tokens and on-chain delegations are the Operator's to revoke and re-issue deliberately, since no session holds them.
- Every interrupt is logged with its level, reason, and time. Agents may file a post-compliance note (Article 7.2) in their session report.

```text
control/
  interrupts.json        # written only by the Operator's commands and the tripwires
```

```json
{
  "active": [
    {
      "level": "L2",
      "target": "gtm",
      "reason": "posting tone off-brand since release r12",
      "issued_at": "2026-10-23T22:40:00+09:00"
    }
  ]
}
```

`target` is a role for L1, a department for L2, and `"*"` for L3–L5. JSON rather than YAML so the kernel check needs no third-party parser.

### 3. Automatic tripwires

The kernel raises an interrupt without waiting for the Operator when a hard limit is crossed. Tripwires only ever stop things; they never resume.

| Tripwire | Level |
|---|---|
| Department spend > `company.yaml:policy.tripwires.dept_spend_spike_x`× its weekly hourly average in 1 hour | L2 on that department |
| Total spend reaches 100% of any envelope | L2 on the spending department |
| Same tool error repeated > `company.yaml:policy.tripwires.loop_threshold` times by one session | L1 on that role |
| Write attempt to a locked path | L1 + Operator alert |
| Canary approved by the COO | L3 + action demoted (policy §5) + Operator alert |
| Weekly audit missed `company.yaml:policy.audit.freeze_after_missed` times in a row | L3 |
| Demotion or tripwire attributable to a release within `company.yaml:policy.release.watch` | L4 |
| Secret pattern detected in an outgoing message or commit | L5 |

### 4. Rollback

- Every merged change to the org definition is part of a **tagged release** (`r0` at init, `r<n>` thereafter; `improvement/release-process.md`). L4 restores the previous tag and tags the restored state as a new release.
- The merge executor records the undo of every merge in the action log; `holdco rollback <action-log-id>` runs it and the ticket becomes `rolled_back`. Manual actions the Operator performed by hand are undone by hand.
- A production change with no undo step is irreversible and must be T3 (the senior says so in the `ticket_update` note).
- After any L3–L5, the CEO writes a short incident note in the next digest narrative: what happened, what was lost, what changes are proposed. Proposed changes to locked files go through `issue_file`, not PRs.

---

## 한국어

운영자는 결재하지 않고 지켜보는 역할이므로, 회사를 멈추는 능력은 즉각적이고, 단계적이고, 에이전트가 지연할 수 없어야 합니다(헌법 제7조).

### 1. 인터럽트 단계

문제를 담을 수 있는 가장 낮은 단계를 씁니다. `holdco interrupt <L> <target> --reason "<사유>"`로 걸고 `holdco resume <L> <target>`로 해제합니다.

| 단계 | 이름 | 대상 | 효과 | 대표 계기 |
|---|---|---|---|---|
| **L1** | 에이전트 정지 | 역할 하나 | 실행 중 세션 중단. 티켓에 `interrupt_flag`가 붙고 상태·시도 횟수 유지, `resume`까지 재배정 없음 | 한 에이전트가 루프를 돌거나 오작동 |
| **L2** | 부서 정지 | 부서 하나 | 그 부서의 모든 세션 중단, 티켓은 L1과 같이 플래그 | 한 부서가 나쁜 산출물을 냄 |
| **L3** | 개선 동결 | `*` | `improvement.merge` 실행과 릴리스 태그 중단, 현재 릴리스 유지, 생산은 계속 | 릴리스 후 행동 표류, 감사 누락, 카나리 승인 |
| **L4** | 릴리스 롤백 | `*` | **일회성**: 커널이 `org/`, `protocols/`, `improvement/`를 직전 릴리스 태그로 복원하고 새 릴리스를 태그한 뒤 스스로 해제. 실행 중 세션은 옛 태그로 끝내고 새 세션은 새 태그를 읽음 | 릴리스가 상황을 악화시킴 |
| **L5** | 전체 정지 | `*` | 모든 세션 중단, 디스패치 없음, 모든 T1 위임 범위 정지. 자격증명 회수는 운영자가 직접 | 보안 사고, 지출 폭주, 법적 위험 |

### 2. 동작 방식

- 인터럽트는 에이전트의 손이 닿지 않는 `control/interrupts.json`에 걸립니다. `holdco interrupt`/`resume`와 트립와이어만 쓰고, 커널이 **매 툴 호출 전과 매 디스패치 전에** 읽습니다. 에이전트는 쓸 수 없고, 차단된 툴 호출은 멈추라고 알려줍니다.
- L1·L2·L3·L5는 멱등적이며 짝이 되는 `holdco resume`으로 해제합니다. L4는 일회성이라 해제가 필요 없고 플래그를 남기지 않습니다. `holdco init`이 `r0`를 태그하므로 L4는 항상 대상이 있습니다.
- 플래그된 티켓은 불이익이 없습니다. 인터럽트는 시도 횟수에 들어가지 않습니다.
- L5는 커널 안의 위임 범위를 정지합니다. API 키, 배포 키, 게시 토큰, 온체인 위임은 어떤 세션도 갖고 있지 않으므로 운영자가 직접 회수하고 의도적으로 다시 발급합니다.
- 모든 인터럽트는 단계, 사유, 시각과 함께 기록됩니다. 에이전트는 세션 보고에 따른 뒤 의견을 남길 수 있습니다(제7조 2항).

`target`은 L1이면 역할, L2면 부서, L3~L5면 `"*"`입니다. 외부 파서 없이 돌도록 YAML이 아니라 JSON을 씁니다.

### 3. 자동 트립와이어

경성 한도를 넘으면 커널이 운영자를 기다리지 않고 인터럽트를 겁니다. 트립와이어는 멈추기만 하고 절대 재개하지 않습니다. 위 표와 같습니다: 부서 지출 급증 → L2, 위임 범위 100% 소진 → L2, 같은 툴 오류 반복 → L1, 잠긴 경로 쓰기 시도 → L1 + 경보, COO의 카나리 승인 → L3 + 강등 + 경보, 주간 감사 `policy.audit.freeze_after_missed`회 연속 누락 → L3, 릴리스 후 `policy.release.watch` 안에 그 릴리스에 기인한 강등·트립와이어 → L4, 시크릿 패턴 → L5.

### 4. 롤백

- 조직 정의에 머지된 모든 변경은 **태그 릴리스**의 일부입니다(초기화 시 `r0`, 이후 `r<n>`. `improvement/release-process.md`). L4는 직전 태그를 복원하고 복원된 상태를 새 릴리스로 태그합니다.
- 머지 실행기는 모든 머지의 되돌리기를 행동 로그에 기록합니다. `holdco rollback <action-log-id>`가 그것을 실행하고 티켓은 `rolled_back`이 됩니다. 운영자가 직접 수행한 행동은 직접 되돌립니다.
- 되돌리기 절차가 없는 프로덕션 변경은 비가역이며 T3여야 합니다(시니어가 `ticket_update` 노트에 명시).
- L3~L5 이후에는 CEO가 다음 다이제스트 서술에 짧은 사고 노트를 씁니다. 잠긴 파일 변경 제안은 PR이 아니라 `issue_file`로.
