// Holdco's design tokens: one set, light/dark pairs resolved by CSS color-scheme (no listener).
import { defineConfig, defineVars } from "zyzz"

const base = defineVars({
  color: {
    bg: { light: "#f4f5f2", dark: "#121417" },
    surface: { light: "#ffffff", dark: "#1a1d21" },
    surface2: { light: "#eceeea", dark: "#22262b" },
    ink: { light: "#15181c", dark: "#e7e9e6" },
    muted: { light: "#667085", dark: "#9aa3ad" },
    line: { light: "#dfe3dd", dark: "#2a2f36" },
    lineStrong: { light: "#c7ccc4", dark: "#3a414a" },
    signal: { light: "#b2500f", dark: "#e58a3c" },
    signalSoft: { light: "#fbe9dc", dark: "#3a2614" },
    ok: { light: "#1d7a5f", dark: "#4cc39a" },
    okSoft: { light: "#dcf2ea", dark: "#14332a" },
    bad: { light: "#b42318", dark: "#f07070" },
    badSoft: { light: "#fde3e1", dark: "#3b1a1a" },
    kernel: { light: "#3a4ead", dark: "#93a4ff" },
    kernelSoft: { light: "#e4e8fa", dark: "#232a4a" },
    warn: { light: "#9a6700", dark: "#e2b93b" },
    warnSoft: { light: "#fff1cc", dark: "#3a2f10" },
    diffAdd: { light: "#e6f4ea", dark: "#15301f" },
    diffDel: { light: "#fbe8e6", dark: "#3a1d1a" },
    diffAddInk: { light: "#0f5132", dark: "#9be2b4" },
    diffDelInk: { light: "#7a1f17", dark: "#f3a9a2" },
    white: "#ffffff",
  },
  spacing: { xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px", xxl: "32px" },
  radius: { sm: "4px", md: "6px", lg: "8px", xl: "10px", pill: "999px" },
  fontFamily: { ui: '"Instrument Sans", "Helvetica Neue", Arial, sans-serif', mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace' },
  fontSize: { xs: "11.5px", sm: "12.5px", md: "14px", lg: "16px", xl: "20px", big: "26px" },
})

export const { style, variants, vars, appearance, script } = defineConfig({ vars: base })
