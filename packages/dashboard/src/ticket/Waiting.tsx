/** One line on what a ticket waits on, and when that moves. */
import { getLang, t } from "../i18n.ts"
import { left, WAITING_EN } from "../format.ts"

export type WaitingRow = { ticket_id: string; title: string; state: string; on: string; eta: number | null; detail: string | null }

export const waitingText = (w: WaitingRow): string => {
  const d = w.detail ?? ""
  const base = getLang() === "ko" ? t(`w.${w.on}`, { d }) : (WAITING_EN[w.on] ?? w.on).replace("{d}", d)
  return base
}
export const etaText = (w: WaitingRow, now: number): string => (w.eta === null ? "" : w.eta - now <= 0 ? t("now") : t("in {t}", { t: left(w.eta - now) }))
