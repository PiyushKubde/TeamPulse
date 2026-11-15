import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { createOrgSchema, forgotPasswordSchema, loginSchema, passwordSchema, registerSchema, requiredPhoneSchema } from '@workpulse/shared'
import { api, errorMessage } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { Button, Card, Field, Input, Spinner } from '@/components/ui'

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold tracking-tight">WorkPulse</span>
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </Card>
        {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
        <p className="mt-6 text-center text-xs text-muted">One workspace. Every task. Measurable impact.</p>
      </div>
    </div>
  )
}

/** Required mobile number: WorkPulse invites it to M91 so urgent things ring this person's phone. */
function PhoneField({ error, register }: { error?: string; register: ReturnType<ReturnType<typeof useForm>['register']> }) {
  return (
    <Field
      label="Mobile number"
      htmlFor="phone"
      error={error}
      hint="For urgent alerts only, like a critical task assigned to you. You’ll accept the invitation in the M91 app."
    >
      <Input id="phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210" {...register} />
    </Field>
  )
}

const FormError = ({ message }: { message: string | null }) =>
  message ? (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </p>
  ) : null

export function LoginPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const f = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) })
  const submit = f.handleSubmit(async (v) => {
    setError(null)
    try {
      await api('/auth/login', { body: v })
      await refresh()
      navigate(params.get('next') ?? '/')
    } catch (e) {
      setError(errorMessage(e))
    }
  })
  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back."
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Email" htmlFor="email" error={f.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...f.register('email')} aria-invalid={!!f.formState.errors.email} />
        </Field>
        <Field label="Password" htmlFor="password" error={f.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" {...f.register('password')} />
        </Field>
        <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>
          Sign in
        </Button>
        <Link to="/forgot-password" className="block text-center text-sm text-primary hover:underline">
          Forgot your password?
        </Link>
      </form>
    </AuthLayout>
  )
}

export function RegisterPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const f = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) })
  const submit = f.handleSubmit(async (v) => {
    setError(null)
    try {
      await api('/auth/register', { body: v })
      await api('/me', { method: 'PATCH', body: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }).catch(() => undefined)
      await refresh()
      navigate('/onboarding')
    } catch (e) {
      setError(errorMessage(e))
    }
  })
  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start measuring the value of work, not the volume."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Full name" htmlFor="name" error={f.formState.errors.name?.message}>
          <Input id="name" autoComplete="name" {...f.register('name')} />
        </Field>
        <Field label="Work email" htmlFor="email" error={f.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...f.register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={f.formState.errors.password?.message} hint="At least 10 characters with a letter and a number.">
          <Input id="password" type="password" autoComplete="new-password" {...f.register('password')} />
        </Field>
        <PhoneField error={f.formState.errors.phone?.message} register={f.register('phone')} />
        <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  )
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false)
  const f = useForm<z.infer<typeof forgotPasswordSchema>>({ resolver: zodResolver(forgotPasswordSchema) })
  const submit = f.handleSubmit(async (v) => {
    await api('/auth/forgot-password', { body: v })
    setSent(true)
  })
  return (
    <AuthLayout
      title="Reset your password"
      footer={
        <Link to="/login" className="text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p className="text-sm text-ink-soft">If an account exists for that email, a reset link is on its way. It expires in one hour.</p>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Email" htmlFor="email" error={f.formState.errors.email?.message}>
            <Input id="email" type="email" {...f.register('email')} />
          </Field>
          <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}

const resetForm = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: 'Passwords do not match', path: ['confirm'] })

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const f = useForm<z.infer<typeof resetForm>>({ resolver: zodResolver(resetForm) })
  const submit = f.handleSubmit(async (v) => {
    try {
      await api('/auth/reset-password', { body: { token: params.get('token') ?? '', password: v.password } })
      navigate('/login')
    } catch (e) {
      setError(errorMessage(e))
    }
  })
  return (
    <AuthLayout title="Choose a new password">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="New password" htmlFor="password" error={f.formState.errors.password?.message}>
          <Input id="password" type="password" autoComplete="new-password" {...f.register('password')} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm" error={f.formState.errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" {...f.register('confirm')} />
        </Field>
        <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>
          Save password
        </Button>
      </form>
    </AuthLayout>
  )
}

