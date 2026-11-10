/* TeamPulse public landing page. No user data is interpolated here — all content is static. */

const LOGO_SVG = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--logo-bg)"/><path d="M6 17h5l3-7 4 13 3-6h5" fill="none" stroke="var(--logo-fg)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function lpNav() {
  return `<header class="lp-nav" id="lp-nav">
    <div class="lp-nav-inner">
      <a class="lp-logo" href="/">${LOGO_SVG}<span>TeamPulse</span></a>
      <nav class="lp-nav-links" aria-label="Landing navigation">
        <button class="lp-nav-link" data-scroll="lp-product">Product</button>
        <button class="lp-nav-link" data-scroll="lp-how">How it works</button>
        <button class="lp-nav-link" data-scroll="lp-benefits">For Teams</button>
        <button class="lp-nav-link" data-scroll="lp-capabilities">Features</button>
      </nav>
      <div class="lp-nav-cta">
        <a class="lp-nav-signin" href="#/login">Log in</a>
        <a class="lp-btn-primary" href="#/signup">Get Started</a>
      </div>
      <button class="lp-menu-btn" id="lp-menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="lp-mobile-nav">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
    </div>
    <div class="lp-mobile-nav" id="lp-mobile-nav" hidden>
      <button class="lp-nav-link" data-scroll="lp-product">Product</button>
      <button class="lp-nav-link" data-scroll="lp-how">How it works</button>
      <button class="lp-nav-link" data-scroll="lp-benefits">For Teams</button>
      <button class="lp-nav-link" data-scroll="lp-capabilities">Features</button>
      <a class="lp-nav-link" href="#/login">Log in</a>
      <a class="lp-btn-primary lp-mobile-cta" href="#/signup">Get Started</a>
    </div>
  </header>`
}

function lpHero() {
  return `<section class="lp-hero" id="lp-product">
    <div class="lp-container">
      <div class="lp-hero-content">
        <div class="lp-eyebrow">Work Intelligence Platform</div>
        <h1 class="lp-headline">Work that matters.<br>Made visible.</h1>
        <p class="lp-subhead">Understand what your team is working on, recognize meaningful contributions, and discover where people need support. TeamPulse turns everyday work into clear, evidence-backed work intelligence.</p>
        <div class="lp-hero-actions">
          <a class="lp-btn-primary lp-btn-lg" href="#/signup">Get Started</a>
          <button class="lp-btn-ghost lp-btn-lg" data-scroll="lp-capabilities">Explore the Product</button>
        </div>
      </div>
      <div class="lp-hero-preview" aria-hidden="true">
        ${lpAppPreview()}
      </div>
    </div>
  </section>`
}

function lpAppPreview() {
  return `<div class="lp-preview-frame">
    <div class="lp-preview-bar">
      <span class="lp-dot"></span><span class="lp-dot"></span><span class="lp-dot"></span>
      <span class="lp-preview-url">teampulse.app</span>
    </div>
    <div class="lp-preview-app">
      <div class="lp-preview-sidebar">
        <div class="lp-preview-logo">${LOGO_SVG}<span>TeamPulse</span></div>
        <div class="lp-preview-org"><span class="lp-preview-org-dot">A</span><span>Acme Corp</span></div>
        <div class="lp-preview-nav">
          <div class="lp-preview-nav-item active">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            Overview
          </div>
          <div class="lp-preview-nav-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Team
          </div>
          <div class="lp-preview-nav-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            Tasks
          </div>
          <div class="lp-preview-nav-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
            Reviews
          </div>
          <div class="lp-preview-nav-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            Copilot
          </div>
        </div>
      </div>
      <div class="lp-preview-main">
        <div class="lp-preview-topbar">
          <span class="lp-preview-page-title">Team Overview</span>
          <div class="lp-preview-avatar">JD</div>
        </div>
        <div class="lp-preview-content">
          <div class="lp-preview-stats">
            <div class="lp-preview-stat">
              <div class="lp-preview-stat-label">In Progress</div>
              <div class="lp-preview-stat-val">12</div>
            </div>
            <div class="lp-preview-stat">
              <div class="lp-preview-stat-label">Needs Review</div>
              <div class="lp-preview-stat-val accent">4</div>
            </div>
            <div class="lp-preview-stat">
              <div class="lp-preview-stat-label">Completed</div>
              <div class="lp-preview-stat-val">28</div>
            </div>
          </div>
          <div class="lp-preview-section-label">Active contributions</div>
          <div class="lp-preview-task">
            <span class="lp-preview-task-dot green"></span>
            <span class="lp-preview-task-name">API rate limiting</span>
            <span class="lp-preview-task-who">Ada L.</span>
          </div>
          <div class="lp-preview-task">
            <span class="lp-preview-task-dot amber"></span>
            <span class="lp-preview-task-name">Auth refactor — blocked</span>
            <span class="lp-preview-task-who">Marcus T.</span>
          </div>
          <div class="lp-preview-task">
            <span class="lp-preview-task-dot green"></span>
            <span class="lp-preview-task-name">Migrate billing DB</span>
            <span class="lp-preview-task-who">Priya S.</span>
          </div>
          <div class="lp-preview-task">
            <span class="lp-preview-task-dot lime"></span>
            <span class="lp-preview-task-name">Dashboard redesign</span>
            <span class="lp-preview-task-who">Dev K.</span>
          </div>
          <div class="lp-preview-signal">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Auth refactor has been blocked for 3 days
          </div>
        </div>
      </div>
    </div>
  </div>`
}

