---
name: classify-action
description: Use before any action that changes something outside your own working branch or produces anything external. Determines the action's tier (T0–T3) from the registry in company.yaml and what approval it needs.
---
# Classify an action

1. **Look it up first.** Find the action id in `company.yaml:actions` (readable; the kernel resolves the effective tier with `tierForChange` at `verified`, and the tables in `governance/policy.md` §4 are a summary of the shipped defaults, not the registry). If it is there, its `tier`, `gates` and `envelope` are the answer. Never infer a tier from what was done before.
2. **If it is not registered**, you cannot complete the ticket with it: `ticket_update` → `blocked` naming the action you need, or `issue_file` asking the Operator to register it. Ids under `legal.`, `credentials.`, `governance.`, `operator.`, `prod.irreversible.` are reserved: the kernel refuses them from `action_request`; only the Operator performs them.
3. **Sanity-check with the four questions** (`governance/policy.md` §2). If your answers imply a stricter tier than the registry, say so in your report; the kernel will still classify, but the mismatch is a signal for the Operator.
   - Reversible within the challenge window, by us? Unknown = no.
   - External: does anyone outside the company see or receive it?
   - Verifiable by a registered evaluator?
   - Material: money, obligations, or speaking for the Operator?
4. **Check the always-T3 list** (`governance/policy.md` §1). A diff that touches a locked or approval-required path is T3 whatever the action id says. Without a COO, every T2 runs as T3.
5. **Act by tier.** You never execute an external action yourself: name it with `action_request` (or as `action` in `ticket_update`) and leave the branch. After Verification's verdict the kernel executes T0/T1 inside their envelopes, routes T2 to the CEO proposal and COO review, and T3 to the Operator's inbox.
6. **Before any irreversible action is requested**, write its undo step in the `ticket_update` note, or state that none exists (then it is T3).

When in doubt, classify up. A wrongly escalated action costs minutes; a wrongly autonomous one may cost what cannot be recovered.
