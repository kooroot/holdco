# Brief Schema — Senior → Junior

> ✏️ Improvement may propose changes to this document. The enforced contract is the kernel's Effect Schema (`@holdco/kernel`, `src/protocol/brief.ts`; JSON Schema in `schema/brief.schema.json`). `delegate_start` validates every brief; `holdco validate brief <file>` checks one by hand.
> ✏️ 개선팀이 이 문서의 변경을 제안할 수 있습니다. 실제로 강제되는 계약은 커널의 Effect Schema입니다(`@holdco/kernel`의 `src/protocol/brief.ts`, JSON Schema는 `schema/brief.schema.json`). `delegate_start`가 모든 지시서를 검증하고, `holdco validate brief <file>`로 직접 확인할 수 있습니다.

---

## English

A brief is a contract. A junior should be able to complete the task using only the brief and the files it references, without asking anything. The senior passes it to `delegate_start` as a JSON object (the examples below are YAML for readability; the shape is identical). The junior runs as its own kernel session and answers with a Return, also JSON.

### Fields

| Field | Required | Purpose |
|---|---|---|
| `ticket` | yes | Ticket ID this brief belongs to; must equal the senior session's own ticket |
| `brief_id` | yes | Unique ID, convention `<ticket>-b<n>` (`ENG-142-b2`); the return and the junior's worktree reference it |
| `pattern` | yes | `solo` · `split` · `compete` · `sequential` |
| `goal` | yes | What to produce, in one or two sentences. Kernel: ≥ 10 code points |
| `purpose` | yes | **Why** it is needed. Lets the junior make good calls in situations the brief did not foresee. The most commonly omitted field. Kernel: ≥ 20 code points and not equal to `goal` |
| `context_refs` | yes | Pointers, not copies: file paths, ticket ids, prior brief ids. At least one; each item ≤ 300 code points |
| `constraints` | yes | Rules the output must respect (may be empty array, never omitted) |
| `out_of_scope` | yes | What the junior must not do or touch (may be empty array) |
| `output` | yes | `{format, location}` of the deliverable; location is the junior's branch for file-writing work |
| `done_criteria` | yes | Checkable conditions. Each must be verifiable by a test, a command, a schema, or an explicit observable fact. Kernel: at least one, each ≥ 10 code points, none of the vague words |
| `stop_conditions` | yes | Situations in which the junior stops and returns instead of continuing (may be empty array) |
| `budget` | yes | `{max_turns ≥ 1, max_spend_usd > 0}`; `delegate_start` also caps `max_turns` at `policy.delegation.max_iterations × 40` |
| `worktree` | no — leave unset | The kernel creates the junior's worktree `t-<ticket>-<brief_id>` on branch `t/<ticket>-<brief_id>` for a `junior_worker` and none for a `junior_reader`; naming one yourself is ignored |
| `restate_first` | no | `true` if the junior must return a restatement first and stop (delegation §5) |
| `approach_hint` | for `compete` | The angle this junior should take, different per competitor |

### Example

```yaml
ticket: ENG-142
brief_id: ENG-142-b2
pattern: split
goal: Add rate limiting to the public /quote endpoint.
purpose: >
  The endpoint is unauthenticated and was hit 40k times in an hour yesterday,
  exhausting the upstream API budget. We need to protect spend, not punish users;
  legitimate clients make fewer than 30 requests per minute.
context_refs:
  - src/routes/quote.ts
  - src/middleware/
  - issue: OPS-88 (incident log)
constraints:
  - Use the existing Redis client in src/lib/redis.ts
  - No new dependencies
out_of_scope:
  - Other endpoints
  - Authentication changes
output:
  format: code change + tests committed on the junior's branch
  location: branch t/ENG-142-b2 (worktree t-ENG-142-b2, created by the kernel)
done_criteria:
  - "`bun test src/routes/quote.test.ts` passes"
  - "New test: 31st request within 60s from one IP returns 429"
  - "New test: requests from two IPs are limited independently"
  - "No change outside src/routes/quote.ts, src/middleware/, and their tests"
stop_conditions:
  - Redis client does not support the needed atomic operation
  - Existing tests fail before any change is made
budget:
  max_turns: 30
  max_spend_usd: 2
restate_first: false
```

### Rejected before spawning

