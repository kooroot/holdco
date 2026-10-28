import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { api, type Action } from "./api.ts"

export const useSnapshot = () => useQuery({ queryKey: ["state"], queryFn: api.state, refetchInterval: 5000, refetchIntervalInBackground: false })
export const useTicket = (id: string | null, blind = false) => useQuery({ queryKey: ["ticket", id, blind], queryFn: () => api.ticket(id as string, blind), enabled: id !== null })
export const useFiles = (id: string | null) => useQuery({ queryKey: ["files", id], queryFn: () => api.files(id as string), enabled: id !== null })
export const useFile = (id: string | null, path: string | null) => useQuery({ queryKey: ["file", id, path], queryFn: () => api.file(id as string, path as string), enabled: id !== null && path !== null })

/** The live feed of one session: polls the journal every 2s while the session runs, keeps what it has seen. */
export const useLiveFeed = (sessionId: string | null) => {
  const [state, setState] = useState<{ id: string | null; events: Array<Awaited<ReturnType<typeof api.events>>["events"][number]>; running: boolean; status: string | null; cost: number }>({ id: null, events: [], running: false, status: null, cost: 0 })
  const q = useQuery({
    queryKey: ["events", sessionId, state.id === sessionId ? (state.events.at(-1)?.i ?? -1) : -1],
    queryFn: () => api.events(sessionId as string, state.id === sessionId ? (state.events.at(-1)?.i ?? -1) : -1),
    enabled: sessionId !== null,
    refetchInterval: state.id === sessionId && !state.running && state.events.length ? false : 2000,
  })
  useEffect(() => {
    const r = q.data
    if (!r || sessionId === null) return
    setState((s) => (s.id === sessionId ? { ...s, events: r.events.length ? [...s.events, ...r.events] : s.events, running: r.running, status: r.status, cost: r.cost_usd } : { id: sessionId, events: [...r.events], running: r.running, status: r.status, cost: r.cost_usd }))
  }, [q.data, sessionId])
  return state.id === sessionId ? state : { id: sessionId, events: [], running: false, status: null, cost: 0 }
}

/** Toasts: one line at the bottom, errors in red. */
export type Toast = { text: string; error?: boolean } | null
let setToastGlobal: (t: Toast) => void = () => {}
export const useToastState = () => {
  const [toast, setToast] = useState<Toast>(null)
  setToastGlobal = (t) => { setToast(t); if (t) setTimeout(() => setToast((cur) => (cur === t ? null : cur)), t.error ? 5000 : 2200) }
  return toast
}
export const toast = (text: string, error = false) => setToastGlobal({ text, error })

export const useAct = () => {
  const qc = useQueryClient()
  const m = useMutation({ mutationFn: (a: Action) => api.act(a), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["state"] }); void qc.invalidateQueries({ queryKey: ["ticket"] }) }, onError: (e) => toast(e.message, true) })
  return useCallback(async (a: Action, ok?: string | ((r: Record<string, unknown>) => string)) => {
    try {
      const r = await m.mutateAsync(a)
      if (ok) toast(typeof ok === "function" ? ok(r) : ok)
      return r
    } catch {
      return undefined
    }
  }, [m])
}
