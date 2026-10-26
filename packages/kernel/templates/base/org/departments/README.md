# Departments

> ✏️ Improvement may propose changes to any charter in this folder. Merged only on eval gain (`improvement/release-process.md`).
> ✏️ 개선팀이 이 폴더의 헌장 수정을 제안할 수 있습니다. 평가 점수가 오를 때만 머지됩니다.

---

## English

### Departments are templates

Not every one-person company needs every department. The Operator enables departments in `company.yaml:modules.departments`; a disabled department receives no tickets and no budget (`ticket_create` refuses it). Verification and Improvement are always present. A content business may disable Engineering; a solo developer may run GTM at minimum capacity.

The names `verification`, `improvement`, `executive`, `operator`, `kernel` and `supervisor` are reserved: no module may define a department with one of them.

| Department | Role (Constitution 2.1) | Charter |
|---|---|---|
| Research | Produce | `research.md` |
| Engineering | Produce | `engineering.md` |
| GTM (DevRel · Content · Go-to-market) | Produce | `gtm.md` |
| Operations | Produce | `operations.md` |
| Verification & Security | Judge | `verification.md` |
| Improvement | Improve | `improvement.md` |

### Every charter has the same sections

1. **Mission** — one sentence
2. **Owns / Does not** — the boundary
3. **Takes work from** — who may open tickets for it
4. **Delivers** — outputs and their format
5. **Evaluator** — which rubric in `evals/rubrics/` scores its output
6. **Default tiers** — its common action types and their starting tier
7. **Team shape** — how the senior sizes junior teams for its typical tasks
8. **Measured on** — department metrics

### Shared rules for all departments

- Work arrives only as tickets (`protocols/ticket-lifecycle.md`). No self-assigned work outside the Improvement department's mandate.
- Every output is the ticket branch `t/<id>` (files under `docs/holdco/<department>/<ticket>.md` for non-code work). Nothing is "done" only in a conversation.
- The senior never submits juniors' work to Verification unreviewed, and never treats its own review as final.
- No agent session holds production secrets (D14). Deploys and publishes are executed by kernel executors or by the Operator after `action_request` and the verdict; Operations requests, verifies and reports them.
- Any department may file an issue against a locked file (`issue_file`). None may open a PR against one.

---

## 한국어

### 부서는 템플릿

모든 1인 회사가 모든 부서를 필요로 하지는 않습니다. 운영자가 `company.yaml:modules.departments`에서 부서를 켭니다. 꺼진 부서는 티켓도 예산도 받지 않습니다(`ticket_create`가 거부). 검증과 개선 부서는 항상 있습니다. 콘텐츠 사업이라면 엔지니어링을 끌 수 있고, 1인 개발자라면 GTM을 최소 용량으로 돌릴 수 있습니다.

`verification`, `improvement`, `executive`, `operator`, `kernel`, `supervisor`는 예약된 이름이라 모듈이 이 이름의 부서를 정의할 수 없습니다.

### 모든 헌장의 공통 섹션

1. **미션** — 한 문장
2. **소유 / 하지 않음** — 경계
3. **작업 출처** — 누가 이 부서에 티켓을 열 수 있는가
4. **산출물** — 출력과 형식
5. **평가기** — `evals/rubrics/`의 어떤 루브릭으로 채점하는가
6. **기본 등급** — 주요 행동 유형과 시작 등급
7. **팀 구성** — 시니어가 대표 작업에 주니어 팀을 어떻게 꾸리는가
8. **평가 지표** — 부서 지표

### 모든 부서 공통 규칙

- 일은 티켓으로만 들어옵니다(`protocols/ticket-lifecycle.md`). 개선 부서의 권한 밖에서 스스로 일을 만들지 않습니다.
- 모든 산출물은 티켓 브랜치 `t/<id>`입니다(코드가 아니면 `docs/holdco/<부서>/<티켓>.md`). 대화 안에서만 "끝난" 일은 없습니다.
- 시니어는 주니어의 작업을 검수 없이 검증 부서에 넘기지 않고, 자기 검수를 최종으로 취급하지도 않습니다.
- 어떤 세션도 프로덕션 시크릿을 갖지 않습니다(D14). 배포·게시는 `action_request`와 판정 후 커널 실행기나 운영자가 수행하고, 운영 부서는 요청·검증·보고합니다.
- 어떤 부서든 잠긴 파일에 대해 이슈(`issue_file`)는 올릴 수 있지만 PR은 열 수 없습니다.
