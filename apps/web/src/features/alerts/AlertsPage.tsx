import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { BellRing, CheckCircle2, CircleAlert, PhoneCall } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { ago, fmtDateTime } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Skeleton, label, type Tone } from '@/components/ui'
import { PhoneAlerts } from '../settings/SettingsPage'

interface OnCall {
  configured: boolean
  channel: string | null
  error: string | null
  personalAvailable: boolean
  conditions: { customId: string; label: string; severity: string; open: string | null }[]
  recent: { id: string; title: string; severity: string; status: string; delivered: number; createdAt: string; closedAt: string | null }[]
}

const SEVERITY: Record<string, { tone: Tone; text: string }> = {
  CRITICAL: { tone: 'red', text: 'Critical · also phones' },
  HIGH: { tone: 'amber', text: 'High' },
  MEDIUM: { tone: 'blue', text: 'Medium · rings, never phones' },
  LOW: { tone: 'neutral', text: 'Low' },
}

export function AlertsPage() {
  const { isAdmin } = useAuth()
  return (
    <div>
      <PageHeader
        title="Phone alerts"
        description="Through M91, WorkPulse rings phones at full volume (even on silent) when something needs a person now, and acts on the answer given from the alert."
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <PhoneAlerts />
        </div>
        {isAdmin && <OnCallCard />}
      </div>
    </div>
  )
}

function OnCallCard() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['on-call'], queryFn: () => api<OnCall>('/alerts/on-call'), refetchInterval: 30_000 })
  const test = useMutation({
    mutationFn: () => api<{ delivered: number }>('/alerts/on-call/test', { method: 'POST' }),
    onSuccess: (r) => {
      toast.success(`Test alert sent to ${r.delivered} ${r.delivered === 1 ? 'phone' : 'phones'}: ask them to confirm it rang`)
      qc.invalidateQueries({ queryKey: ['on-call'] })
    },
    onError: (e) => toast.error(errorMessage(e), { duration: 10000 }),
  })
  if (q.isLoading) return <Skeleton className="h-96" />
  const d = q.data
  if (!d) return null
  const openCount = d.conditions.filter((c) => c.open).length
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <PhoneCall className="size-4 text-primary" /> On-call channel
            </span>
          }
          description="Rings your team’s M91 channel when WorkPulse itself breaks. Checked every minute."
          action={
            d.configured &&
            d.channel && (
              <Button size="sm" variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
                Send test alert
              </Button>
            )
          }
        />
        <div className="space-y-3 p-4 text-sm">
          {!d.configured ? (
            <div className="space-y-1.5 text-ink-soft">
              <p className="font-medium text-ink">Not connected yet.</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>In the M91 app, create a channel and add whoever should be woken.</li>
                <li>On that channel, tap the paper-plane icon and copy the link.</li>
                <li>Give it to whoever runs WorkPulse’s server, to add as its on-call link.</li>
              </ol>
            </div>
          ) : d.error ? (
            <p className="text-danger">{d.error}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="green">
                <CheckCircle2 className="size-3" /> Connected
              </Badge>
              <span>
                Channel <strong>{d.channel}</strong>
              </span>
              {openCount > 0 ? <Badge tone="red">{openCount} ringing now</Badge> : <Badge>All clear</Badge>}
            </div>
          )}
          <ul className="divide-y divide-line rounded-lg border border-line">
            {d.conditions.map((c) => (
              <li key={c.customId} className="flex items-center gap-2 px-3 py-2">
                {c.open ? <CircleAlert className="size-4 shrink-0 text-danger" /> : <CheckCircle2 className="size-4 shrink-0 text-success" />}
                <span className="min-w-0 flex-1">{c.label}</span>
                {c.open && <span className="text-xs text-danger">since {ago(c.open)}</span>}
                <Badge tone={SEVERITY[c.severity]?.tone}>{SEVERITY[c.severity]?.text ?? label(c.severity)}</Badge>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Each condition rings once while it lasts (answer “I’ll handle it” or “Seen”) and closes by itself when it clears. Everyone in the channel needs the
            M91 app installed (
            <a className="text-primary hover:underline" href="https://apps.apple.com/app/id6759090472" target="_blank" rel="noreferrer">
              iPhone
            </a>{' '}
            ·{' '}
            <a className="text-primary hover:underline" href="https://play.google.com/store/apps/details?id=com.msg91.m91" target="_blank" rel="noreferrer">
              Android
            </a>
            ) and the invitation accepted.
          </p>
        </div>
      </Card>
      <Card>
        <CardHeader title="On-call history" />
        {d.recent.length === 0 ? (
          <EmptyState icon={<BellRing />} title="Nothing has rung yet" description="Alerts appear here when a condition above trips." />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {d.recent.map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-4 py-2">
                <Badge tone={SEVERITY[a.severity]?.tone}>{label(a.severity)}</Badge>
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
                <span className="text-xs text-muted">
                  {a.status === 'OPEN' ? 'ringing' : `cleared ${a.closedAt ? ago(a.closedAt) : ''}`} · {fmtDateTime(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {!d.personalAvailable && (
        <Card className="p-4 text-sm">
          <p className="font-medium">Personal phone alerts are off</p>
          <p className="mt-1 text-ink-soft">
            To let people get their own alerts (for example a critical task assigned to them), create an API key in the M91 app (Settings → API keys) and give
            it to whoever runs WorkPulse’s server, to add as the M91 API key.
          </p>
        </Card>
      )}
    </div>
  )
}
