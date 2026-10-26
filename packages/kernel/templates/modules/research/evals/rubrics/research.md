# Rubric — Research

> 🔒 Locked. / 🔒 잠금.

Verification scores the report file `docs/holdco/research/<ticket>.md` on the ticket branch. Scores 0–4 per dimension (1 and 3 are intermediates). No `ci-green` or replay gate applies to research in the shipped registry; if a replay suite for research exists it is advisory only.

| Gate (mechanical) | Check |
|---|---|
| Citations resolve | Every link returns content (not 404 / paywall-only without note); Verification has `web` for this |
| Structure | Report has Question, Answer, Findings, Confidence, Open questions |

| Dimension | Weight | 4 | 2 | 0 |
|---|---|---|---|---|
| Answers the question asked | 0.30 | First paragraph directly answers it | Answer buried or partial | Answers a different question |
| Claim support | 0.30 | Every claim's source actually states it | Some claims loosely supported | Claims unsupported or misattributed |
| Recency | 0.15 | Sources current enough for the topic | Some stale sources on fast-moving facts | Outdated facts presented as current |
| Calibration | 0.15 | Confidence matches evidence; says what would change the answer | Overconfident in places | Certain where evidence is thin |
| Concision | 0.10 | Nothing the requester must skip | Some padding | Requester must dig for the answer |

Claim support is checked by sampling: the grader opens at least 3 cited claims and confirms the source says what the report says.

Approve if overall ≥ 3.0 and Claim support ≥ 3.

## 한국어 요약

티켓 브랜치의 `docs/holdco/research/<티켓>.md`를 채점(항목별 0~4, 1·3은 중간값). 기계적 게이트(모든 인용 링크가 열림, 보고서 구조 충족. 리서치에는 `ci-green`·리플레이 게이트 없음) 후 질문에 답했는가(0.30), 주장 뒷받침(0.30), 최신성(0.15), 보정(0.15, 증거만큼만 확신), 간결성(0.10)으로 채점. 주장 뒷받침은 인용된 주장 최소 3개를 열어 출처가 실제로 그렇게 말하는지 확인하는 샘플링으로 검사. 통과 기준은 종합 3.0 이상, 주장 뒷받침 3 이상.