Checked by the kernel (`delegate_start` and `brief_validate` list every violation):
- A required field missing, or a length below the minimums above
- `done_criteria` empty, or an item that is only a vague phrase ("clean", "robust", "high quality", "make it better")
- `purpose` equal to `goal` after normalisation
- `pattern: compete` without an `approach_hint`
- `ticket` not equal to the senior's own ticket; more juniors than `modules.juniors.max_per_task`

Checked by the senior (the kernel cannot):
- `purpose` that paraphrases `goal` instead of explaining why it matters
- `context_refs` items that are pasted contents rather than pointers (the kernel only caps them at 300 code points)
- Distinct `approach_hint` per competitor in a `compete` pair
- `done_criteria` that pass the vague-word check but are still not mechanically checkable

---

## 한국어

지시서는 계약입니다. 주니어는 지시서와 지시서가 참조하는 파일만으로, 아무것도 묻지 않고 작업을 끝낼 수 있어야 합니다. 시니어는 지시서를 JSON 객체로 `delegate_start`에 넘기고(아래 예시는 읽기 편하게 YAML), 주니어는 별도 커널 세션으로 실행되어 반환서(JSON)로 답합니다.

### 필드

| 필드 | 필수 | 용도 |
|---|---|---|
| `ticket` | 예 | 이 지시서가 속한 티켓 ID. 시니어 세션의 티켓과 같아야 함 |
| `brief_id` | 예 | 고유 ID, 규약 `<티켓>-b<n>` (`ENG-142-b2`). 반환서와 주니어 워크트리가 참조 |
| `pattern` | 예 | `solo` · `split` · `compete` · `sequential` |
| `goal` | 예 | 무엇을 만들어야 하는가, 한두 문장. 커널: 10자 이상 |
| `purpose` | 예 | **왜** 필요한가. 가장 자주 빠지는 필드. 커널: 20자 이상, `goal`과 같으면 안 됨 |
| `context_refs` | 예 | 복사본이 아닌 참조: 파일 경로, 티켓 ID, 이전 지시서 ID. 최소 1개, 항목당 300자 이하 |
| `constraints` | 예 | 산출물이 지켜야 할 규칙 (빈 배열 가능, 생략 불가) |
| `out_of_scope` | 예 | 주니어가 하거나 건드리면 안 되는 것 (빈 배열 가능) |
| `output` | 예 | `{format, location}`. 파일을 쓰는 작업이면 location은 주니어 브랜치 |
| `done_criteria` | 예 | 확인 가능한 조건. 커널: 최소 1개, 항목당 10자 이상, 모호한 표현 금지 |
| `stop_conditions` | 예 | 멈춰서 반환해야 하는 상황 (빈 배열 가능) |
| `budget` | 예 | `{max_turns ≥ 1, max_spend_usd > 0}`. `max_turns`는 `policy.delegation.max_iterations × 40` 이하 |
| `worktree` | 아니오 — 비워둠 | 커널이 `junior_worker`용 워크트리 `t-<티켓>-<brief_id>`(브랜치 `t/<티켓>-<brief_id>`)를 직접 만듦. `junior_reader`는 워크트리 없음 |
| `restate_first` | 아니오 | 되짚기만 반환하고 멈춰야 하면 `true` (위임 §5) |
| `approach_hint` | `compete`일 때 | 이 주니어가 택할 각도. 경쟁자마다 달라야 함 |

### 예시

위 YAML 예시를 참고하세요. `purpose`가 "무엇을"이 아니라 "왜, 그리고 무엇을 지켜야 하는가"를 담고 있어 주니어가 한도 값을 스스로 정할 수 있습니다. `worktree`는 적지 않습니다.

### 스폰 전 반려 조건

커널이 검사(`delegate_start`·`brief_validate`가 위반을 전부 나열):
- 필수 필드 누락, 위 최소 길이 미달
- `done_criteria`가 비었거나 모호한 표현만 있는 항목("깔끔하게", "고품질", "더 좋게")
- 정규화 후 `purpose`가 `goal`과 동일
- `pattern: compete`인데 `approach_hint` 없음
- `ticket`이 시니어 티켓과 다름, `modules.juniors.max_per_task` 초과

시니어가 검사(커널은 못 함):
- `goal`을 바꿔 쓴 수준의 `purpose`
- 참조 대신 내용을 붙여넣은 `context_refs`(커널은 300자 상한만 봄)
- 경쟁자별로 실제로 다른 `approach_hint`
- 단어 검사는 통과했지만 기계적으로 확인할 수 없는 완료 기준
