import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { AlertTriangle, Info, Loader2, RefreshCw } from 'lucide-react'
import { cn, initials } from '@/lib/utils'
import { Tip } from './overlay'

// ───────────── Button ─────────────

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent text-sm font-semibold transition-colors active:translate-y-px disabled:pointer-events-none disabled:opacity-55 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'border-primary bg-primary text-on-primary shadow-xs hover:bg-primary-hover',
        secondary: 'border-line-strong bg-surface text-ink shadow-xs hover:bg-hover',
        ghost: 'text-ink-soft hover:bg-hover hover:text-ink',
        danger: 'border-danger-solid bg-danger-solid text-white hover:bg-danger-solid/90',
        teal: 'bg-primary-soft text-primary hover:bg-primary-soft/70',
        link: 'border-0 px-0 text-primary underline-offset-4 hover:underline',
      },
      size: { sm: 'h-[30px] px-[11px] text-[13px] [&_svg]:size-3.5', md: 'h-9 px-3.5', lg: 'h-11 px-[22px] text-[15px]', icon: 'size-9' },
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
  'w-full rounded-md border border-line-strong bg-surface px-[11px] text-sm text-ink transition-[border-color,box-shadow] placeholder:text-muted hover:border-muted/60 focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/30 disabled:bg-canvas aria-[invalid=true]:border-danger'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(control, 'h-[38px]', className)} {...p} />
))
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-[84px] py-2', className)} {...p} />
))
Textarea.displayName = 'Textarea'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} className={cn(control, 'h-[38px] pr-8', className)} {...p}>
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
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
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
    <div className={cn('rounded-lg border border-line bg-surface shadow-xs', className)} {...p}>
      {children}
    </div>
  )
}

export function CardHeader({ title, description, action, info }: { title: ReactNode; description?: ReactNode; action?: ReactNode; info?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-[-0.015em] text-ink">
          {title}
          {info && <InfoTip text={info} />}
        </h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
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
  neutral: 'bg-teal-soft text-ink-soft',
  blue: 'bg-primary-soft text-primary',
  teal: 'bg-teal-soft text-teal',
  green: 'bg-success-soft text-success',
  amber: 'bg-warn-soft text-warn',
  red: 'bg-danger-soft text-danger',
  violet: 'bg-violet-soft text-violet',
} as const
export type Tone = keyof typeof badgeTones

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex min-h-[22px] items-center gap-1 rounded-sm border border-transparent px-2 text-xs font-semibold leading-4 whitespace-nowrap',
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
      className={cn(
        'inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary-soft text-[11.5px] font-semibold tracking-[0.02em] text-primary',
        className,
      )}
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
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 flex-[1_1_360px]">
        <h1 className="text-2xl font-semibold tracking-[-0.03em] text-ink">{title}</h1>
        {description && <p className="mt-1.5 max-w-[72ch] text-[15px] text-muted">{description}</p>}
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
    <Card className={cn('relative p-0', onClick && 'transition-colors hover:border-line-strong')}>
      {onClick && <button type="button" onClick={onClick} aria-label={`${l}: show details`} className="absolute inset-0 z-0 rounded-lg" />}
      <div className="pointer-events-none relative px-4 py-3.5">
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
              'tabular text-2xl font-semibold tracking-[-0.02em]',
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
    <div role="radiogroup" aria-label={aria} className="inline-flex rounded-md border border-line-strong bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-semibold [&_svg]:size-3.5',
            value === o.value ? 'bg-primary-soft text-ink' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
