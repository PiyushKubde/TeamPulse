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
import { BRAND, Logo } from '@/components/brand'

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-7 flex justify-center" aria-label="KONVO home">
          <Logo size={32} />
        </Link>
        <Card className="p-6">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </Card>
        {footer && <div className="mt-4 text-center text-sm text-muted">{footer}</div>}
        <p className="mt-6 text-center text-xs text-muted">{BRAND.tagline}</p>
      </div>
    </div>
  )
}

/** Required mobile number: KONVO invites it to M91 so urgent things ring this person's phone. */
function PhoneField({ error, register }: { error?: string; register: ReturnType<ReturnType<typeof useForm>['register']> }) {
  return (
    <Field
      label="Mobile number"
      htmlFor="phone"
      error={error}
      hint="For urgent alerts only, like a critical task assigned to you. We send an invitation to the M91 app on this number; accept it once."
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

/** "Continue with Google", shown only when the server has Google sign-in set up. Creates the account on first use. */
function GoogleButton({ returnTo }: { returnTo: string }) {
  const p = useQuery({ queryKey: ['auth-providers'], queryFn: () => api<{ google: boolean }>('/auth/providers'), staleTime: Infinity, retry: false })
  if (!p.data?.google) return null
  return (
    <>
      <a
        href={`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`}
        className="flex h-11 w-full items-center justify-center gap-2.5 rounded-md border border-line-strong bg-surface text-[15px] font-semibold text-ink shadow-xs transition-colors hover:bg-hover"
      >
        <svg viewBox="0 0 48 48" className="size-[18px]" aria-hidden="true">
          <path
            fill="#FFC107"
            d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
          />
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
          <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
        </svg>
        Continue with Google
      </a>
      <div className="my-4 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-line" />
        or with email
        <span className="h-px flex-1 bg-line" />
      </div>
    </>
  )
}

export function LoginPage() {
  const { refresh } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [error, setError] = useState<string | null>(params.get('error'))
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
      <GoogleButton returnTo={params.get('next') ?? '/'} />
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
      <GoogleButton returnTo="/onboarding" />
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
          Continue to KONVO
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
    queryFn: () =>
      api<{ email: string; organization: string; role: string; hasAccount: boolean; phone: string | null }>('/invitations/lookup', { query: { token } }),
    retry: false,
  })
  const f = useForm<{ name: string; password: string; phone: string }>({
    resolver: zodResolver(z.object({ name: z.string().trim().min(1, 'Required'), password: passwordSchema, phone: requiredPhoneSchema })),
  })
  // The inviter may already have given this person's number: pre-fill it.
  useEffect(() => {
    if (inv.data?.phone && !f.getValues('phone')) f.setValue('phone', inv.data.phone)
  }, [inv.data?.phone, f])
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
        <>
          <GoogleButton returnTo={`/accept-invite?token=${token}`} />
          <Button className="w-full" onClick={() => navigate(`/login?next=${encodeURIComponent(`/accept-invite?token=${token}`)}`)}>
            Sign in to accept
          </Button>
        </>
      ) : (
        <>
          <GoogleButton returnTo={`/accept-invite?token=${token}`} />
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
        </>
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

/** One required step for anyone signed in without a mobile number (Google sign-ups, older accounts). Saving it sends
 *  the M91 invitation, so urgent alerts can reach this person. */
export function PhoneStep() {
  const { me, refresh } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const f = useForm<{ phone: string }>({ resolver: zodResolver(z.object({ phone: requiredPhoneSchema })) })
  const submit = f.handleSubmit(async (v) => {
    setError(null)
    try {
      await api('/me/phone', { method: 'PUT', body: v })
      await refresh()
    } catch (e) {
      setError(errorMessage(e))
    }
  })
  return (
    <AuthLayout
      title="Add your mobile number"
      subtitle={`One last step, ${me?.user.name.split(' ')[0] ?? 'there'}. KONVO rings this phone only when something needs you now.`}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <PhoneField error={f.formState.errors.phone?.message} register={f.register('phone')} />
        <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>
          Continue
        </Button>
      </form>
    </AuthLayout>
  )
}
