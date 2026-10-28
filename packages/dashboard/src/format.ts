export const usd = (n: number | null | undefined) => "$" + (Number(n) || 0).toFixed(2)
export const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.round(s / 60); if (m < 60) return `${m}m`; const h = Math.round(m / 60); if (h < 48) return `${h}h`; return `${Math.round(h / 24)}d` }
export const left = (ms: number) => { if (ms <= 0) return "expired"; const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return h > 0 ? `${h}h ${m}m` : `${m}m` }
export const clock = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
export const STATE_LABEL: Record<string, string> = { new: "New", triaged: "Triaged", in_progress: "In progress", ready_for_verification: "Verifying", verified: "Verified", awaiting_approval: "Approval", done: "Done", rejected: "Rejected", blocked: "Blocked", declined: "Declined", rolled_back: "Rolled back" }
export const KIND_LABEL: Record<string, string> = { t3: "Approval needed", t2_objection: "COO objected", coo_timeout: "COO did not answer", triage: "Triage", blocked: "Blocked ticket", graduation: "Graduation proposal", issue: "Issue from an agent", manual_action: "Run by hand", candidate_withdrawn: "Candidate withdrawn" }
export const END_STATES = new Set(["done", "declined", "rolled_back"])
