import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginPage } from '@/features/auth/AuthPages'
import { TaskCard, TasksPage } from '@/features/tasks/TasksPage'
import { render } from '@testing-library/react'
import { me, mockApi, renderApp } from './utils'
import type { Task } from '@/lib/types'

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Ship pricing page',
  description: null,
  status: 'IN_PROGRESS',
  priority: 'HIGH',
  impactLevel: 'CRITICAL',
  complexity: 3,
  category: null,
  labels: [],
  dueAt: '2020-01-01T00:00:00Z',
  startedAt: null,
  completedAt: null,
  estimateMins: null,
  actualMins: 0,
  assigneeId: 'u1',
  creatorId: 'u1',
  parentId: null,
  projectId: null,
  origin: 'EXTERNAL',
  needsReview: true,
  recurrenceRule: null,
  reopenCount: 0,
  createdAt: '',
  updatedAt: '',
  assignee: { id: 'u1', name: 'Ada Lovelace' },
  project: null,
  source: { provider: 'linear', externalKey: 'ENG-42', sourceUrl: 'https://linear.app/x', lastSyncedAt: '' },
  goals: [],
  openBlockers: 1,
  canEdit: true,
  _count: { subtasks: 0, comments: 0, evidence: 0 },
  ...over,
})

describe('LoginPage', () => {
  it('validates input before calling the API', async () => {
    const calls = mockApi({ '/auth/me': () => new Response('{}', { status: 401 }) })
    renderApp(<LoginPage />, { route: '/login' })
    await userEvent.click(await screen.findByRole('button', { name: /^sign in$/i }))
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0)
    expect(calls.filter((c) => c.url.pathname === '/api/auth/login')).toHaveLength(0)
  })
  it('shows the server error on bad credentials', async () => {
    mockApi({
      '/auth/me': () => new Response('{}', { status: 401 }),
      '/auth/login': () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Email or password is incorrect.' } }), { status: 401 }),
    })
    renderApp(<LoginPage />, { route: '/login' })
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password1')
    await userEvent.click(screen.getByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument()
  })
})

describe('TaskCard', () => {
  it('shows priority, impact, blockers, review flag, source and overdue state, and opens from the keyboard', async () => {
    let opened = 0
    render(<TaskCard task={task()} onOpen={() => opened++} />)
    const card = screen.getByRole('button', { name: /open ship pricing page/i })
    for (const t of ['High', 'Critical impact', '1 blocker', 'Needs review']) expect(within(card).getByText(t)).toBeInTheDocument()
    expect(within(card).getByText(/overdue/i)).toBeInTheDocument()
    expect(within(card).getByRole('link')).toHaveAttribute('href', 'https://linear.app/x')
    card.focus()
    await userEvent.keyboard('{Enter}')
    expect(opened).toBe(1)
  })
})

describe('TasksPage', () => {
  const handlers = (items: Task[]) => ({
    '/auth/me': () => me,
    '/tasks': () => ({ items, total: items.length, page: 1, pageSize: 500 }),
    '/members': () => ({ members: [] }),
    '/projects': () => ({ projects: [{ id: 'p1', name: 'Checkout', status: 'ACTIVE', progress: 0, teamId: null, canEdit: true }] }),
    '/goals': () => ({ goals: [] }),
    '/ai/status': () => ({ configured: false, reason: 'AI is not configured.' }),
  })
  it('renders tasks on the board and applies filters through the URL and the API query', async () => {
    const calls = mockApi(handlers([task()]))
    renderApp(<TasksPage />, { route: '/tasks', path: '/tasks' })
    expect(await screen.findByText('Ship pricing page')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'BLOCKED')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('status=BLOCKED'))
    await waitFor(() => expect(calls.some((c) => c.url.pathname === '/api/tasks' && c.url.searchParams.get('status') === 'BLOCKED')).toBe(true))
    // Default scope is "assigned to me"
    expect(calls.find((c) => c.url.pathname === '/api/tasks')!.url.searchParams.get('assigneeId')).toBe('me')
  })
  it('shows an empty state with a create action', async () => {
    mockApi(handlers([]))
    renderApp(<TasksPage />, { route: '/tasks', path: '/tasks' })
    expect(await screen.findByText('No tasks yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /new task/i }).length).toBeGreaterThan(0)
  })
  it('switches to the list view and supports bulk selection', async () => {
    mockApi(handlers([task(), task({ id: 't2', title: 'Second task' })]))
    renderApp(<TasksPage />, { route: '/tasks?view=list', path: '/tasks' })
    await userEvent.click(await screen.findByRole('checkbox', { name: /select all/i }))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })
})
