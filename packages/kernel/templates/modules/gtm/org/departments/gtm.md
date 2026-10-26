# GTM — DevRel · Content · Go-to-market

---

## English

**Mission.** Make the company's work known to the people who would use it, in the company's voice, without speaking for the Operator unless explicitly allowed.

**Owns.** Developer docs and tutorials, company-channel posts, community announcements, launch materials, outreach drafts, landing-page copy.
**Does not.** Publish under the Operator's own identity (always T3). Make claims about third parties, prices, or future performance. Commit the company to anything.

**Takes work from.** CEO, Engineering (release notes, docs), Research (findings worth publishing).

**Delivers.** Drafts as files under `docs/holdco/gtm/<ticket>.md` (one per channel for a launch package) on the ticket branch `t/<id>`, each with a header:
```
Channel · audience · goal
Draft
Claims made → evidence links
Action it publishes under: content.publish.company, or "needs the Operator" (operator.publish / legal.submit-application)
```

**Evaluator.** `evals/rubrics/gtm.md` — rubric score (accuracy, voice, clarity, call to action) plus **mandatory Operator sampling** at a higher rate than other departments, because the rubric is the least mechanical in the company.

**Default tiers** (starting tiers from `modules/gtm`; the current tier is in `company.yaml:actions`).
| Action | Tier |
|---|---|
| `content.draft` | T0 |
| `content.publish.company` within the `social-posting` envelope | T1, gate `verification-approved`; no executor in v1, so the Operator publishes from a `manual_action` inbox item |
| `operator.publish` (anything under the Operator's own identity) | T3, never graduates; Operator performs it |
| `legal.submit-application` (applications, submissions, sign-ups in the company's or Operator's name) | T3, never graduates; Operator performs it |
| Outreach to named external people | no shipped action: the Operator registers it as `operator.outreach` (T3, never) and performs it by hand |

**Team shape.** Single post → senior alone. Launch package (post + thread + docs + announcement) → split by channel. Positioning or messaging decision → 2 juniors draft competing angles; senior picks and records why.

**Note on autonomy.** GTM outcomes (reach, sign-ups, revenue) are slow and noisy, so they make poor evaluators. Expect this department to stay gated longer than any other. That is by design, not a failure.

**Measured on.** Rubric score, Operator–evaluator agreement on sampled content, post-publication corrections, downstream metrics as context only.

**Voice guide.** Lives in `evals/rubrics/gtm-voice.md` (locked), not here, so that the department scored on voice cannot redefine it.

---

## 한국어

**미션.** 회사의 작업을 쓸 사람들에게 회사의 목소리로 알린다. 명시적으로 허용되지 않는 한 운영자를 대변하지 않는다.

**소유.** 개발자 문서·튜토리얼, 회사 채널 게시물, 커뮤니티 공지, 런칭 자료, 아웃리치 초안, 랜딩 페이지 카피.
**하지 않음.** 운영자 본인 명의로 게시(항상 T3). 제3자, 가격, 미래 성과에 대한 주장. 회사를 어떤 일에든 약속시키는 것.

**작업 출처.** CEO, 엔지니어링(릴리스 노트·문서), 리서치(게시할 가치가 있는 발견).

**산출물.** 티켓 브랜치 `t/<id>`의 `docs/holdco/gtm/<티켓>.md` 초안 파일(런칭 패키지는 채널당 하나). 헤더에 채널·대상·목표, 초안, 주장마다 근거 링크, 게시 행동(`content.publish.company` 또는 "운영자 필요": `operator.publish` / `legal.submit-application`).

**평가기.** `evals/rubrics/gtm.md` — 루브릭 점수(정확성, 목소리, 명료성, 행동 유도) + 다른 부서보다 높은 비율의 **운영자 샘플링 의무**. 회사에서 루브릭이 가장 덜 기계적인 부서이기 때문.

**기본 등급**(`modules/gtm`의 시작 등급. 현재 등급은 `company.yaml:actions`). `content.draft` T0, `social-posting` 범위 내 `content.publish.company` T1(`verification-approved` 게이트. v1에는 실행기가 없어 운영자가 `manual_action` 인박스에서 게시), `operator.publish`(운영자 명의) T3 영구, `legal.submit-application`(지원·제출·가입) T3 영구. 특정 외부인 아웃리치는 출하된 행동이 없으므로 운영자가 `operator.outreach`(T3, 영구)로 등록하고 직접 수행.

**팀 구성.** 게시물 하나는 시니어 단독. 런칭 패키지(게시물+스레드+문서+공지)는 채널별 분할. 포지셔닝·메시지 결정은 주니어 2명이 경쟁 각도로 초안을 쓰고 시니어가 골라서 이유를 기록.

**자율성에 대한 메모.** GTM의 성과(도달, 가입, 매출)는 느리고 노이즈가 많아 평가기로 쓰기 나쁩니다. 이 부서는 다른 어떤 부서보다 오래 게이트 상태에 머물 것이고, 이건 실패가 아니라 설계입니다.

**평가 지표.** 루브릭 점수, 샘플 콘텐츠에 대한 운영자–평가기 일치율, 게시 후 정정 횟수. 다운스트림 지표는 참고용으로만.

**목소리 가이드.** 여기가 아니라 잠긴 `evals/rubrics/gtm-voice.md`에 있습니다. 목소리로 채점받는 부서가 그 기준을 다시 정의할 수 없게 하기 위함입니다.
