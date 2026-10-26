# Return Schema — Junior → Senior

> ✏️ Improvement may propose changes to this document. The enforced contract is the kernel's Effect Schema (`@holdco/kernel`, `src/protocol/return.ts`). `delegate_wait` validates every return and cross-checks it against its brief (every done criterion answered, matching `brief_id`); `holdco validate return <file> --brief <file>` checks one by hand.
> ✏️ 개선팀이 이 문서의 변경을 제안할 수 있습니다. 실제로 강제되는 계약은 커널의 Effect Schema입니다(`@holdco/kernel`의 `src/protocol/return.ts`). `delegate_wait`가 모든 반환서를 검증하고 지시서와 교차 검사하며(모든 완료 기준 응답, `brief_id` 일치), `holdco validate return <file> --brief <file>`로 직접 확인할 수 있습니다.

---

## English

A return reports what was done and, just as importantly, what the junior had to guess. The junior's final message is exactly one JSON object of this shape (the example below is YAML for readability); the kernel validates it in `delegate_wait`, cross-checks it with the brief, and hands the senior the validated form. A junior has no company tools: the return is its only channel.

### Fields

| Field | Required | Purpose |
|---|---|---|
| `brief_id` | yes | The brief this answers; must match |
| `status` | yes | `done` · `partial` · `stopped` (a stop condition fired) · `restatement` (a `restate_first` brief: the junior stops here and the senior starts a new junior with the confirmed brief) |
| `result` | yes | What was produced, and where (branch `t/<ticket>-<brief_id>`, file paths, findings) |
| `criteria` | yes | One entry `{item, state, evidence?}` per `done_criteria` item: `met` / `not_met` / `not_checked`; `met` requires evidence |
| `evidence` | yes | Test output, command output, source links. Pointers or short excerpts, not narration. |
| `assumptions` | yes | **Every decision the brief did not specify.** May be an empty array only if truly none. The most important field. |
| `deviations` | yes | Where the work departs from the brief, and why (may be empty array) |
| `open_questions` | yes | What the senior should decide (may be empty array) |
| `stop_reason` | if `status: stopped` | Which stop condition fired, with evidence |
| `cost` | no | `{turns, spend_usd}`. A junior cannot know its spend: leave it out; the kernel fills it from the session's outcome |

### Example

```yaml
brief_id: ENG-142-b2
status: done
result: branch t/ENG-142-b2, 3 files changed
criteria:
  - item: "`bun test src/routes/quote.test.ts` passes"
    state: met
    evidence: "14 passed, 0 failed"
  - item: "31st request within 60s from one IP returns 429"
    state: met
    evidence: "test 'limits per IP' added, passing"
  - item: "requests from two IPs are limited independently"
    state: met
    evidence: "test 'independent IPs' added, passing"
  - item: "No change outside allowed paths"
    state: met
    evidence: "git diff --stat: src/routes/quote.ts, src/middleware/rateLimit.ts, src/routes/quote.test.ts"
evidence:
  - "bun test output attached in log ENG-142-b2.log"
assumptions:
  - "Used client IP from X-Forwarded-For first hop; brief did not say whether we sit behind a proxy."
  - "Window is sliding, not fixed; brief said 'within 60s' which reads as sliding."
  - "Limit set to 30/min based on purpose field; not configurable yet."
deviations: []
open_questions:
  - "Should the limit be an environment variable?"
```

The first assumption above is the kind that causes production incidents if left silent. The senior must resolve each one: accept, correct, or escalate.

### Rejected on receipt

Checked by the kernel (`delegate_wait`, `return_validate`):
- A required field missing, or free-form narrative in place of structured fields
- `criteria` missing any item from the brief's `done_criteria`, or `brief_id` not matching
- `state: met` without evidence
- `status: done` while any criterion is not `met`; `status: stopped` without `stop_reason`

A return that fails is reported to the senior as the junior's failure; the junior session is over. The senior fixes the brief or names the failed criteria and starts a new junior, at most `policy.delegation.max_iterations` times.

Checked by the senior (skill `review-return`): weak evidence behind a `met`, assumptions that should have been questions, deviations without a reason.

---

## 한국어

반환서는 무엇을 했는지, 그리고 그만큼 중요하게, 주니어가 무엇을 추측해야 했는지를 보고합니다. 주니어의 마지막 메시지는 이 형태의 JSON 객체 하나입니다(예시는 YAML). 커널이 `delegate_wait`에서 검증하고 지시서와 교차 검사해 시니어에게 넘깁니다. 주니어에게는 회사 툴이 없으므로 반환서가 유일한 채널입니다.

### 필드

| 필드 | 필수 | 용도 |
|---|---|---|
| `brief_id` | 예 | 응답하는 지시서. 일치해야 함 |
| `status` | 예 | `done` · `partial` · `stopped`(중단 조건 발동) · `restatement`(되짚기: 여기서 멈추고, 시니어가 확정된 지시서로 새 주니어를 시작) |
| `result` | 예 | 무엇을 만들었고 어디 있는가 (브랜치 `t/<티켓>-<brief_id>`, 파일 경로, 발견) |
| `criteria` | 예 | `done_criteria` 항목마다 `{item, state, evidence?}`: `met` / `not_met` / `not_checked`. `met`은 증거 필수 |
| `evidence` | 예 | 테스트 출력, 명령 출력, 출처 링크. 서술이 아니라 참조나 짧은 발췌 |
| `assumptions` | 예 | **지시서가 정하지 않은 모든 결정.** 정말 없을 때만 빈 배열. 가장 중요한 필드 |
| `deviations` | 예 | 지시서에서 벗어난 부분과 이유 (빈 배열 가능) |
| `open_questions` | 예 | 시니어가 결정해야 할 것 (빈 배열 가능) |
| `stop_reason` | `status: stopped`일 때 | 어떤 중단 조건이 발동했는지, 증거 포함 |
| `cost` | 아니오 | `{turns, spend_usd}`. 주니어는 지출을 알 수 없으니 비워두면 커널이 세션 결과로 채움 |

### 예시

위 YAML 예시에서 첫 번째 가정("프록시 뒤에 있는지 지시서에 없어서 X-Forwarded-For의 첫 홉을 클라이언트 IP로 씀")이 바로 조용히 넘어가면 프로덕션 사고를 일으키는 종류입니다. 시니어는 가정 하나하나를 수용, 정정, 에스컬레이션 중 하나로 처리해야 합니다.

### 수신 시 반려 조건

커널이 검사(`delegate_wait`, `return_validate`):
- 필수 필드 누락, 구조화된 필드 대신 자유 서술
- 지시서의 `done_criteria` 중 하나라도 `criteria`에서 빠짐, `brief_id` 불일치
- 증거 없는 `state: met`
- 어떤 기준이 `met`이 아닌데 `status: done`, `stop_reason` 없는 `status: stopped`

실패한 반환서는 시니어에게 주니어의 실패로 보고되고 그 주니어 세션은 끝납니다. 시니어는 지시서를 고치거나 실패한 기준을 명시해 새 주니어를 시작합니다(최대 `policy.delegation.max_iterations`회).

시니어가 검사(스킬 `review-return`): 약한 증거의 `met`, 질문이었어야 할 가정, 이유 없는 이탈.
