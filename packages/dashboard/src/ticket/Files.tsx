/** The files a branch changed, with the deliverable rendered (Markdown) or shown as text. */
import { useEffect, useState } from "react"
import { cx } from "zyzz"
import { style } from "../../zyzz.config.ts"
import { useFile, useFiles } from "../hooks.ts"
import { Markdown } from "./markdown.tsx"
import { cn, ui } from "../ui.tsx"
import { t, useLang } from "../i18n.ts"

const st = {
  wrap: style({ display: "grid", gridTemplateColumns: "220px 1fr", gap: "md", minHeight: "200px !custom", "@media (max-width: 900px)": { gridTemplateColumns: "1fr" } }),
  stacked: style({ gridTemplateColumns: "1fr" }),
  list: style({ display: "grid", alignContent: "start" }),
  listRow: style({ display: "flex", flexWrap: "wrap", gap: "xs" }),
  item: style({ display: "block", padding: "6px 8px !custom", borderRadius: "sm", fontFamily: "mono", fontSize: "12px !custom", textDecoration: "none", color: "ink", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100% !custom", cursor: "pointer", border: "none", backgroundColor: "surface", textAlign: "left" }),
  active: style({ backgroundColor: "kernelSoft", color: "kernel" }),
  status: style({ color: "muted", marginRight: "6px !custom" }),
  pre: style({ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "0 !custom", fontSize: "12px !custom", lineHeight: 1.5, fontFamily: "mono" }),
}

export const Files = ({ id, stacked }: { id: string; stacked?: boolean }) => {
  useLang()
  const files = useFiles(id)
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    if (!files.data || path) return
    const docs = files.data.files.filter((f) => /\.(md|markdown|txt)$/i.test(f.path))
    setPath((docs[0] ?? files.data.files[0])?.path ?? null)
  }, [files.data, path])
  const file = useFile(id, path)
  if (files.isLoading) return <div {...cn(ui.muted(), ui.small())}>{t("Loading…")}</div>
  if (!files.data?.files.length) return <div {...cn(ui.muted(), ui.small())}>{t("No files changed{b}.", { b: files.data ? t(" vs {b}", { b: files.data.base }) : "" })}</div>
  return (
    <div {...cx(st.wrap(), stacked && st.stacked())}>
      <div {...cx(st.list(), stacked && st.listRow())}>
        {files.data.files.map((f) => <button key={f.path} title={f.path} {...cx(st.item(), f.path === path && st.active())} onClick={() => setPath(f.path)}><span {...st.status()}>{f.status[0]}</span>{f.path}</button>)}
      </div>
      <div>
        {file.isLoading ? <div {...cn(ui.muted(), ui.small())}>{t("Loading…")}</div>
          : file.data ? (file.data.binary ? <div {...cn(ui.muted(), ui.small())}>{t("Binary file.")}</div> : /\.(md|markdown)$/i.test(file.data.path) ? <Markdown source={file.data.content} /> : <pre {...st.pre()}>{file.data.content}</pre>) : null}
        {file.data?.truncated ? <p {...cn(ui.small(), ui.muted())}>{t("Truncated at 300 KB.")}</p> : null}
      </div>
    </div>
  )
}
