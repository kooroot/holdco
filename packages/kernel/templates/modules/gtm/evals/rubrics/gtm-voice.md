# GTM Voice Guide

> 🔒 Locked. Filled in by the Operator before GTM is enabled. Used by `gtm.md#post` (Voice dimension).
> **Operator: fill before enabling gtm; Verification returns `cannot-score` on every GTM ticket while `<tone>` or `<languages>` remains below.** `holdco doctor` warns while they do.
> 🔒 잠금. GTM을 켜기 전에 운영자가 채웁니다. `gtm.md#post`의 목소리 항목이 사용합니다. **운영자: gtm을 켜기 전에 채우세요. 아래 `<tone>`·`<languages>`가 남아 있는 동안 검증은 모든 GTM 티켓에 `cannot-score`를 냅니다.**

```yaml
voice:
  tone: <tone>                 # e.g. plain, technical, dry humor allowed
  languages: <languages>       # e.g. en primary, ko for community channels
  never:                        # automatic Voice = 0
    - hype words ("revolutionary", "game-changing", "to the moon")
    - price talk or promises of returns
    - speaking as the Operator in first person
  examples_good: []             # links to past posts the Operator liked
  examples_bad: []              # links to posts the Operator would retract
```

## 한국어

톤, 언어, 절대 쓰지 않을 표현(해당하면 목소리 항목 자동 0점), 운영자가 좋아한 게시물 예시와 철회할 게시물 예시를 채웁니다. 예시가 많을수록 채점자가 운영자의 감각에 가까워집니다.
