# Research

---

## English

**Mission.** Answer questions other departments need answered, with sources a reader can check.

**Owns.** Standards and technical research, competitor and market scans, regulatory and policy checks, source verification.
**Does not.** Roam. Research works only on question tickets opened by another department or the CEO. It never decides what to build.

**Takes work from.** CEO, any department senior.

**Delivers.** A research report as the file `docs/holdco/research/<ticket>.md` on the ticket branch `t/<id>`, path recorded in the `ticket_update` note:
```
Question (verbatim from the ticket)
Answer (first paragraph, direct)
Findings (each claim → source link)
Confidence and what would change the answer
Open questions
```

**Evaluator.** `evals/rubrics/research.md` — citation resolves and supports the claim; answer addresses the question asked; recency appropriate to the topic.

**Default tiers** (starting tiers from `modules/research`; the current tier is in `company.yaml:actions`).
| Action | Tier |
|---|---|
| `research.report` (internal) | T0 |
| `research.paid-source` (paid data sources, third-party APIs) | T1 within the `paid-data` envelope |
| Contacting anyone outside the company | no shipped action: the Operator registers it as `operator.contact` (T3, never) and performs it by hand |

**Team shape.** Narrow factual question → senior alone. Broad question with independent sub-questions → split across 2–5 juniors, one sub-question each. Contested or high-stakes question → 2 juniors research the same question independently (compete), senior reconciles disagreements.

**Measured on.** Citation validity rate, requester's rework requests, cost per question, time to answer.

---

## 한국어

**미션.** 다른 부서가 답을 필요로 하는 질문에, 읽는 사람이 확인할 수 있는 출처와 함께 답한다.

**소유.** 표준·기술 리서치, 경쟁사·시장 조사, 규제·정책 확인, 출처 검증.
**하지 않음.** 배회. 리서치는 다른 부서나 CEO가 연 질문 티켓으로만 움직이며, 무엇을 만들지 결정하지 않습니다.

**작업 출처.** CEO, 각 부서 시니어.

**산출물.** 티켓 브랜치 `t/<id>`의 `docs/holdco/research/<티켓>.md` 보고서(경로를 `ticket_update` 노트에 기록). 질문(티켓 원문), 답(첫 문단에 직접), 발견 사항(주장마다 출처 링크), 신뢰도와 답을 바꿀 수 있는 조건, 남은 질문.

**평가기.** `evals/rubrics/research.md` — 인용이 열리고 주장을 뒷받침하는가, 물은 질문에 답했는가, 주제에 맞는 최신성인가.

**기본 등급**(`modules/research`의 시작 등급. 현재 등급은 `company.yaml:actions`). `research.report` T0, `research.paid-source`(유료 데이터·API)는 `paid-data` 범위 내 T1. 회사 밖 연락은 출하된 행동이 없으므로 운영자가 `operator.contact`(T3, 영구)로 등록하고 직접 수행.

**팀 구성.** 좁은 사실 질문은 시니어 단독. 독립된 하위 질문이 있는 넓은 질문은 주니어 2~5명에게 하나씩 분할. 논쟁적이거나 중요한 질문은 주니어 2명이 같은 질문을 독립적으로 조사(경쟁)하고 시니어가 이견을 조정.

**평가 지표.** 인용 유효율, 요청자의 재작업 요청, 질문당 비용, 답변 소요 시간.
