// Shown while a new workspace still holds its sample team and work. The data disappears on its own when real work
// arrives (the first task anyone creates, or one an integration imports); admins can also remove it at once.
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'

type Org = { organization: { settings: { sample?: { active: boolean } } } }

export function SampleDataBanner() {
  const { isAdmin } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['organization'],
    queryFn: () => api<Org>('/organization'),
    // Imports can end the sample data without anyone clicking here: look again now and then while it is shown.
    refetchInterval: (query) => (query.state.data?.organization.settings.sample?.active ? 60_000 : false),
  })
  const active = Boolean(q.data?.organization.settings.sample?.active)

  // Creating a task anywhere (form, drawer, AI assistant) may end the sample data: check right after any change.
  useEffect(() => {
    if (!active) return
    return qc.getMutationCache().subscribe((e) => {
      if (e.type === 'updated' && e.mutation.state.status === 'success') void qc.invalidateQueries({ queryKey: ['organization'] })
    })
  }, [active, qc])

  // When it goes, every page refreshes so nothing sample is left on screen.
  const was = useRef(active)
  useEffect(() => {
    if (was.current && !active) {
      void qc.invalidateQueries()
      toast.success('Sample data removed. Your workspace now shows only your real work.')
    }
    was.current = active
  }, [active, qc])

  const remove = useMutation({
    mutationFn: () => api('/organization/sample-data', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['organization'] }),
    onError: (e) => toast.error(errorMessage(e)),
  })

  if (!active) return null
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b border-primary/20 bg-primary-soft px-4 py-2 text-[13px] text-ink"
    >
      <span>
        <Sparkles className="mr-1.5 inline size-4 -translate-y-px text-primary" aria-hidden />
        <b className="font-semibold">You are exploring sample data</b>: a small team, goals, KPIs and five weeks of work, so every page has something to show.
        It disappears on its own as soon as your first real task arrives, whether you add it or a connected app brings it in.
      </span>
      <span className="flex items-center gap-3">
        <Link to="/tasks" className="font-semibold text-primary underline-offset-4 hover:underline">
          Add my first task
        </Link>
        {isAdmin && (
          <button
            type="button"
            className="text-muted underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove sample data
          </button>
        )}
      </span>
    </div>
  )
}
