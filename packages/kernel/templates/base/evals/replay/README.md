# Replay Suite

> 🔒 Locked. Refreshed only by the Operator. / 🔒 잠금. 운영자만 갱신합니다.

## English

The replay set is the tickets the Operator has blind-graded (`holdco audit`): their frozen branches, the recorded verdict and the Operator's label, in the kernel database (`labels`, `replays`). When an Improvement candidate changes the judge (`evals/rubrics/`, the Verification charter or role file), the kernel re-judges up to `policy.audit.weekly_sample × 4` of them with the candidate's rubric and judge and compares agreement with the labels before any canary traffic (`improvement/release-process.md` §2). This folder holds **exported copies only**. While no labeled ticket has a live branch (every fresh company), the gate is skipped and noted.

```
replay/
  engineering/<ticket-id>/
    ticket.yaml        original ticket
    brief.yaml         the brief(s) that were issued
    inputs/            repo snapshot ref or input files
    accepted.yaml      the Operator-approved outcome and its label
  research/ ...
  gtm/ ...
  verification/ ...    security reviews scored with verification.md#security
```

Refresh rule: add only tickets that carry an Operator label. Keep a fixed core of 10 tickets per department that never rotates, so scores stay comparable across releases; rotate the rest monthly so improvements do not overfit to a static set.

## 한국어

리플레이 세트는 운영자가 블라인드 채점한 티켓(`holdco audit`)입니다: 고정된 브랜치, 기록된 판정, 운영자 라벨이 커널 데이터베이스(`labels`, `replays`)에 있습니다. 개선 후보가 심판(`evals/rubrics/`, 검증 헌장·역할 파일)을 바꾸면 커널이 그중 최대 `policy.audit.weekly_sample × 4`개를 후보의 루브릭·심판으로 다시 판정해 카나리 전에 라벨과의 일치율을 비교합니다(`improvement/release-process.md` §2). 이 폴더에는 내보낸 **사본만** 둡니다. 살아 있는 브랜치를 가진 라벨 티켓이 없는 동안(새 회사는 모두) 게이트는 건너뛰고 기록합니다.

갱신 규칙: 운영자 라벨이 붙은 티켓만 추가합니다. 부서당 10개는 절대 바꾸지 않는 고정 코어로 두어 릴리스 간 점수를 비교 가능하게 유지하고, 나머지는 매월 교체해 개선안이 정적인 세트에 과적합되지 않게 합니다.
