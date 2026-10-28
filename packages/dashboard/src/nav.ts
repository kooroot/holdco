/** Drawer and modal live in the URL (`?ticket=ENG-1`, `?new=1`) so a link can open them and Back closes them. */
import { useNavigate, useSearch } from "@tanstack/react-router"

export type Search = { ticket?: string; new?: boolean }
export const useOpenTicket = () => {
  const navigate = useNavigate()
  return (id: string | null) => void navigate({ to: ".", search: (prev: Search) => { const { ticket: _t, ...rest } = prev; return id ? { ...rest, ticket: id } : rest } })
}
export const useNewTicket = () => {
  const navigate = useNavigate()
  return (open: boolean) => void navigate({ to: ".", search: (prev: Search) => { const { new: _n, ...rest } = prev; return open ? { ...rest, new: true } : rest } })
}
export const useSearchState = () => useSearch({ strict: false }) as Search

export const VIEWS = [["/", "Home"], ["/inbox", "Inbox"], ["/tickets", "Tickets"], ["/audit", "Audit"], ["/quality", "Quality"], ["/releases", "Releases"], ["/spend", "Sessions & spend"], ["/org", "Organization"], ["/controls", "Controls"], ["/settings", "Settings"]] as const
export type ViewPath = (typeof VIEWS)[number][0]
