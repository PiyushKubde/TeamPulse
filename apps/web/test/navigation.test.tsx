import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthProvider } from '@/lib/auth'
import { App } from '@/App'
import { me, mockApi } from './utils'

const renderAt = (route: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )

describe('navigation', () => {
  it('sends signed-out visitors to the sign-in page', async () => {
    mockApi({ '/auth/me': () => new Response('{}', { status: 401 }) })
    renderAt('/tasks')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })
  it('shows team navigation to managers but not to members', async () => {
    mockApi({
      '/auth/me': () => me,
      '/notifications': () => ({ items: [], unread: 0 }),
      '/analytics/individual': () => new Response('{}', { status: 500 }),
      '/ai/status': () => ({ configured: false }),
      '/goals': () => ({ goals: [] }),
    })
    const { unmount } = renderAt('/')
    expect(await screen.findByRole('link', { name: /team overview/i })).toBeInTheDocument()
    unmount()
    mockApi({
      '/auth/me': () => ({ ...me, role: 'MEMBER' }),
      '/notifications': () => ({ items: [], unread: 0 }),
      '/analytics/individual': () => new Response('{}', { status: 500 }),
      '/ai/status': () => ({ configured: false }),
      '/goals': () => ({ goals: [] }),
    })
    renderAt('/team')
    await waitFor(() => expect(screen.getByRole('link', { name: /my dashboard/i })).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: /team overview/i })).toBeNull()
  })
  it('sends a signed-in user without an organization to onboarding', async () => {
    mockApi({ '/auth/me': () => ({ ...me, activeOrgId: null, role: null, organizations: [] }) })
    renderAt('/')
    expect(await screen.findByRole('heading', { name: /create your organization/i })).toBeInTheDocument()
  })
})