export function VerifyEmailPage() {
  const [params] = useSearchParams()
  const { refresh } = useAuth()
  const [state, setState] = useState<'working' | 'done' | 'error'>('working')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    api('/auth/verify-email', { body: { token: params.get('token') ?? '' } })
      .then(() => {
        setState('done')
        return refresh()
      })
      .catch((e) => {
        setState('error')
        setMsg(errorMessage(e))
      })
  }, [params, refresh])
  return (
    <AuthLayout
      title="Verify email"
      footer={
        <Link to="/" className="text-primary hover:underline">
          Continue to WorkPulse
        </Link>
      }
    >
      {state === 'working' ? (
        <Spinner label="Verifying" />
      ) : state === 'done' ? (
        <p className="text-sm text-success">Your email address is verified.</p>
      ) : (
        <p className="text-sm text-danger">{msg}</p>
      )}
    </AuthLayout>
  )
}

export function AcceptInvitePage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const { me, refresh } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const inv = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<{ email: string; organization: string; role: string; hasAccount: boolean }>('/invitations/lookup', { query: { token } }),
    retry: false,
  })
  const f = useForm<{ name: string; password: string; phone: string }>({
    resolver: zodResolver(z.object({ name: z.string().trim().min(1, 'Required'), password: passwordSchema, phone: requiredPhoneSchema })),
  })
  const accept = async (body: Record<string, string>) => {
    setError(null)
    try {
      await api('/invitations/accept', { body: { token, ...body } })
      await refresh()
      navigate('/')
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  if (inv.isLoading)
    return (
      <AuthLayout title="Invitation">
        <Spinner />
      </AuthLayout>
    )
  if (inv.error || !inv.data)
    return (
      <AuthLayout title="Invitation">
        <p className="text-sm text-danger">This invitation is invalid or has expired. Ask for a new one.</p>
      </AuthLayout>
    )
  const d = inv.data
  return (
    <AuthLayout title={`Join ${d.organization}`} subtitle={`You were invited as ${d.role.toLowerCase()} (${d.email}).`}>
      <FormError message={error} />
      {me ? (
        me.user.email === d.email ? (
          <Button className="mt-2 w-full" onClick={() => accept({})}>
            Accept invitation
          </Button>
        ) : (
          <p className="text-sm text-ink-soft">
            You are signed in as {me.user.email}. Sign out and sign in as {d.email} to accept.
          </p>
        )
      ) : d.hasAccount ? (
        <Button className="w-full" onClick={() => navigate(`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`)}>
          Sign in to accept
        </Button>
      ) : (
        <form onSubmit={f.handleSubmit((v) => accept(v))} className="space-y-4" noValidate>
          <Field label="Full name" htmlFor="name" error={f.formState.errors.name?.message}>
            <Input id="name" {...f.register('name')} />
          </Field>
          <Field label="Choose a password" htmlFor="password" error={f.formState.errors.password?.message}>
            <Input id="password" type="password" autoComplete="new-password" {...f.register('password')} />
          </Field>
          <PhoneField error={f.formState.errors.phone?.message} register={f.register('phone')} />
          <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>
            Create account and join
          </Button>
        </form>
      )}
    </AuthLayout>
  )
}

export function OnboardingPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const f = useForm<z.infer<typeof createOrgSchema>>({ resolver: zodResolver(createOrgSchema) })
  const submit = f.handleSubmit(async (v) => {
    try {
      await api('/organizations', { body: v })
      await refresh()
      navigate('/')
    } catch (e) {
      setError(errorMessage(e))
    }
  })
  return (
    <AuthLayout title="Create your organization" subtitle="You’ll be its owner. Invite your team next.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Organization name" htmlFor="org" error={f.formState.errors.name?.message}>
          <Input id="org" placeholder="Acme Inc." {...f.register('name')} />
        </Field>
        <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>
          Create organization
        </Button>
        <p className="text-center text-xs text-muted">Joining an existing team? Use the invitation link you received.</p>
      </form>
    </AuthLayout>
  )
}
