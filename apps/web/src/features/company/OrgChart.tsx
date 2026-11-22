// The reporting tree, from the top (CEO) down, with each person's own result and the roll-up of their whole line.
import { useMemo, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar, EmptyState, Input } from '@/components/ui'
import { pct, type CompanyOverview, type CompanyPerson } from './api'
import { HealthDot } from './parts'

const OPEN_DEPTH = 2 // people at depth 0 and 1 start expanded; everything deeper starts collapsed

export function OrgChart({ data, onOpen }: { data: CompanyOverview; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const term = q.trim().toLowerCase()

  const { children, roots, byId } = useMemo(() => {
    const byId = new Map(data.people.map((p) => [p.userId, p]))
    const children = new Map<string, CompanyPerson[]>()
    const roots: CompanyPerson[] = []
    for (const p of data.people) {
      if (p.reportsToId && byId.has(p.reportsToId)) children.set(p.reportsToId, [...(children.get(p.reportsToId) ?? []), p])
      else roots.push(p)
    }
    const byRank = (a: CompanyPerson, b: CompanyPerson) => b.subtreeSize - a.subtreeSize || a.name.localeCompare(b.name)
    for (const list of children.values()) list.sort(byRank)
    roots.sort(byRank)
    return { children, roots, byId }
  }, [data.people])

  // Searching shows only matching people and the chain above them, all expanded.
  const visibleIds = useMemo(() => {
    if (!term) return null
    const keep = new Set<string>()
    for (const p of data.people) {
      if (!`${p.name} ${p.title ?? ''}`.toLowerCase().includes(term)) continue
      for (let cur: CompanyPerson | undefined = p, i = 0; cur && i < 50; i++) {
        keep.add(cur.userId)
        cur = cur.reportsToId ? byId.get(cur.reportsToId) : undefined
      }
    }
    return keep
  }, [term, data.people, byId])

  const isOpen = (p: CompanyPerson) => (visibleIds ? true : (toggled[p.userId] ?? p.depth < OPEN_DEPTH))
  const setOpen = (p: CompanyPerson, open: boolean) => setToggled((t) => ({ ...t, [p.userId]: open }))
  const expandAll = (open: boolean) => setToggled(Object.fromEntries(data.people.map((p) => [p.userId, open])))

  const node = (p: CompanyPerson): React.ReactNode => {
    if (visibleIds && !visibleIds.has(p.userId)) return null
    const kids = (children.get(p.userId) ?? []).filter((k) => !visibleIds || visibleIds.has(k.userId))
    const open = isOpen(p)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && kids.length && !open) {
        e.preventDefault()
        setOpen(p, true)
      } else if (e.key === 'ArrowLeft' && kids.length && open) {
        e.preventDefault()
        setOpen(p, false)
      }
    }
    return (
      <li key={p.userId} role="treeitem" aria-expanded={kids.length ? open : undefined} aria-level={p.depth + 1}>
        <div className={cn('flex items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-hover', p.isMe && 'bg-primary-soft/50')}>
          {kids.length ? (
            <button
              type="button"
              aria-label={`${open ? 'Collapse' : 'Expand'} ${p.name}'s line (${p.subtreeSize} people)`}
              onClick={() => setOpen(p, !open)}
              onKeyDown={onKey}
              className="grid size-6 shrink-0 place-items-center rounded text-muted hover:text-ink"
            >
              {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          ) : (
            <span className="size-6 shrink-0" aria-hidden />
          )}
          <HealthDot health={p.health} />
          <button
            type="button"
            onClick={() => onOpen(p.userId)}
            aria-label={`Open ${p.name}'s scorecard`}
            className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Avatar name={p.name} className="size-7" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">
                {p.name}
                {p.isMe && <span className="ml-1.5 text-xs font-medium text-primary">(you)</span>}
              </span>
              <span className="block truncate text-xs text-muted">{p.title ?? p.role.toLowerCase()}</span>
            </span>
          </button>
          <span className="tabular w-12 text-right text-sm font-semibold text-ink" title="This person's own result">
            {pct(p.overall)}
          </span>
          {p.subtreeSize > 0 && (
            <span className="tabular hidden w-40 text-right text-xs text-muted sm:block" title="Average result of this person and everyone below them">
              Line {pct(p.rollupOverall)} · {p.subtreeSize} {p.subtreeSize === 1 ? 'person' : 'people'}
            </span>
          )}
        </div>
        {kids.length > 0 && open && (
          <ul role="group" className="ml-3 border-l border-line pl-3">
            {kids.map(node)}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input aria-label="Search people" placeholder="Search name or title" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!term && (
          <>
            <button type="button" onClick={() => expandAll(true)} className="text-xs font-semibold text-primary hover:underline">
              Expand all
            </button>
            <button type="button" onClick={() => expandAll(false)} className="text-xs font-semibold text-primary hover:underline">
              Collapse all
            </button>
          </>
        )}
        <span className="ml-auto text-xs text-muted">Each person: own result · their whole line below.</span>
      </div>
      {roots.length === 0 ? (
        <EmptyState title="No people to show" description="Set who reports to whom in the Structure tab." />
      ) : visibleIds && visibleIds.size === 0 ? (
        <EmptyState title="No one matches" description="Try a different name or title." />
      ) : (
        <ul role="tree" aria-label="Reporting structure" className="space-y-0.5">
          {roots.map(node)}
        </ul>
      )}
    </div>
  )
}
