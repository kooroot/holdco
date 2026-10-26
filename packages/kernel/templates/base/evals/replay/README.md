# Replay Suite

> 🔒 Locked. Refreshed only by the Operator. / 🔒 잠금. 운영자만 갱신합니다.

## English

Frozen historical tickets per department, used by the kernel's release job to score an Improvement merge (`replay-gain` gate) against the current release. The suite lives in the kernel database; this folder holds **exported copies only**. While the suite is empty (every fresh company), replay gates are skipped and noted in the verdict and the digest.

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

부서별로 고정된 과거 티켓이며, 커널의 릴리스 잡이 개선 머지를 현재 릴리스와 비교해 채점(`replay-gain` 게이트)하는 데 씁니다. 세트는 커널 데이터베이스에 있고 이 폴더에는 내보낸 **사본만** 둡니다. 세트가 비어 있는 동안(새 회사는 모두) 리플레이 게이트는 건너뛰고 판정서와 다이제스트에 기록합니다.

갱신 규칙: 운영자 라벨이 붙은 티켓만 추가합니다. 부서당 10개는 절대 바꾸지 않는 고정 코어로 두어 릴리스 간 점수를 비교 가능하게 유지하고, 나머지는 매월 교체해 개선안이 정적인 세트에 과적합되지 않게 합니다.
