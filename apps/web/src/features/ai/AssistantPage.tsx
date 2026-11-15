import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Bot, Send, Wrench } from 'lucide-react'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useAiStatus } from '@/lib/queries'
import { Badge, Button, Card, EmptyState, PageHeader, Textarea } from '@/components/ui'
import { CreateTaskDialog } from '../tasks/TaskForm'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  tools?: { tool: string; ok: boolean }[]
  draft?: {
    title: string
    description: string | null
    priority: string
    dueDate: string | null
    category: string | null
    suggestedImpact: string
    estimateMins: number | null
  } | null
  error?: boolean
}

const SUGGESTIONS = [
  'What did I accomplish this week?',
  'What was my highest-impact work this month?',
  'Which of my goals are falling behind?',
  'Which tasks keep getting postponed?',
  'What consumed most of my effort last week?',
  'What should I prioritize tomorrow?',
]
const MANAGER_SUGGESTIONS = ['Which team members are overloaded?', 'What is blocking my team right now?']

/** Minimal, safe markdown: paragraphs, bullet lists and **bold**. Model text is never injected as HTML. */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/)
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>))
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const lines = b.split('\n')
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l)))
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>
              ))}
            </ul>
          )
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(b)}
          </p>
        )
      })}
    </div>
  )
}

export function AssistantPage() {
  const { isManager } = useAuth()
  const ai = useAiStatus()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [draft, setDraft] = useState<Msg['draft']>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])
  const send = useMutation({
    mutationFn: (message: string) =>
      api<{ answer: string; toolsUsed: { tool: string; ok: boolean }[]; draft: Msg['draft'] }>('/ai/chat', {
        body: {
          message,
          history: messages
            .filter((m) => !m.error)
            .slice(-10)
            .map((m) => ({ role: m.role, content: m.content })),
        },
      }),
    onSuccess: (r) => setMessages((m) => [...m, { role: 'assistant', content: r.answer, tools: r.toolsUsed, draft: r.draft }]),
    onError: (e) => setMessages((m) => [...m, { role: 'assistant', content: errorMessage(e), error: true }]),
  })
  const ask = (text: string) => {
    if (!text.trim() || send.isPending) return
    setMessages((m) => [...m, { role: 'user', content: text.trim() }])
    setInput('')
    send.mutate(text.trim())
  }
  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col">
      <PageHeader
        title="AI assistant"
        description="Answers come only from your WorkPulse data, through tools that respect your permissions. It can draft tasks; it never changes anything on its own."
      />
      <Card className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {!ai.data?.configured ? (
            <EmptyState icon={<Bot />} title="AI is not configured" description={ai.data?.reason ?? ''} />
          ) : messages.length === 0 ? (
            <div className="mx-auto max-w-xl py-8 text-center">
              <Bot className="mx-auto size-8 text-primary" />
              <p className="mt-3 text-sm font-medium">Ask about your work</p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {[...SUGGESTIONS, ...(isManager ? MANAGER_SUGGESTIONS : [])].map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="rounded-full border border-line-strong px-3 py-1.5 text-xs text-ink-soft hover:border-primary hover:text-primary"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${m.role === 'user' ? 'bg-primary text-white' : m.error ? 'bg-danger-soft text-danger' : 'border border-line bg-surface text-ink'}`}
                >
                  {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
                  {m.tools && m.tools.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {m.tools.map((t, j) => (
                        <Badge key={j} tone={t.ok ? 'neutral' : 'amber'}>
                          <Wrench className="size-3" /> {t.tool.replace(/_/g, ' ')}
                          {t.ok ? '' : ' (no access)'}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {m.draft && (
                    <div className="mt-2 rounded-lg border border-line bg-canvas p-2 text-ink">
                      <p className="text-xs text-muted">Task draft</p>
                      <p className="font-medium">{m.draft.title}</p>
                      <Button size="sm" className="mt-1.5" onClick={() => setDraft(m.draft)}>
                        Review and create
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {send.isPending && (
            <div className="flex justify-start">
              <div className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-muted">Looking at your data…</div>
            </div>
          )}
          <div ref={end} />
        </div>
        <form
          className="flex gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault()
            ask(input)
          }}
        >
          <Textarea
            aria-label="Message"
            rows={1}
            className="min-h-10 resize-none"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ask(input)
              }
            }}
            placeholder="Ask about tasks, goals, impact, blockers…"
            disabled={!ai.data?.configured}
          />
          <Button type="submit" disabled={!input.trim() || !ai.data?.configured} loading={send.isPending} aria-label="Send">
            <Send />
          </Button>
        </form>
      </Card>
      {draft && (
        <CreateTaskDialog
          open
          onOpenChange={(o) => !o && setDraft(null)}
          defaults={{
            title: draft.title,
            description: draft.description ?? '',
            priority: draft.priority,
            dueAt: draft.dueDate ?? '',
            category: draft.category ?? '',
            impactLevel: draft.suggestedImpact,
            estimateMins: draft.estimateMins ? String(draft.estimateMins) : '',
          }}
        />
      )}
    </div>
  )
}