function lpProblem() {
  return `<section class="lp-problem">
    <div class="lp-container">
      <div class="lp-problem-inner">
        <div class="lp-problem-left">
          <h2 class="lp-section-headline">Task counts don't tell the whole story.</h2>
          <p class="lp-section-sub">Completing more tasks does not always mean creating more value. The work that moves organisations forward is often invisible to the people who most need to see it.</p>
        </div>
        <div class="lp-problem-points">
          <div class="lp-problem-point">
            <div class="lp-problem-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
            <div>
              <strong>Important work stays invisible</strong>
              <p>Collaboration, unblocking others, and shared ownership are hard to see in a task list.</p>
            </div>
          </div>
          <div class="lp-problem-point">
            <div class="lp-problem-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            </div>
            <div>
              <strong>Blockers go unnoticed</strong>
              <p>Managers often find out about stuck work too late to help.</p>
            </div>
          </div>
          <div class="lp-problem-point">
            <div class="lp-problem-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            </div>
            <div>
              <strong>Context gets lost</strong>
              <p>Decisions and reviews happen without the evidence behind what was actually done.</p>
            </div>
          </div>
          <div class="lp-problem-point">
            <div class="lp-problem-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            </div>
            <div>
              <strong>Attribution is inaccurate</strong>
              <p>Who actually did what, and who helped — these are rarely captured fairly.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>`
}

function lpCapabilities() {
  const caps = [
    {
      icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 20h.01M7 20v-4"/><path d="M12 20V10"/><path d="M17 20V4"/><path d="M22 20h.01"/></svg>`,
      title: 'Work Intelligence',
      desc: 'Understand meaningful progress, contributions and outcomes. See beyond task volume to the actual value being created.'
    },
    {
      icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
      title: 'Evidence Intelligence',
      desc: 'Connect work evidence from the applications teams already use. Ground every contribution in verifiable, real-world artefacts.'
    },
    {
      icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><line x1="12" y1="8" x2="5" y2="16"/><line x1="12" y1="8" x2="19" y2="16"/></svg>`,
      title: 'Contribution Journeys',
      desc: 'See how work moves from initial request to final outcome, including shared ownership and handoffs across the team.'
    },
    {
      icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
      title: 'AI Work Assistant',
      desc: 'Understand daily progress, blockers and contributions through grounded insights — based on what actually happened, not guesses.'
    },
    {
      icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      title: 'Manager Copilot',
      desc: 'Help managers identify where support and decisions are needed. Understand team health without micromanagement.'
    },
    {
      icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>`,
      title: 'Proactive Signals',
      desc: 'Surface work that needs attention before it becomes a bigger problem. Act on what matters, when it matters.'
    }
  ]
  return `<section class="lp-capabilities" id="lp-capabilities">
    <div class="lp-container">
      <div class="lp-section-header">
        <div class="lp-eyebrow">Capabilities</div>
        <h2 class="lp-section-headline">Everything your team needs<br>to understand their work</h2>
      </div>
      <div class="lp-cap-grid">
        ${caps.map((c) => `<div class="lp-cap-card">
          <div class="lp-cap-icon">${c.icon}</div>
          <h3>${c.title}</h3>
          <p>${c.desc}</p>
        </div>`).join('')}
      </div>
    </div>
  </section>`
}

