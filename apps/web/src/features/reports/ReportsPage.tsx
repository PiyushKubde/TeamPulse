import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, FileText, Mail, MessageSquare, Sparkles } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAiStatus, useTeams } from '@/lib/queries'
import { fmtDate, fmtDateTime, todayYmd } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, label } from '@/components/ui'

interface Report {
  id: string
  kind: string
  subject: string
  periodStart: string
  periodEnd: string
  createdAt: string
  aiSummary: string | null
  content: { title: string; sections: { heading: string; items: string[] }[]; metrics: Record<string, number | string | null> }
  deliveries?: { id: string; channel: string; status: string; error: string | null; createdAt: string }[]
}

export function ReportsPage() {
  const { me } = useAuth()
  const teams = useTeams()
  const ai = useAiStatus()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [subject, setSubject] = useState(`user:${me?.user.id}`)
  const [kind, setKind] = useState<'DAILY' | 'WEEKLY'>('WEEKLY')
  const [date, setDate] = useState(todayYmd())
  const [withAi, setWithAi] = useState(false)
  const list = useQuery({ queryKey: ['reports', subject], queryFn: () => api<{ items: Report[] }>('/reports', { query: { subject } }) })
  const gen = useMutation({
    mutationFn: () => api<{ report: Report }>('/reports/generate', { body: { kind, subject, date, withAi } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['reports'] })
      navigate(`/reports/${r.report.id}`)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div>
      <PageHeader
        title="Reports"
        description="Daily and weekly reports built from real delivery data. Export as PDF or CSV, or send to your own email or Slack."
      />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Report on" htmlFor="r-subj">
            <Select id="r-subj" className="w-48" value={subject} onChange={(e) => setSubject(e.target.value)}>
              <option value={`user:${me?.user.id}`}>Me</option>
              {(teams.data ?? [])
                .filter((t) => t.canManage)
                .map((t) => (
                  <option key={t.id} value={`team:${t.id}`}>
                    Team: {t.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Type" htmlFor="r-kind">
            <Select id="r-kind" className="w-32" value={kind} onChange={(e) => setKind(e.target.value as 'DAILY')}>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
            </Select>
          </Field>
          <Field label={kind === 'WEEKLY' ? 'Any day in the week' : 'Day'} htmlFor="r-date">
            <Input id="r-date" type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {ai.data?.configured && (
            <label className="flex h-9 items-center gap-2 text-sm">
              <input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} /> <Sparkles className="size-3.5 text-primary" /> Add AI
              summary
            </label>
          )}
          <Button onClick={() => gen.mutate()} loading={gen.isPending}>
            Generate
          </Button>
        </div>
      </Card>
      <Card>
        <CardHeader title="Report history" />
        {list.isLoading ? (
          <Skeleton className="m-4 h-24" />
        ) : list.error ? (
          <ErrorState error={list.error} retry={() => list.refetch()} />
        ) : !list.data?.items.length ? (
          <EmptyState
            icon={<FileText />}
            title="No reports yet"
            description="Generate one above. Weekly reports are also created automatically every Monday."
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.items.map((r) => (
              <li key={r.id}>
                <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-hover" onClick={() => navigate(`/reports/${r.id}`)}>
                  <Badge tone={r.kind === 'WEEKLY' ? 'blue' : 'neutral'}>{label(r.kind)}</Badge>
                  <span className="flex-1">
                    {r.kind === 'WEEKLY' ? `Week of ${fmtDate(r.periodStart, 'd MMM yyyy')}` : fmtDate(r.periodStart, 'EEE d MMM yyyy')}
                  </span>
                  {r.aiSummary && <Badge tone="violet">AI summary</Badge>}
                  <span className="text-xs text-muted">{fmtDateTime(r.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

export function ReportView() {
  const { id } = useParams()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['report', id], queryFn: () => api<{ report: Report }>(`/reports/${id}`), select: (d) => d.report })
  const deliver = useMutation({
    mutationFn: (channel: 'EMAIL' | 'SLACK') => api<{ delivery: { status: string } }>(`/reports/${id}/deliver`, { body: { channel } }),
    onSuccess: (_r, channel) => {
      qc.invalidateQueries({ queryKey: ['report', id] })
      toast.success(channel === 'SLACK' ? 'Sent to Slack' : 'Emailed to you')
    },
    // The server explains what went wrong and what to do; keep it on screen long enough to read.
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['report', id] })
      toast.error(errorMessage(e), { duration: 12000 })
    },
  })
  if (q.isLoading) return <Skeleton className="h-96" />
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} retry={() => q.refetch()} />
      </Card>
    )
  const r = q.data
  return (
    <div>
      <PageHeader
        title={r.content.title}
        actions={
          <>
            <a href={`/api/reports/${r.id}/export.pdf`}>
              <Button variant="secondary">
                <Download /> PDF
              </Button>
            </a>
            <a href={`/api/reports/${r.id}/export.csv`}>
              <Button variant="secondary">
                <Download /> CSV
              </Button>
            </a>
            <Button variant="secondary" onClick={() => deliver.mutate('EMAIL')} loading={deliver.isPending && deliver.variables === 'EMAIL'}>
              <Mail /> Email me
            </Button>
            <Button variant="secondary" onClick={() => deliver.mutate('SLACK')} loading={deliver.isPending && deliver.variables === 'SLACK'}>
              <MessageSquare /> Send to Slack
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {r.aiSummary && (
            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Sparkles className="size-3.5 text-primary" /> Summary (AI-written; check against the data below)
              </p>
              <p className="mt-1.5 text-sm text-ink-soft">{r.aiSummary}</p>
            </Card>
          )}
          {r.content.sections.map((s) => (
            <Card key={s.heading}>
              <CardHeader title={s.heading} />
              {s.items.length ? (
                <ul className="space-y-1 p-4 text-sm">
                  {s.items.map((i, j) => (
                    <li key={j} className="flex gap-2">
                      <span className="text-muted">•</span>
                      <span>{i}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-sm text-muted">None</p>
              )}
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Figures" />
            <dl className="divide-y divide-line text-sm">
              {Object.entries(r.content.metrics).map(([k, v]) => (
                <div key={k} className="flex justify-between px-4 py-2">
                  <dt className="text-muted">{label(k.replace(/([A-Z])/g, '_$1'))}</dt>
                  <dd className="font-medium tabular">{v == null ? 'No data' : typeof v === 'number' ? Math.round(v * 10) / 10 : v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Deliveries" />
            {r.deliveries?.length ? (
              <ul className="divide-y divide-line text-sm">
                {r.deliveries.map((d) => (
                  <li key={d.id} className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Badge>{label(d.channel)}</Badge>
                      <Badge tone={d.status === 'SENT' ? 'green' : d.status === 'FAILED' ? 'red' : 'amber'}>{label(d.status)}</Badge>
                      <span className="ml-auto text-xs text-muted">{fmtDateTime(d.createdAt)}</span>
                    </div>
                    {d.error && <p className="mt-0.5 text-xs text-danger">{d.error}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-xs text-muted">Not sent anywhere yet.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
