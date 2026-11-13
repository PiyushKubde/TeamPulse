/* KONVO public landing page. No user data is interpolated here — all content is static, and every claim describes
   something the product does today. The example in the hero is labelled as an illustration with sample data. */
import { BRAND, logoMark } from '../brand.js'

const icon = (paths) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const ICONS = {
  message: icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  owner: icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  evidence: icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  journey: icon('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8.2 7.2 15.8 10.8M15.8 13.2 8.2 16.8"/>'),
  alert: icon('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
  ai: icon('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>'),
  eye: icon('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'),
  stuck: icon('<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
  context: icon('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>'),
  credit: icon('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>')
}

const LINKS = [['lp-product', 'Product'], ['lp-how', 'How it works'], ['lp-capabilities', 'Features'], ['lp-benefits', 'For teams']]

function lpNav() {
  return `<header class="lp-nav" id="lp-nav">
    <div class="lp-nav-inner">
      <a class="lp-logo" href="/" aria-label="${BRAND.name} home">${logoMark(28)}<span class="wordmark">${BRAND.name}</span></a>
      <nav class="lp-nav-links" aria-label="Landing navigation">
        ${LINKS.map(([id, label]) => `<button class="lp-nav-link" data-scroll="${id}">${label}</button>`).join('')}
      </nav>
      <div class="lp-nav-cta">
        <a class="lp-nav-signin" href="#/login">Log in</a>
        <a class="lp-btn-primary" href="#/signup">Get started</a>
      </div>
      <button class="lp-menu-btn" id="lp-menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="lp-mobile-nav">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/></svg>
      </button>
    </div>
    <div class="lp-mobile-nav" id="lp-mobile-nav" hidden>
      ${LINKS.map(([id, label]) => `<button class="lp-nav-link" data-scroll="${id}">${label}</button>`).join('')}
      <a class="lp-nav-link" href="#/login">Log in</a>
      <a class="lp-btn-primary lp-mobile-cta" href="#/signup">Get started</a>
    </div>
  </header>`
}

function lpHero() {
  return `<section class="lp-hero" id="lp-product">
    <div class="lp-container">
      <div class="lp-hero-content">
        <div class="lp-eyebrow">${BRAND.category}</div>
        <h1 class="lp-headline">Work moves forward. <span>Every contribution counts.</span></h1>
        <p class="lp-tagline">${BRAND.tagline}</p>
        <p class="lp-subhead">A message in a channel becomes a task with a clear owner. Evidence from the tools your team already uses shows what was actually done, and managers see where help is needed, without scores or rankings.</p>
        <div class="lp-hero-actions">
          <a class="lp-btn-primary lp-btn-lg" href="#/signup">Get started</a>
          <button class="lp-btn-ghost lp-btn-lg" data-scroll="lp-how">See how it works</button>
        </div>
      </div>
      <div class="lp-hero-preview" aria-hidden="true">${lpPreview()}</div>
    </div>
  </section>`
}

/* An illustration in the real product look: a conversation becomes a task, and the escalation ladder behind it. Sample data. */
function lpPreview() {
  const rungs = [['Low', 'Assigned', 1], ['Medium', 'No movement for 24 h', 2], ['High', 'Deadline approaching', 3], ['Critical', 'Deadline missed', 4]]
  return `<div class="lp-pv">
    <div class="lp-pv-bar"><strong>From conversation to contribution</strong><span>Illustrative example · sample data</span></div>
    <div class="lp-pv-body">
      <div class="lp-pv-col">
        <div class="lp-pv-label">1 · A conversation</div>
        <div class="lp-pv-msg">
          <div class="lp-pv-avatar">D</div>
          <div><div class="lp-pv-msg-head">Dana<span>#task-requests</span></div>
            <p><span class="lp-mention">@Priya</span> please investigate the payment failure issue and fix it by tomorrow.</p></div>
        </div>
      </div>
      <div class="lp-pv-col">
        <div class="lp-pv-label">2 · A task with a clear owner</div>
        <div class="lp-pv-task">
          <span class="lp-pv-badge">Awaiting acceptance</span>
          <div class="lp-pv-task-title">Investigate the payment failure issue and fix it</div>
          <dl class="lp-pv-meta"><dt>Requested by</dt><dd>Dana</dd><dt>Tagged</dt><dd>Priya</dd><dt>Due</dt><dd>Tomorrow, 23:59</dd></dl>
          <div class="lp-pv-actions"><span class="lp-pv-btn primary">Accept</span><span class="lp-pv-btn">Decline</span><span class="lp-pv-btn">Transfer</span></div>
        </div>
      </div>
    </div>
    <div class="lp-pv-ladder">${rungs.map(([name, text, n]) => `<div class="lp-rung" data-n="${n}"><b>${name}<span class="lp-bars"><i></i><i></i><i></i><i></i></span></b><span>${text}</span></div>`).join('')}</div>
  </div>`
}

function lpProblem() {
  const points = [
    [ICONS.eye, 'Important work stays invisible', 'Collaboration, unblocking others and shared ownership are hard to see in a task list.'],
    [ICONS.stuck, 'Blockers go unnoticed', 'Managers often find out about stuck work too late to help.'],
    [ICONS.context, 'Context gets lost', 'Decisions and reviews happen without the evidence behind what was actually done.'],
    [ICONS.credit, 'Credit is hard to attribute', 'Who did what, and who helped, is rarely captured fairly.']
  ]
  return `<section class="lp-section" id="lp-problem">
    <div class="lp-container">
      <div class="lp-section-header">
        <div class="lp-eyebrow">The problem</div>
        <h2 class="lp-section-headline">Work volume is not work value.</h2>
        <p class="lp-section-sub">Completing more tasks does not always mean creating more value. The work that moves organisations forward is often invisible to the people who most need to see it.</p>
      </div>
      <div class="lp-grid cols-2">
        ${points.map(([ic, title, text]) => `<div class="lp-cell"><div class="lp-icon">${ic}</div><h3>${title}</h3><p>${text}</p></div>`).join('')}
      </div>
    </div>
  </section>`
}

function lpHow() {
  const steps = [
    ['01', 'Conversation', 'Work starts where people already talk. A message in a channel you chose is read by fixed rules; ordinary chat is ignored.'],
    ['02', 'Task', 'The person tagged becomes the proposed owner. They accept, decline with a reason, or transfer to a teammate who must accept.'],
    ['03', 'Evidence', 'Progress, blockers and evidence from connected apps attach to the task. Real movement is recorded; opening a task is not.'],
    ['04', 'Contribution', 'Managers review the work and verify the outcome. Shared work is counted once, and credit follows evidence.']
  ]
  return `<section class="lp-section" id="lp-how">
    <div class="lp-container">
      <div class="lp-section-header">
        <div class="lp-eyebrow">How it works</div>
        <h2 class="lp-section-headline">${BRAND.tagline}</h2>
        <p class="lp-section-sub">Four steps from a message to a contribution everyone can see and check.</p>
      </div>
      <div class="lp-steps">
        ${steps.map(([n, title, text]) => `<div class="lp-step"><div class="lp-step-num">${n}</div><h3>${title}</h3><p>${text}</p></div>`).join('')}
      </div>
    </div>
  </section>`
}

function lpCapabilities() {
  const caps = [
    [ICONS.message, 'Slack task intake', 'A message that tags someone becomes a task for them. Nothing is guessed: if the owner is unclear, a manager decides.'],
    [ICONS.owner, 'Clear ownership', 'Accept, decline with a reason, or transfer to a teammate who must accept. Every handover stays in the history.'],
    [ICONS.evidence, 'Evidence from your tools', 'Connect GitHub, Slack, Gmail, Google Calendar and Google Sheets. KONVO reads only what you choose and links it to the right task.'],
    [ICONS.journey, 'Contribution journeys', 'See how work moves from the first request to the verified outcome, including shared ownership and handoffs.'],
    [ICONS.alert, 'Escalation that stays fair', 'With M91 connected, alerts rise from assigned to no movement, deadline approaching and deadline missed. A miss asks for an explanation, not a penalty.'],
    [ICONS.ai, 'AI analysis you can check', 'Optional AI analysis cites its evidence, says when evidence is thin, and never produces a score or ranking.']
  ]
  return `<section class="lp-section" id="lp-capabilities">
    <div class="lp-container">
      <div class="lp-section-header">
        <div class="lp-eyebrow">Features</div>
        <h2 class="lp-section-headline">Everything a team needs to understand its work</h2>
      </div>
      <div class="lp-grid cols-3">
        ${caps.map(([ic, title, text]) => `<div class="lp-cell"><div class="lp-icon">${ic}</div><h3>${title}</h3><p>${text}</p></div>`).join('')}
      </div>
    </div>
  </section>`
}

function lpPrinciples() {
  const rules = [
    ['01', 'Work volume is not work value.', 'Task counts are shown as operational information only. There are no scores and no rankings.'],
    ['02', 'Evidence over assumption.', 'Every claim carries its source. What a person reports is labelled a claim until it is backed or verified.'],
    ['03', 'A missed deadline is information.', 'The owner explains what got in the way, a manager reviews it, and the reason is kept with the work. It never lowers a rating on its own.']
  ]
  return `<section class="lp-section" id="lp-principles">
    <div class="lp-container">
      <div class="lp-section-header">
        <div class="lp-eyebrow">Principles</div>
        <h2 class="lp-section-headline">Built to be fair to the people doing the work</h2>
      </div>
      <div class="lp-grid cols-3">
        ${rules.map(([n, title, text]) => `<div class="lp-cell"><div class="lp-rule-num">${n}</div><h3>${title}</h3><p>${text}</p></div>`).join('')}
      </div>
    </div>
  </section>`
}

function lpBenefits() {
  const employees = [
    'Make meaningful work visible to your manager and team',
    'Show the evidence behind your contributions',
    'Explain blockers and dependencies clearly',
    'Track progress toward outcomes, not just task completion',
    'Correct inaccurate attribution with real evidence'
  ]
  const managers = [
    'Understand what the team is working on and where people need help',
    'Recognize meaningful contributions, not just visible activity',
    'Identify blockers before they derail delivery',
    'Review evidence and verify outcomes with confidence',
    'Make better-informed support and investment decisions'
  ]
  const col = (label, title, items) => `<div class="lp-benefit-col"><div class="lp-benefit-label">${label}</div><h3>${title}</h3>
    <ul class="lp-benefit-list">${items.map((b) => `<li><span class="lp-check" aria-hidden="true"></span>${b}</li>`).join('')}</ul></div>`
  return `<section class="lp-section" id="lp-benefits">
    <div class="lp-container">
      <div class="lp-section-header">
        <div class="lp-eyebrow">For teams</div>
        <h2 class="lp-section-headline">Built for how real teams work</h2>
      </div>
      <div class="lp-grid cols-2">
        ${col('For employees', 'Your work, accurately represented', employees)}
        ${col('For managers', 'Your team, clearly understood', managers)}
      </div>
    </div>
  </section>`
}

function lpCta() {
  return `<section class="lp-cta-section">
    <div class="lp-container">
      <div class="lp-cta-inner">
        <h2>${BRAND.tagline}</h2>
        <p>${BRAND.hero}</p>
        <a class="lp-btn-primary lp-btn-lg" href="#/signup">Get started</a>
      </div>
    </div>
  </section>`
}

function lpFooter() {
  return `<footer class="lp-footer">
    <div class="lp-container">
      <div class="lp-footer-grid">
        <div class="lp-footer-brand">
          <a class="lp-logo" href="/" aria-label="${BRAND.name} home">${logoMark(28)}<span class="wordmark">${BRAND.name}</span></a>
          <p>${BRAND.category}<br>${BRAND.tagline}</p>
        </div>
        <div class="lp-footer-links">
          <div class="lp-footer-col">
            <div class="lp-footer-col-title">Product</div>
            <button class="lp-footer-link" data-scroll="lp-product">Overview</button>
            <button class="lp-footer-link" data-scroll="lp-capabilities">Features</button>
            <button class="lp-footer-link" data-scroll="lp-how">How it works</button>
            <button class="lp-footer-link" data-scroll="lp-benefits">For teams</button>
          </div>
          <div class="lp-footer-col">
            <div class="lp-footer-col-title">Account</div>
            <a class="lp-footer-link" href="#/login">Log in</a>
            <a class="lp-footer-link" href="#/signup">Get started</a>
          </div>
        </div>
      </div>
      <div class="lp-footer-bottom"><span>© ${new Date().getFullYear()} ${BRAND.name}. All rights reserved.</span></div>
    </div>
  </footer>`
}

export function renderLanding(root) {
  root.innerHTML = `<div class="lp">${lpNav()}<main id="main" tabindex="-1">${lpHero()}${lpProblem()}${lpHow()}${lpCapabilities()}${lpPrinciples()}${lpBenefits()}${lpCta()}</main>${lpFooter()}</div>`
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  /* Scroll behaviour for internal section links */
  root.querySelectorAll('[data-scroll]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      const target = document.getElementById(el.dataset.scroll)
      if (target) target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
      /* Close mobile menu after tap */
      const mob = document.getElementById('lp-mobile-nav')
      if (mob && !mob.hidden) {
        mob.hidden = true
        document.getElementById('lp-menu-btn')?.setAttribute('aria-expanded', 'false')
      }
    })
  })

  /* Mobile menu toggle */
  const menuBtn = document.getElementById('lp-menu-btn')
  const mobileNav = document.getElementById('lp-mobile-nav')
  if (menuBtn && mobileNav) {
    menuBtn.addEventListener('click', () => {
      const open = menuBtn.getAttribute('aria-expanded') === 'true'
      menuBtn.setAttribute('aria-expanded', String(!open))
      menuBtn.setAttribute('aria-label', open ? 'Open menu' : 'Close menu')
      mobileNav.hidden = open
    })
  }

  /* A hairline under the sticky nav once the page has scrolled */
  const nav = document.getElementById('lp-nav')
  if (nav) {
    const onScroll = () => nav.classList.toggle('lp-nav-scrolled', window.scrollY > 10)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }
}
