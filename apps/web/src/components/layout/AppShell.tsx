import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Building2,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderKanban,
  Gauge,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  MessageSquareQuote,
  Plug,
  RefreshCcw,
  Search,
  Settings,
  Target,
  Users,
  Workflow,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, cn } from '@/lib/utils'
import { Avatar, Badge, Spinner, label } from '@/components/ui'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/overlay'
import type { Task } from '@/lib/types'

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  managerOnly?: boolean
}
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Personal',
    items: [
      { to: '/', label: 'My Dashboard', icon: <LayoutDashboard /> },
      { to: '/planner', label: 'Daily Planner', icon: <CalendarCheck /> },
      { to: '/tasks', label: 'My Tasks', icon: <ListChecks /> },
      { to: '/goals', label: 'Goals & OKRs', icon: <Target /> },
      { to: '/projects', label: 'Projects', icon: <FolderKanban /> },
      { to: '/analytics', label: 'My Analytics', icon: <BarChart3 /> },
      { to: '/reports', label: 'Reports', icon: <FileText /> },
    ],
  },
  {
    section: 'Team',
    items: [
      { to: '/team', label: 'Team Overview', icon: <Gauge />, managerOnly: true },
      { to: '/team/analytics', label: 'Team Analytics', icon: <Activity />, managerOnly: true },
      { to: '/team/members', label: 'Member Performance', icon: <Users />, managerOnly: true },
      { to: '/reviews', label: 'Reviews & Feedback', icon: <MessageSquareQuote /> },
    ],
  },
  {
    section: 'Automation',
    items: [
      { to: '/integrations', label: 'Integrations', icon: <Plug /> },
      { to: '/automations', label: 'Automation Center', icon: <Workflow /> },
      { to: '/sync-history', label: 'Sync History', icon: <RefreshCcw /> },
      { to: '/assistant', label: 'AI Assistant', icon: <Bot /> },
    ],
  },
  { section: 'System', items: [{ to: '/settings', label: 'Settings', icon: <Settings /> }] },
]

const CRUMBS: Record<string, string> = {
  planner: 'Daily Planner',
  tasks: 'Tasks',
  goals: 'Goals & OKRs',
  projects: 'Projects',
  analytics: 'Analytics',
  reports: 'Reports',
  team: 'Team',
  members: 'Member Performance',
  reviews: 'Reviews & Feedback',
  integrations: 'Integrations',
  automations: 'Automation Center',
  'sync-history': 'Sync History',
  assistant: 'AI Assistant',
  settings: 'Settings',
}

function Breadcrumbs() {
  const { pathname } = useLocation()
  const parts = pathname.split('/').filter(Boolean)
  if (!parts.length) return <span className="text-sm font-medium text-ink">My Dashboard</span>
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
      <Link to="/" className="text-muted hover:text-ink">
        Home
      </Link>
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1">
          <ChevronRight className="size-3.5 shrink-0 text-muted" />
          {i === parts.length - 1 ? (
            <span className="truncate font-medium text-ink">{CRUMBS[p] ?? (p.length > 20 ? 'Details' : label(p))}</span>
          ) : (
            <Link to={`/${parts.slice(0, i + 1).join('/')}`} className="truncate text-muted hover:text-ink">
              {CRUMBS[p] ?? 'Details'}
            </Link>
          )}
        </span>
      ))}
    </nav>
  )
}

