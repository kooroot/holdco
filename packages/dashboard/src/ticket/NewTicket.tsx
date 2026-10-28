/** Open a ticket (from templates) or edit one. Starts triaged: the Operator's tickets skip the CEO. */
import { useEffect, useMemo, useState } from "react"
import { useAct, useSnapshot, useTicket, toast } from "../hooks.ts"
import { useOpenTicket } from "../nav.ts"
import { cn, Button, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

const TEMPLATES: Array<[string, { department: string; action: string; why: string; criteria: string }]> = [
  ["Feature", { department: "engineering", action: "code.merge.app", why: "product objective", criteria: "the feature works end to end\ntests cover it\ndocs mention it" }],
  ["Bug fix", { department: "engineering", action: "code.merge.app", why: "a user-facing defect", criteria: "a failing test reproduces it, then passes\nno other behaviour changes" }],
  ["Research", { department: "research", action: "research.report", why: "a decision needs evidence", criteria: "a report under docs/holdco/research/ with a decision table\nevery claim cites a source" }],
  ["Content", { department: "gtm", action: "content.draft", why: "launch communication", criteria: "a draft under docs/holdco/gtm/ in the voice guide\none clear call to action" }],
  ["Branch only", { department: "engineering", action: "code.branch", why: "exploration", criteria: "the branch exists with the change\nnothing merged" }],
]

export const NewTicket = ({ onClose }: { onClose: () => void }) => {
  useLang()
  const snap = useSnapshot()
  const S = snap.data
  const act = useAct()
  const openTicket = useOpenTicket()
  const editId = useMemo(() => { const id = sessionStorage.getItem("holdco.edit"); sessionStorage.removeItem("holdco.edit"); return id }, [])
  const existing = useTicket(editId)
  const depts = useMemo(() => [...(S?.departments ?? []), ...(S?.org.improvement ? ["improvement"] : [])], [S])
  const [f, setF] = useState({ department: "", project: "", action: "", priority: "3", title: "", goal: "", why: "", criteria: "" })
  useEffect(() => { if (S && !f.department) setF((x) => ({ ...x, department: depts[0] ?? "", project: S.projects[0]?.id ?? "" })) }, [S, depts, f.department])
  useEffect(() => { const t = existing.data?.ticket; if (t) setF({ department: t.department, project: t.project ?? "", action: t.action ?? "", priority: String(t.priority), title: t.title, goal: t.goal, why: t.why, criteria: t.done_criteria.join("\n") }) }, [existing.data])
  const actions = S?.settings.actions.filter((a) => a.department === f.department) ?? []
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }))
  const save = async () => {
    if (!f.title.trim()) return toast(t("A title is needed"), true)
    const body = { department: f.department, title: f.title, goal: f.goal, why: f.why, criteria: f.criteria.split("\n"), project: f.project || null, action: f.action || null, priority: Number(f.priority) }
    const r = await act(editId ? { kind: "ticket_edit", id: editId, ...body } : { kind: "ticket_create", ...body }, (r) => (editId ? t("Saved") : t("{id} opened — the senior picks it up on the next tick", { id: String(r["id"]) })))
    if (r) { onClose(); if (editId) openTicket(editId) }
  }
  return (
    <div {...ui.modalScrim()} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div {...ui.modalBox()}>
        <div {...ui.row()}><h3 {...ui.h3()}>{editId ? t("Edit {id}", { id: editId }) : t("New ticket")}</h3><span {...cn(ui.small(), ui.muted())}>{t(editId ? "The next session re-reads goal and criteria." : "Opened by you; starts triaged, skipping the CEO.")}</span></div>
        {!editId ? <div {...ui.row()}>{TEMPLATES.filter(([, v]) => depts.includes(v.department)).map(([n, v]) => <Button key={n} sm onClick={() => setF((x) => ({ ...x, department: v.department, action: S?.settings.actions.some((a) => a.id === v.action) ? v.action : "", why: v.why, criteria: v.criteria }))}>{t(n)}</Button>)}</div> : null}
        <div {...ui.field()}><label {...ui.label()}>{t("Title")}</label><input autoFocus {...ui.input()} value={f.title} onChange={set("title")} placeholder={t("What should be true when this is done, in one line")} /></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div {...ui.field()}><label {...ui.label()}>{t("Department")}</label><select {...ui.input()} value={f.department} onChange={(e) => setF((x) => ({ ...x, department: e.target.value, action: "" }))}>{depts.map((d) => <option key={d}>{d}</option>)}</select></div>
          <div {...ui.field()}><label {...ui.label()}>{t("Project")}</label><select {...ui.input()} value={f.project} onChange={set("project")}><option value="">{t("(none)")}</option>{S?.projects.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.class}</option>)}</select></div>
          <div {...ui.field()}><label {...ui.label()}>{t("Action (what the result is)")}</label><select {...ui.input()} value={f.action} onChange={set("action")}><option value="">{t("let the senior choose")}</option>{actions.map((a) => <option key={a.id} value={a.id}>{a.id} · {a.tier}</option>)}</select></div>
          <div {...ui.field()}><label {...ui.label()}>{t("Priority")}</label><select {...ui.input()} value={f.priority} onChange={set("priority")}><option value="1">{t("1 — first")}</option><option value="2">2</option><option value="3">{t("3 — normal")}</option><option value="4">4</option><option value="5">{t("5 — whenever")}</option></select></div>
        </div>
        <div {...ui.field()}><label {...ui.label()}>{t("Goal")}</label><textarea {...cn(ui.input(), ui.textarea())} value={f.goal} onChange={set("goal")} placeholder={t("The outcome, not the steps. The senior plans the steps.")} /></div>
        <div {...ui.field()}><label {...ui.label()}>{t("Why")}</label><input {...ui.input()} value={f.why} onChange={set("why")} placeholder={t("Which objective this serves (the CEO and the judge read it)")} /></div>
        <div {...ui.field()}><label {...ui.label()}>{t("Done criteria, one per line")}</label><textarea {...cn(ui.input(), ui.textarea())} value={f.criteria} onChange={set("criteria")} placeholder={"feature.md exists on the branch\ntests pass\nREADME mentions it"} /></div>
        <div {...ui.row()} style={{ justifyContent: "flex-end" }}><Button onClick={onClose}>{t("Cancel")}</Button><Button tone="primary" onClick={() => void save()}>{t(editId ? "Save changes" : "Open ticket")}</Button></div>
      </div>
    </div>
  )
}
