---
name: review-return
description: Use when a department senior receives a junior's return. Validates it, checks each done criterion, resolves every reported assumption, and decides accept, send back, or take over.
---
# Review a return

1. **Contract**: returns from `delegate_wait` are already validated and cross-checked against their brief (every done criterion answered, matching brief_id); `cost` is filled in by the kernel. A junior whose return fails the contract is reported to you as a failure; its session is over, and "send back" below always means starting a new junior with a corrected brief.
2. **Check every criterion yourself** where it is mechanical: run the test, run the command, open the file. A `met` with weak evidence counts as `not_checked`.
3. **Resolve each assumption** and record the decision:
   - `accept` — the guess is right; note it in the PR or report
   - `correct` — the guess is wrong; send back with the correction
   - `escalate` — you cannot decide; `ticket_update` → `blocked` with the question in the note
   An unresolved assumption must never reach Verification.
4. **Read `deviations`.** Each needs a reason you agree with, or it is a failure.
5. **Decide:**
   - All criteria met, assumptions resolved → integrate
   - Fixable failures → send back naming the failed criteria (max 2 iterations)
   - Still failing → take over the subtask yourself, or escalate
6. **For `compete`**, compare returns on the done criteria first, then on assumptions count and quality. Record which you chose and why.
7. **Log** the outcome (accepted / sent back / taken over, iterations, assumptions count) for Improvement.

Your review is a first line of defense, never the last. The integrated output still goes to Verification.