function GlobalSearch() {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const tasks = useQuery({
    queryKey: ['search', q],
    queryFn: () => api<{ items: Task[] }>('/tasks', { query: { q, pageSize: 6 } }),
    enabled: q.trim().length >= 2,
  })
  const people = useQuery({
    queryKey: ['members'],
    queryFn: () => api<{ members: { userId: string; name: string; managed: boolean }[] }>('/members'),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
  })
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: { id: string; name: string }[] }>('/projects'),
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
  })
  const term = q.trim().toLowerCase()
  const hits = [
    ...(tasks.data?.items ?? []).map((t) => ({ key: `t${t.id}`, label: t.title, kind: 'Task', to: `/tasks?task=${t.id}` })),
    ...(projects.data?.projects ?? [])
      .filter((p) => p.name.toLowerCase().includes(term))
      .slice(0, 4)
      .map((p) => ({ key: `p${p.id}`, label: p.name, kind: 'Project', to: `/projects/${p.id}` })),
    ...(people.data?.members ?? [])
      .filter((m) => m.managed && m.name.toLowerCase().includes(term))
      .slice(0, 4)
      .map((m) => ({ key: `u${m.userId}`, label: m.name, kind: 'Person', to: `/team/members/${m.userId}` })),
  ]
  return (
    <div className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search tasks, projects, people"
        aria-label="Search"
        className="h-9 w-full rounded-lg border border-line bg-canvas pl-8 pr-3 text-sm placeholder:text-muted focus:border-primary focus:bg-surface focus:outline-none"
      />
      {open && term.length >= 2 && (
        <div className="absolute left-0 right-0 top-11 z-30 overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          {hits.length ? (
            hits.map((h) => (
              <button
                key={h.key}
                onMouseDown={() => navigate(h.to)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-canvas"
              >
                <span className="truncate">{h.label}</span>
                <Badge>{h.kind}</Badge>
              </button>
            ))
          ) : (
            <p className="px-3 py-3 text-sm text-muted">{tasks.isFetching ? 'Searching…' : 'No matches'}</p>
          )}
        </div>
      )}
    </div>
  )
}

