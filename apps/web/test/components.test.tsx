import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api, ApiError, qs } from '@/lib/api'
import { ErrorState, KpiCard } from '@/components/ui'
import { BarList, ChartCard } from '@/components/charts'
import { mockApi } from './utils'

describe('api client', () => {
  it('sends the CSRF header and JSON, and builds query strings', async () => {
    const calls = mockApi({ '/tasks': () => ({ items: [] }) })
    await api('/tasks', { method: 'POST', body: { title: 'x' }, query: { status: ['TODO', 'BLOCKED'], empty: '' } })
    const init = calls[0]!.init!
    expect((init.headers as Record<string, string>)['X-WorkPulse']).toBe('1')
    expect(init.credentials).toBe('include')
    expect(calls[0]!.url.search).toBe('?status=TODO&status=BLOCKED')
    expect(qs({ a: 1, b: undefined })).toBe('?a=1')
  })
  it('turns API errors into ApiError with code and message', async () => {
    mockApi({ '/tasks': () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Nope' } }), { status: 403 }) })
    await expect(api('/tasks')).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Nope' })
    await expect(api('/tasks')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('KpiCard', () => {
  it('is clickable without nesting the info button inside another button', async () => {
    const onClick = vi.fn()
    const { container } = render(<KpiCard label="Active blockers" value={3} info="Open tasks currently blocked." onClick={onClick} />)
    await userEvent.click(screen.getByRole('button', { name: /active blockers: show details/i }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(container.querySelector('button button')).toBeNull()
    expect(screen.getByRole('button', { name: /what does this mean/i })).toBeInTheDocument()
  })
})

describe('charts', () => {
  it('offers a table view with every value', async () => {
    render(
      <ChartCard
        title="Weekly"
        table={{
          columns: ['Week', 'Done'],
          rows: [
            ['3 Nov', 4],
            ['10 Nov', 7],
          ],
        }}
      >
        <div>chart</div>
      </ChartCard>,
    )
    await userEvent.click(screen.getByRole('button', { name: /show as table/i }))
    expect(screen.getByRole('cell', { name: '7' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /show chart/i }))
    expect(screen.getByText('chart')).toBeInTheDocument()
  })
  it('shows an empty state instead of an empty chart', () => {
    render(
      <ChartCard title="Weekly" empty table={{ columns: [], rows: [] }}>
        <div>chart</div>
      </ChartCard>,
    )
    expect(screen.getByText(/no data in this range/i)).toBeInTheDocument()
    expect(screen.queryByText('chart')).toBeNull()
  })
  it('bar rows are selectable (drill-down)', async () => {
    const onSelect = vi.fn()
    render(
      <BarList
        rows={[
          { key: 'u1', label: 'Priya', value: 12 },
          { key: 'u2', label: 'Diego', value: 4 },
        ]}
        onSelect={onSelect}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /diego/i }))
    expect(onSelect).toHaveBeenCalledWith('u2')
  })
})

describe('ErrorState', () => {
  it('shows the message and retries', async () => {
    const retry = vi.fn()
    render(<ErrorState error={new Error('Server unavailable')} retry={retry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable')
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(retry).toHaveBeenCalled()
  })
})
