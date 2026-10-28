import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import { api, type Action } from "./api.ts"

export const useSnapshot = () => useQuery({ queryKey: ["state"], queryFn: api.state, refetchInterval: 5000, refetchIntervalInBackground: false })
export const useTicket = (id: string | null, blind = false) => useQuery({ queryKey: ["ticket", id, blind], queryFn: () => api.ticket(id as string, blind), enabled: id !== null })
export const useFiles = (id: string | null) => useQuery({ queryKey: ["files", id], queryFn: () => api.files(id as string), enabled: id !== null })
export const useFile = (id: string | null, path: string | null) => useQuery({ queryKey: ["file", id, path], queryFn: () => api.file(id as string, path as string), enabled: id !== null && path !== null })

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