function Notifications() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api<{ items: { id: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }[]; unread: number }>(
        '/notifications',
      ),
    refetchInterval: 60_000,
  })
  const read = useMutation({
    mutationFn: (ids?: string[]) => api('/notifications/read', { body: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
  const unread = q.data?.unread ?? 0
  return (
    <Menu>
      <MenuTrigger className="relative rounded-lg p-2 text-ink-soft hover:bg-canvas" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <Bell className="size-4.5" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-danger text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </MenuTrigger>
      <MenuContent>
        <div className="flex w-80 items-center justify-between px-2 py-1.5">
          <span className="text-xs font-medium text-muted">Notifications</span>
          {unread > 0 && (
            <button className="text-xs text-primary hover:underline" onClick={() => read.mutate(undefined)}>
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {(q.data?.items ?? []).length === 0 && <p className="px-2 py-4 text-center text-sm text-muted">You’re all caught up.</p>}
          {(q.data?.items ?? []).slice(0, 20).map((n) => (
            <MenuItem
              key={n.id}
              onSelect={() => {
                if (!n.readAt) read.mutate([n.id])
                if (n.link) navigate(n.link.startsWith('/tasks/') ? `/tasks?task=${n.link.split('/')[2]}` : n.link)
              }}
            >
              <div className={cn('w-full', n.readAt && 'opacity-60')}>
                <div className="flex items-start gap-2">
                  {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-label="unread" />}
                  <div className="min-w-0">
                    <p className="text-sm leading-snug">{n.title}</p>
                    {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>}
                    <p className="mt-0.5 text-[11px] text-muted">{ago(n.createdAt)}</p>
                  </div>
                </div>
              </div>
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}

function OrgSwitcher() {
  const { me, refresh } = useAuth()
  const navigate = useNavigate()
  const active = me?.organizations.find((o) => o.id === me.activeOrgId)
  const sw = useMutation({
    mutationFn: (id: string) => api(`/organizations/${id}/switch`, { method: 'POST' }),
    onSuccess: async () => {
      await refresh()
      navigate('/')
    },
  })
  return (
    <Menu>
      <MenuTrigger className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-left hover:bg-white/10">
        <Building2 className="size-4 shrink-0 text-blue-200" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{active?.name ?? 'No organization'}</span>
        <ChevronDown className="size-3.5 text-blue-200" />
      </MenuTrigger>
      <MenuContent align="start">
        <MenuLabel>Organizations</MenuLabel>
        {me?.organizations.map((o) => (
          <MenuItem key={o.id} onSelect={() => o.id !== me.activeOrgId && sw.mutate(o.id)}>
            <span className="flex-1">{o.name}</span>
            <Badge tone={o.id === me.activeOrgId ? 'blue' : 'neutral'}>{label(o.role)}</Badge>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => navigate('/onboarding')}>Create organization</MenuItem>
      </MenuContent>
    </Menu>
  )
}

export function AppShell() {
  const { me, isManager, refresh } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])
  const logout = useMutation({
    mutationFn: () => api('/auth/logout', { method: 'POST' }),
    onSuccess: async () => {
      await refresh()
      navigate('/login')
    },
  })
  const nav = useMemo(() => NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.managerOnly || isManager) })).filter((s) => s.items.length), [isManager])

  const sidebar = (
    <div className="flex h-full flex-col bg-[#0f1b33] text-blue-100">
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <img src="/favicon.svg" alt="" className="size-7" />
        <span className="text-[15px] font-semibold tracking-tight text-white">WorkPulse</span>
      </div>
      <div className="px-3 pb-2">
        <OrgSwitcher />
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
        {nav.map((s) => (
          <div key={s.section} className="mt-4">
            <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-blue-300/70">{s.section}</p>
            {s.items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === '/' || i.to === '/team'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm [&_svg]:size-4',
                    isActive ? 'bg-white/12 font-medium text-white' : 'text-blue-100/80 hover:bg-white/6 hover:text-white',
                  )
                }
              >
                {i.icon}
                {i.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </div>
  )

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur">
          <button className="rounded-md p-1.5 text-ink-soft hover:bg-canvas lg:hidden" onClick={() => setMobileOpen((o) => !o)} aria-label="Open navigation">
            {mobileOpen ? <X className="size-5" /> : <MenuIcon className="size-5" />}
          </button>
          <div className="hidden min-w-0 flex-1 md:block">
            <Breadcrumbs />
          </div>
          <div className="flex flex-1 justify-end gap-2 md:flex-none">
            <GlobalSearch />
            <Notifications />
            <Menu>
              <MenuTrigger className="flex items-center gap-2 rounded-lg p-1 hover:bg-canvas" aria-label="Account menu">
                <Avatar name={me?.user.name ?? '?'} />
              </MenuTrigger>
              <MenuContent>
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{me?.user.name}</p>
                  <p className="text-xs text-muted">{me?.user.email}</p>
                </div>
                <MenuSeparator />
                <MenuItem onSelect={() => navigate('/settings')}>
                  <Settings /> Settings
                </MenuItem>
                <MenuItem onSelect={() => logout.mutate()} danger>
                  <LogOut /> Sign out
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </header>
        {me && !me.user.emailVerified && <VerifyBanner />}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  )
}

function VerifyBanner() {
  const { me, isAdmin } = useAuth()
  const [state, setState] = useState<'idle' | 'sent' | 'error'>('idle')
  if (!me?.mailConfigured) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-2 border-b border-warn/20 bg-warn-soft px-4 py-1.5 text-xs text-warn">
        WorkPulse can’t send email yet, so verification links can’t be delivered.
        {isAdmin ? (
          <Link to="/integrations" className="font-medium underline">
            Connect Gmail to turn email on
          </Link>
        ) : (
          <span>Ask an owner or admin to connect Gmail in Integrations.</span>
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center gap-2 border-b border-warn/20 bg-warn-soft px-4 py-1.5 text-xs text-warn">
      Please verify your email address ({me.user.email}).
      <button
        className="font-medium underline"
        disabled={state === 'sent'}
        onClick={() =>
          api('/auth/resend-verification', { method: 'POST' })
            .then(() => setState('sent'))
            .catch(() => setState('error'))
        }
      >
        {state === 'sent' ? 'Sent: check your inbox' : state === 'error' ? 'Could not send, try again' : 'Send verification link'}
      </button>
    </div>
  )
}
