/** A unified diff, per file, collapsible, with the stats GitHub shows. */
import { useMemo } from "react"
import { cx } from "zyzz"
import { style, vars } from "../../zyzz.config.ts"
import { cn, Empty, ui } from "../ui.tsx"

const st = {
  diff: style({ fontFamily: "mono", fontSize: "12px !custom", lineHeight: 1.5 }),
  file: style({ border: `1px solid ${vars.color.line} !custom`, borderRadius: "md", marginBottom: "10px !custom", overflow: "hidden" }),
  summary: style({ padding: "7px 12px !custom", backgroundColor: "surface2", color: "ink", display: "flex", gap: "10px !custom", cursor: "pointer", listStyle: "none" }),
  name: style({ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
  hunk: style({ overflowX: "auto" }),
  ln: style({ display: "grid", gridTemplateColumns: "44px 44px 1fr", whiteSpace: "pre" }),
  no: style({ color: "muted", textAlign: "right", paddingRight: "10px !custom", userSelect: "none" }),
  txt: style({ paddingLeft: "10px !custom" }),
  add: style({ backgroundColor: "diffAdd", color: "diffAddInk" }),
  del: style({ backgroundColor: "diffDel", color: "diffDelInk" }),
  hd: style({ color: "kernel", backgroundColor: "surface2" }),
}

type Line = { k: "add" | "del" | "ctx" | "hd"; o?: number; n?: number; t: string }
type File = { name: string; lines: Array<Line>; add: number; del: number }

export const parseDiff = (patch: string): Array<File> => {
  const files: Array<File> = []
  let cur: (File & { o: number; n: number }) | null = null
  const lines = patch.split("\n")
  if (lines.at(-1) === "") lines.pop()
  for (const line of lines) {
    if (line.startsWith("diff --git")) { cur = { name: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1"), lines: [], add: 0, del: 0, o: 0, n: 0 }; files.push(cur); continue }
    if (!cur) continue
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename|old mode|new mode)/.test(line)) continue
    if (line.startsWith("Binary")) { cur.lines.push({ k: "hd", t: line }); continue }
    if (line.startsWith("@@")) { const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line); cur.o = Number(m?.[1] ?? 0); cur.n = Number(m?.[2] ?? 0); cur.lines.push({ k: "hd", t: line }); continue }
    if (line.startsWith("+")) { cur.add++; cur.lines.push({ k: "add", n: cur.n++, t: line.slice(1) }) }
    else if (line.startsWith("-")) { cur.del++; cur.lines.push({ k: "del", o: cur.o++, t: line.slice(1) }) }
    else if (line.startsWith("\\")) cur.lines.push({ k: "hd", t: line })
    else cur.lines.push({ k: "ctx", o: cur.o++, n: cur.n++, t: line.slice(1) })
  }
  return files
}

export const Diff = ({ diff }: { diff: { base: string; patch: string; truncated: boolean } }) => {
  const files = useMemo(() => parseDiff(diff.patch), [diff.patch])
  if (!diff.patch.trim()) return <Empty>No changes against {diff.base}.</Empty>
  return (
    <div {...st.diff()}>
      {files.map((f, i) => (
        <details key={f.name} {...st.file()} open={f.lines.length < 400 || i === 0}>
          <summary {...st.summary()}><span {...st.name()}>{f.name}</span><span {...ui.muted()}><b style={{ color: "var(--ok, inherit)" }}>+{f.add}</b> <b>−{f.del}</b></span></summary>
          <div {...st.hunk()}>
            {f.lines.map((l, j) => l.k === "hd"
              ? <div key={j} {...cx(st.ln(), st.hd())}><span /><span /><span {...st.txt()}>{l.t}</span></div>
              : <div key={j} {...cx(st.ln(), l.k === "add" && st.add(), l.k === "del" && st.del())}><span {...st.no()}>{l.o ?? ""}</span><span {...st.no()}>{l.n ?? ""}</span><span {...st.txt()}>{l.t}</span></div>)}
          </div>
        </details>
      ))}
      {diff.truncated ? <p {...cn(ui.small(), ui.muted())}>Diff truncated at 400 KB; open the branch in your editor for the rest.</p> : null}
    </div>
  )
}
