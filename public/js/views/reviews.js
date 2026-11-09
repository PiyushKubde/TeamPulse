// Contribution Reviews (managers): everything that waits for a human decision, in one place — submissions, analyses,
// outcomes to verify, evidence attribution, and the team's signals.
import { api, html, empty, loading, errorText } from '../ui.js'
import { app } from '../app.js'
import { renderEvidenceReview } from './evidence.js'
import { renderSignals } from './assistant.js'

export async function renderReviews(main) {
  if (!app.isManager) { location.replace('#/dashboard'); return }
  main.innerHTML = loading().toString()
  let review
  try { review = await api('/api/assistant/ask', { method: 'POST', body: { team: true, intent: 'review' } }) } catch (e) { main.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
  const group = (prefix) => review.items.filter((i) => i.text.startsWith(prefix))
  const list = (items) => (items.length ? html`<ul class="list">${items.map((i) => html`<li><div class="grow"><a href="${i.href}"><b>${i.text.replace(/^[^:]+: /, '')}</b></a><div class="small muted">${i.detail}</div></div></li>`)}</ul>` : html`<p class="small muted">Nothing waiting.</p>`)
  main.innerHTML = html`<div class="page-head"><div><h1>Contribution reviews</h1><p>The decisions only you can make: approving work, judging analyses, verifying outcomes and deciding whose work it is. Everything else TeamPulse handles.</p></div></div>
    <section class="card" id="team-signals"></section>
    <div class="grid two" style="margin-top:16px">
      <section class="card"><h2 style="margin-bottom:8px">Submissions to review</h2>${list(group('Submission'))}</section>
      <section class="card"><h2 style="margin-bottom:8px">Analyses to review</h2>${list(group('Analysis'))}<p class="small muted">Approve, adjust a level with a reason, or dispute — on each task.</p></section>
      <section class="card"><h2 style="margin-bottom:8px">Outcomes to verify</h2>${list(group('Outcome'))}<p class="small muted">An unverified outcome is a claim, never counted as verified impact.</p></section>
      <section class="card"><h2 style="margin-bottom:8px">Evidence: whose work is it?</h2><div id="ev-review">${loading()}</div></section>
    </div>`.toString()
  renderSignals(main.querySelector('#team-signals'), { scope: 'team', limit: 20, title: 'Signals in your teams' })
  renderEvidenceReview(main.querySelector('#ev-review'))
  void empty
}
