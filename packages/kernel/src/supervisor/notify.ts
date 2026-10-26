/** Alerts (D15): Telegram, Slack or webhook, from company.yaml `alerts.channels`; plus the heartbeat ping. */
import type { CompanyConfig } from "../config/company.ts"

export type Severity = "critical" | "warning" | "info"

export interface Notifier {
  send(severity: Severity, text: string): Promise<void>
  heartbeat(): Promise<void>
}

export const consoleNotifier: Notifier = {
  send: async (s, t) => console.log(`[${s}] ${t}`),
  heartbeat: async () => {},
}

export const liveNotifier = (config: CompanyConfig, env: Record<string, string | undefined> = process.env): Notifier => {
  const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
    try {
      await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    } catch (e) {
      console.error(`alert delivery failed: ${String(e)}`)
    }
  }
  return {
    async send(severity, text) {
      const line = `[${config.company.name}] ${severity.toUpperCase()}: ${text}`
      console.log(line)
      for (const ch of config.alerts.channels) {
        if (ch.type === "telegram") {
          const token = env[ch.bot_token_env]
          if (token) await post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: ch.chat_id, text: line })
        } else if (ch.type === "slack") {
          const url = env[ch.webhook_env]
          if (url) await post(url, { text: line })
        } else {
          const url = env[ch.url_env]
          if (url) await post(url, { severity, text, company: config.company.name })
        }
      }
    },
    async heartbeat() {
      const name = config.alerts.heartbeat_url_env
      const url = name === undefined ? undefined : env[name]
      if (!url) return
      try {
        await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) })
      } catch {}
    },
  }
}
