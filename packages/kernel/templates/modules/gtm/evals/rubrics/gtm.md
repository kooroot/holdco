# Rubric — GTM

> 🔒 Locked. / 🔒 잠금.

GTM is the least mechanical rubric in the company. It therefore carries a higher Operator sampling rate (`company.yaml:policy.audit.gtm_multiplier`, default 2× other departments).
GTM은 회사에서 가장 덜 기계적인 루브릭이라 운영자 샘플링 비율이 더 높습니다(기본 다른 부서의 2배).

## #post — company-channel content

Verification scores the draft file on the ticket branch (`docs/holdco/gtm/<ticket>.md`) before anything is published. Scores 0–4 per dimension (1 and 3 are intermediates).

| Gate (mechanical, checked by Verification) | Check |
|---|---|
| Forbidden claims | No mentions of prices, returns, or future performance; no claims about named third parties (pattern + LLM check) |
| Links | All links resolve (Verification has `web`) |
| Header | Channel, audience, goal and the publishing action are stated in the file header |

| Checked by the kernel at execution, not by Verification | Check |
|---|---|
| Envelope | Within the `social-posting` quota for the period (`content.publish.company`); over quota → T2 |
| Identity | The action is `content.publish.company` (company account); anything under the Operator's identity is `operator.publish`, T3, performed by the Operator |

| Dimension | Weight | 4 | 2 | 0 |
|---|---|---|---|---|
| Accuracy | 0.35 | Every factual claim has evidence linked in the draft | Minor unsupported detail | False or misleading claim |
| Voice | 0.25 | Matches `evals/rubrics/gtm-voice.md`; reads like the company | Generic | Off-brand, hype, or tone the Operator would retract |
| Clarity | 0.20 | One idea, understood on first read | Needs a second read | Confusing |
| Audience fit | 0.10 | Written for the stated audience | Partly | Wrong audience |
| Call to action | 0.10 | One clear next step | Vague | None or several competing |

Approve if overall ≥ 3.2 and Accuracy = 4. While `evals/rubrics/gtm-voice.md` still holds its placeholders, the Voice dimension cannot be scored: return `cannot-score` naming it.

## 한국어 요약

검증은 게시 전에 티켓 브랜치의 초안 파일(`docs/holdco/gtm/<티켓>.md`)을 채점합니다. 검증의 기계적 게이트(금지 주장 없음, 링크 동작, 헤더에 채널·대상·목표·게시 행동 명시) 후 정확성(0.35), 목소리(0.25), 명료성(0.20), 대상 적합성(0.10), 행동 유도(0.10)로 채점. 위임 범위 할당량과 회사 계정 여부는 검증이 아니라 커널이 실행 시점에 확인합니다. 통과 기준은 종합 3.2 이상이면서 **정확성은 반드시 만점**. `gtm-voice.md`에 플레이스홀더가 남아 있으면 목소리 항목을 채점할 수 없으므로 `cannot-score`.
