/** A small Markdown renderer for deliverables: headings, lists, code, tables, quotes, emphasis, links. */
import { style, vars } from "../../zyzz.config.ts"

const md = style({ lineHeight: 1.6, maxWidth: "80ch !custom", "& h1, & h2, & h3": { margin: "18px 0 8px !custom" }, "& h1": { fontSize: "xl" }, "& h2": { fontSize: "lg" }, "& h3": { fontSize: "md" }, "& p": { margin: "0 0 10px !custom" }, "& ul, & ol": { margin: "0 0 10px !custom", paddingLeft: "22px !custom" }, "& pre": { backgroundColor: "surface2", padding: "10px 12px !custom", borderRadius: "md", overflowX: "auto", fontSize: "sm", fontFamily: "mono" }, "& code": { backgroundColor: "surface2", padding: "1px 4px !custom", borderRadius: "sm", fontFamily: "mono", fontSize: "12.5px !custom" }, "& table": { borderCollapse: "collapse", margin: "0 0 10px !custom" }, "& th, & td": { textAlign: "left", padding: "6px 10px !custom", borderBottom: `1px solid ${vars.color.line} !custom` }, "& blockquote": { margin: "0 0 10px !custom", paddingLeft: "12px !custom", borderLeft: `3px solid ${vars.color.lineStrong} !custom`, color: "muted" }, "& a": { color: "kernel" } })

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
const inline = (t: string) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')

export const renderMarkdown = (src: string): string => {
  const out: Array<string> = []
  const lines = src.split("\n")
  let i = 0
  while (i < lines.length) {
    const l = lines[i] as string
    if (l.startsWith("```")) { const buf: Array<string> = []; i++; while (i < lines.length && !(lines[i] as string).startsWith("```")) buf.push(lines[i++] as string); i++; out.push(`<pre>${esc(buf.join("\n"))}</pre>`); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { const n = Math.min(3, (h[1] as string).length); out.push(`<h${n}>${inline(h[2] as string)}</h${n}>`); i++; continue }
    if (/^\s*[-*]\s+/.test(l)) { const items: Array<string> = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] as string)) items.push(`<li>${inline((lines[i++] as string).replace(/^\s*[-*]\s+/, ""))}</li>`); out.push(`<ul>${items.join("")}</ul>`); continue }
    if (/^\s*\d+\.\s+/.test(l)) { const items: Array<string> = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] as string)) items.push(`<li>${inline((lines[i++] as string).replace(/^\s*\d+\.\s+/, ""))}</li>`); out.push(`<ol>${items.join("")}</ol>`); continue }
    if (/^\|/.test(l)) { const rows: Array<string> = []; while (i < lines.length && /^\|/.test(lines[i] as string)) rows.push(lines[i++] as string); const cells = (r: string) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()); const body = rows.filter((r) => !/^\|\s*:?-{2,}/.test(r)); out.push(`<table>${body.map((r, k) => `<tr>${cells(r).map((c) => (k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("")}</table>`); continue }
    if (/^>\s?/.test(l)) { const buf: Array<string> = []; while (i < lines.length && /^>\s?/.test(lines[i] as string)) buf.push((lines[i++] as string).replace(/^>\s?/, "")); out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue }
    if (l.trim() === "") { i++; continue }
    const buf: Array<string> = []
    while (i < lines.length && (lines[i] as string).trim() !== "" && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s|\||>)/.test(lines[i] as string)) buf.push(lines[i++] as string)
    out.push(`<p>${inline(buf.join(" "))}</p>`)
  }
  return out.join("")
}

export const Markdown = ({ source }: { source: string }) => <div {...md()} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
