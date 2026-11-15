import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi } from 'vitest'
import { AuthProvider } from '@/lib/auth'

export const me = {
  user: { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', emailVerified: true },
  activeOrgId: 'o1',
  role: 'MANAGER',
  organizations: [{ id: 'o1', name: 'Acme', slug: 'acme', role: 'MANAGER' }],
}

/** Routes fetch calls to handlers by path; records every call. Unknown paths answer 404. */
export function mockApi(handlers: Record<string, (url: URL, init?: RequestInit) => unknown>) {
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push({ url, init })
    const key = Object.keys(handlers).find((k) => url.pathname === `/api${k}` || (k.endsWith('*') && url.pathname.startsWith(`/api${k.slice(0, -1)}`)))
    if (!key) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404 })
    const body = handlers[key]!(url, init)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

export function LocationProbe() {
  const l = useLocation()
  return <div data-testid="location">{l.pathname + l.search}</div>
}

export function renderApp(ui: ReactNode, { route = '/', path = '*' }: { route?: string; path?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Routes>
            <Route
              path={path}
              element={
                <>
                  {ui}
                  <LocationProbe />
                </>
              }
            />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
