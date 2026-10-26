---
name: write-brief
description: Use when a department senior delegates work to a junior. Produces a brief that passes the kernel's brief contract, with checkable done criteria and an explicit purpose.
---
# Write a brief

Read `protocols/brief.schema.md` for field definitions. This skill is the procedure.

1. **Decide the pattern first** (`protocols/delegation.md` §2): solo, split, compete, or sequential. If solo, do not write a brief; do the work.
2. **Write `done_criteria` before anything else.** Each item must name a test, a command, a schema, or an observable fact. If you cannot write one, the task is not ready to delegate.
3. **Write `purpose`** as the reason behind the goal and the trade-off that matters. Ask: what would the junior need to know to make a good call I did not foresee?
4. **List `context_refs` as pointers**: paths, issue IDs, prior return IDs. Never paste file contents.
5. **Fill `out_of_scope` and `stop_conditions`.** Think of the most likely way a junior goes wrong and fence it off.
6. **Set `budget`** proportionate to the task. Set `restate_first: true` for large tasks and every `compete` brief. A restating junior returns `status: restatement` and stops; compare it to the brief, fix the brief if needed, and start a new junior with `restate_first: false`.
7. For `compete`, write a different `approach_hint` per junior.
8. **Name it `<ticket>-b<n>`** and leave `worktree` unset: the kernel creates `t-<ticket>-<brief_id>` on branch `t/<ticket>-<brief_id>` for a `junior_worker`.
9. **Start it with `delegate_start`** (the brief as a JSON object; `brief_validate` first if unsure). The kernel validates it, including the minimum lengths (goal ≥ 10, purpose ≥ 20, each criterion ≥ 10 code points) and the cross-field rules (compete needs approach_hint, purpose must not restate goal, no vague criteria), and refuses to start a junior on a bad one; the refusal lists every violation. Fix and resubmit.

Template (JSON when sent; shown as YAML):
```yaml
ticket:
brief_id:
pattern:
goal:
purpose:
context_refs: []
constraints: []
out_of_scope: []
output: { format: , location: }
done_criteria: []
stop_conditions: []
budget: { max_turns: , max_spend_usd: }
restate_first: false
```

Improvement edits this skill. Signals it watches: your rejection rate and the assumptions juniors report against briefs written with it.
