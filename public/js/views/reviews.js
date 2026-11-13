// Contribution Reviews (managers): one workspace for every decision only a person can make — AI assessments, submissions,
// outcomes to verify, evidence attribution — and the team's signals. The AI suggests; the manager decides.
import { api, html, raw, empty, loading, errorText, icon, avatar, prov, toast } from '../ui.js'
import { app } from '../app.js'
import { renderEvidenceReview } from './evidence.js'
import { renderSignals } from './assistant.js'
import { renderAssessmentCard } from './contribution.js'

const TABS = [['overview', 'Overview', 'home'], ['analyses', 'AI assessments', 'intelligence'], ['submissions', 'Submissions', 'reviews'], ['outcomes', 'Outcomes', 'shield'], ['evidence', 'Evidence', 'evidence'], ['signals', 'Signals', 'target']]
const taskIdOf = (href) => href.match(/#\/tasks\/([0-9a-f-]{36})/)?.[1]
const whoWhat = (text) => { const m = text.match(/^[^:]+: (.+?) — (.+)$/); return m ? { who: m[1], what: m[2] } : { who: '', what: text.replace(/^[^:]+: /, '') } }

export async function renderReviews(main, q) {
  if (!app.isManager) { location.replace('#/dashboard'); return }
  main.innerHTML = loading().toString()
  let review, signals, evidence
  try {
    [review, signals, evidence] = await Promise.all([
      api('/api/assistant/ask', { method: 'POST', body: { team: true, intent: 'review' } }),
      api('/api/signals?scope=team').catch(() => []),
      api('/api/work-evidence?view=review').catch(() => [])
    ])
  } catch (e) { main.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
  const by = (prefix) => review.items.filter((i) => i.text.startsWith(prefix))
  const data = { analyses: by('Analysis'), submissions: by('Submission'), outcomes: by('Outcome'), evidence: { length: evidence.length }, signals }
  data.overview = { length: 0 }
  const tab = TABS.some(([k]) => k === q.get('tab')) ? q.get('tab') : 'overview'
  main.innerHTML = html`<div class="page-head"><div><div class="eyebrow">${icon('reviews', 'xs')}Contribution reviews</div><h1>Contribution reviews</h1><p>The decisions only you can make: judging analyses, approving work, verifying outcomes and deciding whose work it is. Everything else KONVO handles.</p></div></div>
    <div class="principle" style="margin-bottom:16px">${icon('shield')}<span><b>The AI suggests; you decide.</b> Every assessment keeps the AI’s original, the employee’s own account and your decision — with your reasons — side by side. Nothing becomes final without you.</span></div>
    <nav class="tabs review-tabs" aria-label="Review queues">${TABS.map(([k, l, ic]) => html`<a href="#/reviews?tab=${k}" ${k === tab ? raw('aria-current="page"') : ''}>${icon(ic, 'sm')}${l}${data[k].length ? html`<span class="count-pill">${data[k].length}</span>` : ''}</a>`)}</nav>
    <div id="review-body"></div>`.toString()
  const body = main.querySelector('#review-body')
  const queue = (items, kind) => (items.length ? html`<div class="review-queue">${items.map((i) => {
    const { who, what } = whoWhat(i.text)
    return html`<article class="card review-item" ${kind === 'analyses' ? raw(`data-task="${taskIdOf(i.href)}"`) : ''}><div class="row between nowrap" style="gap:12px;align-items:flex-start"><div class="row nowrap" style="gap:10px;min-width:0">${who ? avatar(who, null, 'sm') : ''}<div style="min-width:0"><a class="ttl" href="${i.href}"><b>${what}</b></a><div class="small muted">${who}${who ? ' · ' : ''}${i.detail}</div></div></div>
      ${kind === 'analyses' ? html`<button class="btn small ghost" data-open-assessment>${icon('eye')}Inspect</button>` : html`<a class="btn small" href="${i.href}">${kind === 'submissions' ? 'Review' : 'Open'}</a>`}</div>
      ${kind === 'analyses' ? html`<div class="assessment-slot" hidden></div>` : ''}</article>`
  })}</div>` : '')
  if (tab === 'overview') {
    const tiles = [['analyses', 'AI assessments to review', data.analyses.length, 'intelligence'], ['submissions', 'Submissions to review', data.submissions.length, 'reviews'], ['outcomes', 'Outcomes to verify', data.outcomes.length, 'shield'], ['evidence', 'Evidence to resolve', evidence.length, 'evidence']]
    body.innerHTML = html`<nav class="decisions" aria-label="Review queues">${tiles.map(([k, l, n, ic]) => html`<a class="decision ${n ? 'open' : ''}" href="#/reviews?tab=${k}"><span class="lead-icon ${n ? 'warn' : ''}">${icon(ic)}</span><span class="d-body"><span class="d-label">${l}</span><span class="d-value">${n || 'All clear'}</span></span></a>`)}</nav>
      <section class="card" id="team-signals"></section>`.toString()
    renderSignals(body.querySelector('#team-signals'), { scope: 'team', limit: 8, title: 'Signals in your teams', subtitle: 'Detected from records by fixed rules — each with a recommended next step.' })
  } else if (tab === 'analyses') {
    body.innerHTML = (data.analyses.length ? queue(data.analyses, 'analyses') : html`<div class="card">${empty('No assessments waiting', 'AI assessments of your people’s work appear here until you approve, adjust or dispute them.', '', 'checkCircle')}</div>`).toString()
    body.querySelectorAll('[data-open-assessment]').forEach((b) => b.addEventListener('click', () => {
      const card = b.closest('.review-item'); const slot = card.querySelector('.assessment-slot')
      if (!slot.hidden) { slot.hidden = true; b.lastChild.textContent = 'Inspect'; return }
      slot.hidden = false; b.lastChild.textContent = 'Hide'
      if (!slot.dataset.loaded) { slot.dataset.loaded = '1'; slot.innerHTML = loading('Loading the assessment…').toString(); renderAssessmentCard(slot, card.dataset.task).catch((e) => toast(errorText(e), { error: true })) }
    }))
    if (data.analyses.length === 1) body.querySelector('[data-open-assessment]')?.click()
  } else if (tab === 'submissions') {
    body.innerHTML = (data.submissions.length ? queue(data.submissions, 'submissions') : html`<div class="card">${empty('No submissions waiting', 'Work employees submit for review appears here. Approving completes the task; it never verifies impact.', '', 'checkCircle')}</div>`).toString()
  } else if (tab === 'outcomes') {
    body.innerHTML = html`${data.outcomes.length ? queue(data.outcomes, 'outcomes') : html`<div class="card">${empty('No outcomes waiting', 'Outcomes people record appear here. Until you verify one it is only a claim.', '', 'checkCircle')}</div>`}${data.outcomes.length ? html`<p class="small muted" style="margin-top:12px">${prov('unverified', 'Claims')} An unverified outcome is never counted as verified impact.</p>` : ''}`.toString()
  } else if (tab === 'evidence') {
    body.innerHTML = html`<section class="card"><div class="card-head"><div><h2><span class="card-icon teal">${icon('evidence')}</span>Evidence: whose work is it?</h2><p>Disputed or unknown authorship and shared links. Nothing is credited until you decide.</p></div></div><div id="ev-review">${loading()}</div></section>`.toString()
    renderEvidenceReview(body.querySelector('#ev-review'))
  } else {
    body.innerHTML = html`<div class="segmented" role="group" aria-label="Signal state" style="margin-bottom:16px">${[['OPEN', 'Open'], ['DISMISSED', 'Dismissed'], ['RESOLVED', 'Resolved']].map(([k, l]) => html`<a href="#/reviews?tab=signals&state=${k}" ${(q.get('state') || 'OPEN') === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</div><section id="team-signals"></section>`.toString()
    renderSignals(body.querySelector('#team-signals'), { scope: 'team', limit: 50, status: q.get('state') || 'OPEN', detail: true })
  }
}
