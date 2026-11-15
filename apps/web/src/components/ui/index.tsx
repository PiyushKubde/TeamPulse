import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-react'
import { cn, initials } from '@/lib/utils'
import { Tip } from './overlay'

// ───────────── Button ─────────────

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-white shadow-sm hover:bg-primary/90',
        secondary: 'border border-line-strong bg-surface text-ink hover:bg-canvas',
        ghost: 'text-ink-soft hover:bg-canvas hover:text-ink',
        danger: 'bg-danger text-white hover:bg-danger/90',
        teal: 'bg-teal text-white hover:bg-teal/90',
        link: 'text-primary underline-offset-4 hover:underline px-0',
      },
      size: { sm: 'h-8 px-2.5 text-xs', md: 'h-9 px-3.5', lg: 'h-10 px-5', icon: 'size-9' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading && <Loader2 className="animate-spin" aria-hidden />}
    {children}
  </button>
))
Button.displayName = 'Button'

// ───────────── Form controls ─────────────

const control =
  'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-canvas aria-[invalid=true]:border-danger'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(control, 'h-9', className)} {...p} />
))
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-20 py-2', className)} {...p} />
))
Textarea.displayName = 'Textarea'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} className={cn(control, 'h-9 pr-8', className)} {...p}>
    {children}
  </select>
))
Select.displayName = 'Select'

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-ink-soft">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  )
}

// ───────────── Surfaces ─────────────

export function Card({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(15,27,51,0.04)]', className)} {...p}>
      {children}
    </div>
  )
}

export function CardHeader({ title, description, action, info }: { title: ReactNode; description?: ReactNode; action?: ReactNode; info?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          {title}
          {info && <InfoTip text={info} />}
        </h2>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function InfoTip({ text }: { text: string }) {
  return (
    <Tip content={text}>
      <button type="button" className="text-muted hover:text-ink" aria-label="What does this mean?">
        <Info className="size-3.5" />
      </button>
    </Tip>
  )
}

// ───────────── Status ─────────────

const badgeTones = {
  neutral: 'bg-canvas text-ink-soft border-line',
  blue: 'bg-primary-soft text-primary border-primary/15',
  teal: 'bg-teal-soft text-teal border-teal/15',
  green: 'bg-success-soft text-success border-success/15',
  amber: 'bg-warn-soft text-warn border-warn/20',
  red: 'bg-danger-soft text-danger border-danger/15',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
} as const
export type Tone = keyof typeof badgeTones

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap',
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export const STATUS_TONE: Record<string, Tone> = {
  BACKLOG: 'neutral',
  TODO: 'neutral',
  IN_PROGRESS: 'blue',
  IN_REVIEW: 'violet',
  BLOCKED: 'red',
  COMPLETED: 'green',
  CANCELLED: 'neutral',
}
export const PRIORITY_TONE: Record<string, Tone> = { CRITICAL: 'red', HIGH: 'amber', MEDIUM: 'blue', LOW: 'neutral' }
export const IMPACT_TONE: Record<string, Tone> = { CRITICAL: 'violet', HIGH: 'teal', MEDIUM: 'blue', LOW: 'neutral', NONE: 'neutral' }
export const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11px] font-semibold text-primary', className)}
    >
      {initials(name)}
    </span>
  )
}

export function Progress({ value, tone = 'blue', label: aria }: { value: number; tone?: 'blue' | 'teal' | 'green' | 'amber' | 'red'; label?: string }) {
  const color = { blue: 'bg-primary', teal: 'bg-teal', green: 'bg-success', amber: 'bg-warn', red: 'bg-danger' }[tone]
  return (
    <div
      role="progressbar"
      aria-label={aria}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-line"
    >
      <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

// ───────────── Loading / empty / error ─────────────

export const Skeleton = ({ className }: { className?: string }) => <div className={cn('animate-pulse rounded-md bg-line/70', className)} />

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" /> {label}…
    </div>
  )
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 rounded-full bg-canvas p-3 text-muted [&_svg]:size-5">{icon}</div>}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-sm text-xs text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong.'
  return (
    <div role="alert" className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="rounded-full bg-danger-soft p-3 text-danger">
        <AlertTriangle className="size-5" />
      </div>
      <p className="text-sm font-medium text-ink">Couldn’t load this</p>
      <p className="max-w-sm text-xs text-muted">{msg}</p>
      {retry && (
        <Button variant="secondary" size="sm" onClick={retry}>
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  )
}

/** Wraps a query: skeleton while loading, an error state with retry, else the content. */
export function QueryState<T>({
  q,
  skeleton,
  children,
}: {
  q: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown }
  skeleton?: ReactNode
  children: (data: T) => ReactNode
}) {
  if (q.isLoading) return <>{skeleton ?? <Spinner />}</>
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  if (q.data === undefined) return null
  return <>{children(q.data)}</>
}

// ───────────── Page layout ─────────────

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function KpiCard({
  label: l,
  value,
  unit,
  hint,
  info,
  tone,
  onClick,
  footer,
}: {
  label: string
  value: ReactNode
  unit?: string
  hint?: ReactNode
  info?: string
  tone?: Tone
  onClick?: () => void
  footer?: ReactNode
}) {
  // The whole card is clickable through a stretched button; the info tip sits above it, so no control is nested in another.
  return (
    <Card className={cn('relative p-0', onClick && 'transition hover:border-primary/40 hover:shadow-sm')}>
      {onClick && <button type="button" onClick={onClick} aria-label={`${l}: show details`} className="absolute inset-0 z-0 rounded-xl" />}
      <div className="pointer-events-none relative p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
          {l}
          {info && (
            <span className="pointer-events-auto relative z-10">
              <InfoTip text={info} />
            </span>
          )}
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span
            className={cn(
              'tabular text-2xl font-semibold tracking-tight',
              tone === 'red' ? 'text-danger' : tone === 'amber' ? 'text-warn' : tone === 'green' ? 'text-success' : 'text-ink',
            )}
          >
            {value}
          </span>
          {unit && <span className="text-xs text-muted">{unit}</span>}
        </div>
        {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
      </div>
      {footer && <div className="relative border-t border-line px-4 py-2 text-xs text-muted">{footer}</div>}
    </Card>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label: aria,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={aria} className="inline-flex rounded-lg border border-line-strong bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium [&_svg]:size-3.5',
            value === o.value ? 'bg-primary-soft text-primary' : 'text-ink-soft hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
