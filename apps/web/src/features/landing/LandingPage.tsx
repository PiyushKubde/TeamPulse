// KONVO public landing page. Static content only; every claim describes something the product does today.
// The hero example is labelled as an illustration with sample data.
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  BellRing,
  FileCheck2,
  GitBranch,
  Lightbulb,
  MessageSquare,
  Scale,
  Sparkles,
  Target,
  UserCheck,
  EyeOff,
  AlertCircle,
  LayoutGrid,
  BarChart3,
} from 'lucide-react'
import { BRAND, LogoMark } from '@/components/brand'
import { ThemeToggle } from '@/components/ThemeToggle'
import './landing.css'

const LINKS = [
  ['lp-product', 'Product'],
  ['lp-how', 'How it works'],
  ['lp-capabilities', 'Features'],
  ['lp-benefits', 'For teams'],
] as const

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })

const Icon = ({ children }: { children: ReactNode }) => <div className="lp-icon [&_svg]:size-5 [&_svg]:stroke-[1.6]">{children}</div>

function Nav() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const go = (id: string) => {
    scrollTo(id)
    setOpen(false)
  }
  return (
    <header className={`lp-nav ${scrolled ? 'lp-nav-scrolled' : ''}`}>
      <div className="lp-nav-inner">
        <Link className="lp-logo" to="/" aria-label={`${BRAND.name} home`}>
          <LogoMark size={28} />
          <span className="wordmark">{BRAND.name}</span>
        </Link>
        <nav className="lp-nav-links" aria-label="Landing navigation">
          {LINKS.map(([id, label]) => (
            <button key={id} className="lp-nav-link" onClick={() => go(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="lp-nav-cta">
          <Link className="lp-nav-signin" to="/login">
            Log in
          </Link>
          <Link className="lp-btn-primary" to="/register">
            Get started
          </Link>
        </div>
        <ThemeToggle className="lp-theme-toggle" />
        <button
          className="lp-menu-btn"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="lp-mobile-nav"
          onClick={() => setOpen((o) => !o)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <line x1="3" y1="7" x2="21" y2="7" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="17" x2="21" y2="17" />
          </svg>
        </button>
      </div>
      <div className="lp-mobile-nav" id="lp-mobile-nav" hidden={!open}>
        {LINKS.map(([id, label]) => (
          <button key={id} className="lp-nav-link" onClick={() => go(id)}>
            {label}
          </button>
        ))}
        <Link className="lp-nav-link" to="/login">
          Log in
        </Link>
        <Link className="lp-btn-primary lp-mobile-cta" to="/register">
          Get started
        </Link>
      </div>
    </header>
  )
}

/** The product look in miniature: a Slack message becomes a task, assigned to the best fit with the reason. Sample data. */
function Preview() {
  const rungs = [
    ['Assigned', 'Best fit, with the reason', 1],
    ['Planned', 'In today’s plan', 2],
    ['Evidenced', 'Pull request linked', 3],
    ['Impact', 'Counted toward a goal', 4],
  ] as const
  return (
    <div className="lp-pv">
      <div className="lp-pv-bar">
        <strong>From conversation to contribution</strong>
        <span>Illustrative example · sample data</span>
      </div>
      <div className="lp-pv-body">
        <div className="lp-pv-col">
          <div className="lp-pv-label">1 · A conversation</div>
          <div className="lp-pv-msg">
            <div className="lp-pv-avatar">D</div>
            <div>
              <div className="lp-pv-msg-head">
                Dana<span>#payments</span>
              </div>
              <p>We need someone to look into the failing card payments before Friday’s release, it’s blocking checkout.</p>
            </div>
          </div>
        </div>
        <div className="lp-pv-col">
          <div className="lp-pv-label">2 · A task with the right owner</div>
          <div className="lp-pv-task">
            <span className="lp-pv-badge">High priority</span>
            <div className="lp-pv-task-title">Fix failing card payments before the release</div>
            <dl className="lp-pv-meta">
              <dt>From</dt>
              <dd>Slack · Dana</dd>
              <dt>Owner</dt>
              <dd>Priya, assigned automatically</dd>
              <dt>Why Priya</dt>
              <dd>Shipped the last two payment fixes; lightest load on the team</dd>
              <dt>Due</dt>
              <dd>Thursday, 18:00</dd>
            </dl>
            <div className="lp-pv-actions">
              <span className="lp-pv-btn primary">Start</span>
              <span className="lp-pv-btn">Add evidence</span>
              <span className="lp-pv-btn">Reassign</span>
            </div>
          </div>
        </div>
      </div>
      <div className="lp-pv-ladder">
        {rungs.map(([name, text, n]) => (
          <div key={name} className="lp-rung" data-n={n}>
            <b>
              {name}
              <span className="lp-bars">
                <i />
                <i />
                <i />
                <i />
              </span>
            </b>
            <span>{text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Section({ id, eyebrow, title, sub, children }: { id: string; eyebrow: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="lp-section" id={id}>
      <div className="lp-container">
        <div className="lp-section-header">
          <div className="lp-eyebrow">{eyebrow}</div>
          <h2 className="lp-section-headline">{title}</h2>
          {sub && <p className="lp-section-sub">{sub}</p>}
        </div>
        {children}
      </div>
    </section>
  )
}

const Cells = ({ cols, items }: { cols: 2 | 3; items: readonly (readonly [ReactNode, string, string])[] }) => (
  <div className={`lp-grid cols-${cols}`}>
    {items.map(([lead, title, text]) => (
      <div key={title} className="lp-cell">
        {lead}
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    ))}
  </div>
)

const PROBLEMS = [
  [<EyeOff key="i" />, 'Important work stays invisible', 'Unblocking others, reviews and shared ownership are hard to see in a task list.'],
  [<AlertCircle key="i" />, 'Blockers go unnoticed', 'Managers often find out about stuck work too late to help.'],
  [<LayoutGrid key="i" />, 'Work is scattered', 'Requests live in Slack threads, Linear, Jira and GitHub, so nobody sees the whole picture.'],
  [<BarChart3 key="i" />, 'Credit is hard to attribute', 'Who did what, and how much it mattered, is rarely captured fairly.'],
] as const

const STEPS = [
  [
    '01',
    'Conversation',
    'Work starts where people already talk. A Slack message, or an issue in Linear, Jira or GitHub, arrives on its own. Ordinary chat is ignored.',
  ],
  ['02', 'Task', 'AI turns it into a task and assigns the best fit by role, recent work and current load. The reason is written down, so anyone can check it.'],
  ['03', 'Evidence', 'Pull requests, documents and links attach to the task. Managers verify outcomes; unverified work counts for less until they do.'],
  ['04', 'Impact', 'Each week KONVO explains every person’s impact from priority, quality, goal alignment, reliability and evidence. Never from task counts.'],
] as const

const CAPABILITIES = [
  [
    <MessageSquare key="i" />,
    'Tasks from every tool',
    'Slack messages, Linear, Jira and GitHub issues become tasks automatically, and stay in sync as they change.',
  ],
  [
    <UserCheck key="i" />,
    'Automatic assignment',
    'Every task goes to the person who fits it best, with the reason recorded. Name someone and it goes to them.',
  ],
  [<Target key="i" />, 'Goals and OKRs', 'Link work to goals and key results, and see which work actually moves them.'],
  [<Scale key="i" />, 'Explainable performance', 'Weekly impact from five dimensions with weights you set. Every number shows how it was reached.'],
  [
    <BellRing key="i" />,
    'Phone alerts that get answered',
    'Critical moments ring the right phone through M91, even on silent. The answer comes back and KONVO acts on it.',
  ],
  [<Sparkles key="i" />, 'An AI assistant on your data', 'Ask about your team’s work, or say what needs doing and it creates and assigns the task.'],
] as const

const PRINCIPLES = [
  [
    <div key="n" className="lp-rule-num">
      01
    </div>,
    'Work volume is not work value.',
    'Closing more tasks never raises a score. Impact is weighted by priority and complexity.',
  ],
  [
    <div key="n" className="lp-rule-num">
      02
    </div>,
    'Evidence over assumption.',
    'Work backed by evidence and verified by a manager counts in full. Unverified work counts half.',
  ],
  [
    <div key="n" className="lp-rule-num">
      03
    </div>,
    'A blocker is not a failure.',
    'A deadline missed because of an external blocker is excused, and the reason stays with the work.',
  ],
] as const

const EMPLOYEES = [
  'Make meaningful work visible to your manager and team',
  'Plan your day from the tasks that matter most',
  'Show the evidence behind your contributions',
  'Raise blockers early and get help sooner',
  'Ask for a correction when a record is wrong',
]
const MANAGERS = [
  'See what the team is working on and where people need help',
  'Let tasks route themselves to the right person',
  'Spot blockers and overload before they derail delivery',
  'Review evidence and verify outcomes with confidence',
  'Send weekly reports to Slack or email automatically',
]

const Benefit = ({ label, title, items }: { label: string; title: string; items: string[] }) => (
  <div className="lp-benefit-col">
    <div className="lp-benefit-label">{label}</div>
    <h3>{title}</h3>
    <ul className="lp-benefit-list">
      {items.map((b) => (
        <li key={b}>
          <span className="lp-check" aria-hidden="true" />
          {b}
        </li>
      ))}
    </ul>
  </div>
)

export function LandingPage() {
  useEffect(() => {
    document.title = `${BRAND.name} — ${BRAND.category}`
  }, [])
  return (
    <div className="lp">
      <Nav />
      <main id="main" tabIndex={-1}>
        <section className="lp-hero" id="lp-product">
          <div className="lp-container">
            <div className="lp-hero-content">
              <div className="lp-eyebrow">{BRAND.category}</div>
              <h1 className="lp-headline">
                Work moves forward. <span>Every contribution counts.</span>
              </h1>
              <p className="lp-tagline">{BRAND.tagline}</p>
              <p className="lp-subhead">
                Messages and issues from the tools your team already uses become tasks with the right owner, automatically. Goals, evidence and explainable
                impact show what was actually achieved, not how many boxes were ticked.
              </p>
              <div className="lp-hero-actions">
                <Link className="lp-btn-primary lp-btn-lg" to="/register">
                  Get started
                </Link>
                <button className="lp-btn-ghost lp-btn-lg" onClick={() => scrollTo('lp-how')}>
                  See how it works
                </button>
              </div>
            </div>
            <div className="lp-hero-preview" aria-hidden="true">
              <Preview />
            </div>
          </div>
        </section>

        <Section
          id="lp-problem"
          eyebrow="The problem"
          title="Work volume is not work value."
          sub="Completing more tasks does not always mean creating more value. The work that moves teams forward is often invisible to the people who most need to see it."
        >
          <Cells cols={2} items={PROBLEMS.map(([ic, t, d]) => [<Icon key="i">{ic}</Icon>, t, d] as const)} />
        </Section>

        <Section id="lp-how" eyebrow="How it works" title={BRAND.tagline} sub="Four steps from a message to a contribution everyone can see and check.">
          <div className="lp-steps">
            {STEPS.map(([n, title, text]) => (
              <div key={n} className="lp-step">
                <div className="lp-step-num">{n}</div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="lp-capabilities" eyebrow="Features" title="Everything a team needs to understand its work">
          <Cells cols={3} items={CAPABILITIES.map(([ic, t, d]) => [<Icon key="i">{ic}</Icon>, t, d] as const)} />
          <p className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[var(--text-3)]">
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="size-4" /> Linear · Jira · GitHub · Slack · Gmail
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileCheck2 className="size-4" /> Daily planner, reports and an Automation Center
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Lightbulb className="size-4" /> Feedback, reviews and corrections
            </span>
          </p>
        </Section>

        <Section id="lp-principles" eyebrow="Principles" title="Built to be fair to the people doing the work">
          <Cells cols={3} items={PRINCIPLES} />
        </Section>

        <Section id="lp-benefits" eyebrow="For teams" title="Built for how real teams work">
          <div className="lp-grid cols-2">
            <Benefit label="For employees" title="Your work, accurately represented" items={EMPLOYEES} />
            <Benefit label="For managers" title="Your team, clearly understood" items={MANAGERS} />
          </div>
        </Section>

        <section className="lp-cta-section">
          <div className="lp-container">
            <div className="lp-cta-inner">
              <h2>{BRAND.tagline}</h2>
              <p>{BRAND.hero}</p>
              <Link className="lp-btn-primary lp-btn-lg" to="/register">
                Get started
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-footer-grid">
            <div className="lp-footer-brand">
              <Link className="lp-logo" to="/" aria-label={`${BRAND.name} home`}>
                <LogoMark size={28} />
                <span className="wordmark">{BRAND.name}</span>
              </Link>
              <p>
                {BRAND.category}
                <br />
                {BRAND.tagline}
              </p>
            </div>
            <div className="lp-footer-links">
              <div className="lp-footer-col">
                <div className="lp-footer-col-title">Product</div>
                {LINKS.map(([id, label]) => (
                  <button key={id} className="lp-footer-link" onClick={() => scrollTo(id)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="lp-footer-col">
                <div className="lp-footer-col-title">Account</div>
                <Link className="lp-footer-link" to="/login">
                  Log in
                </Link>
                <Link className="lp-footer-link" to="/register">
                  Get started
                </Link>
              </div>
            </div>
          </div>
          <div className="lp-footer-bottom">
            <span>
              © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}