function lpHow() {
  const steps = [
    { n: '01', title: 'Capture', desc: 'Connect the tools where work happens. Evidence flows in automatically from the apps your team already uses.' },
    { n: '02', title: 'Understand', desc: 'Organise tasks, evidence and context into contribution journeys that show the full picture of how work progressed.' },
    { n: '03', title: 'Review', desc: 'Understand contributions and verify outcomes. See who did what, who helped, and what the work actually delivered.' },
    { n: '04', title: 'Improve', desc: 'Help people move work forward. Surface blockers early, recognize meaningful contributions, and make better decisions.' }
  ]
  return `<section class="lp-how" id="lp-how">
    <div class="lp-container">
      <div class="lp-section-header lp-section-header-light">
        <div class="lp-eyebrow lp-eyebrow-light">How it works</div>
        <h2 class="lp-section-headline" style="color:#fff">From work happening to work understood</h2>
      </div>
      <div class="lp-steps">
        ${steps.map((s, i) => `<div class="lp-step">
          <div class="lp-step-num">${s.n}</div>
          ${i < steps.length - 1 ? '<div class="lp-step-line" aria-hidden="true"></div>' : ''}
          <h3>${s.title}</h3>
          <p>${s.desc}</p>
        </div>`).join('')}
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
    'Understand what the team is working on and where they need help',
    'Recognize meaningful contributions, not just visible activity',
    'Identify blockers before they derail delivery',
    'Review evidence and verify outcomes with confidence',
    'Make better-informed support and investment decisions'
  ]
  return `<section class="lp-benefits" id="lp-benefits">
    <div class="lp-container">
      <div class="lp-section-header">
        <div class="lp-eyebrow">For Teams</div>
        <h2 class="lp-section-headline">Built for how real teams actually work</h2>
      </div>
      <div class="lp-benefits-grid">
        <div class="lp-benefit-col">
          <div class="lp-benefit-label">For Employees</div>
          <h3>Your work, accurately represented</h3>
          <ul class="lp-benefit-list">
            ${employees.map((b) => `<li><span class="lp-check" aria-hidden="true"></span>${b}</li>`).join('')}
          </ul>
        </div>
        <div class="lp-benefit-col lp-benefit-col-right">
          <div class="lp-benefit-label">For Managers</div>
          <h3>Your team, clearly understood</h3>
          <ul class="lp-benefit-list">
            ${managers.map((b) => `<li><span class="lp-check" aria-hidden="true"></span>${b}</li>`).join('')}
          </ul>
        </div>
      </div>
    </div>
  </section>`
}

function lpCta() {
  return `<section class="lp-cta-section">
    <div class="lp-container">
      <div class="lp-cta-inner">
        <h2>Make meaningful work visible.</h2>
        <p>Give your team better visibility into the work that moves things forward.</p>
        <a class="lp-btn-primary lp-btn-lg" href="#/signup">Get Started with TeamPulse</a>
      </div>
    </div>
  </section>`
}

function lpFooter() {
  return `<footer class="lp-footer">
    <div class="lp-container">
      <div class="lp-footer-grid">
        <div class="lp-footer-brand">
          <a class="lp-logo" href="/">${LOGO_SVG}<span>TeamPulse</span></a>
          <p>Work intelligence that makes contributions visible. Work volume is not work value.</p>
        </div>
        <div class="lp-footer-links">
          <div class="lp-footer-col">
            <div class="lp-footer-col-title">Product</div>
            <button class="lp-footer-link" data-scroll="lp-product">Overview</button>
            <button class="lp-footer-link" data-scroll="lp-capabilities">Features</button>
            <button class="lp-footer-link" data-scroll="lp-how">How it works</button>
            <button class="lp-footer-link" data-scroll="lp-benefits">For Teams</button>
          </div>
          <div class="lp-footer-col">
            <div class="lp-footer-col-title">Account</div>
            <a class="lp-footer-link" href="#/login">Log in</a>
            <a class="lp-footer-link" href="#/signup">Get Started</a>
          </div>
        </div>
      </div>
      <div class="lp-footer-bottom">
        <span>© ${new Date().getFullYear()} TeamPulse. All rights reserved.</span>
      </div>
    </div>
  </footer>`
}

export function renderLanding(root) {
  root.innerHTML = `<div class="lp">${lpNav()}${lpHero()}${lpProblem()}${lpCapabilities()}${lpHow()}${lpBenefits()}${lpCta()}${lpFooter()}</div>`

  /* Scroll behaviour for internal section links */
  root.querySelectorAll('[data-scroll]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      const target = document.getElementById(el.dataset.scroll)
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      /* Close mobile menu after tap */
      const mob = document.getElementById('lp-mobile-nav')
      if (mob && !mob.hidden) {
        mob.hidden = true
        const btn = document.getElementById('lp-menu-btn')
        if (btn) btn.setAttribute('aria-expanded', 'false')
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
      mobileNav.hidden = open
    })
  }

  /* Sticky nav shadow on scroll */
  const nav = document.getElementById('lp-nav')
  if (nav) {
    const onScroll = () => nav.classList.toggle('lp-nav-scrolled', window.scrollY > 10)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }
}
