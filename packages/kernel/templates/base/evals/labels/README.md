# Labels

> 🔒 Locked. Written only by the Operator's grading tool. / 🔒 잠금. 운영자의 채점 도구만 씁니다.

## English

Labels live in the kernel database (`.holdco/`); this folder holds **exported copies only**, one file per graded item, written by the kernel after `holdco audit done`. Labels come from two sources: weekly blind sample grading (`holdco audit grade <id> approve|reject`), and every Operator approve/reject decision in the inbox while an action type is at T2 or T3.

```yaml
ticket: GTM-31
action_type: content.publish.company
source: weekly-sample | inbox
operator_verdict: reject
operator_note: "claims a partnership that isn't announced"
evaluator_verdict: approve          # revealed after grading
agreement: false
graded_at: 2026-10-23
```

These labels are the ground truth for graduation, demotion, and the weekly agreement number.

## 한국어

라벨은 커널 데이터베이스(`.holdco/`)에 있고, 이 폴더에는 `holdco audit done` 후 커널이 내보낸 **사본만** 채점 항목당 파일 하나로 둡니다. 라벨은 두 곳에서 옵니다. 주간 블라인드 샘플 채점(`holdco audit grade <id> approve|reject`), 그리고 행동 유형이 T2나 T3에 있는 동안 인박스에서 운영자가 내린 모든 승인/거절. 이 라벨이 승격, 강등, 주간 일치율의 정답입니다.
