// Contributions: one journey per piece of work, and the journey itself as an interactive timeline across stages.
// Facts carry their source and author; the stage is TeamPulse's rule-based reading; missing steps are listed.
import { api, html, raw, toast, errorText, ago, dt, empty, loading, confirmDialog } from '../ui.js'
import { app } from '../app.js'

const SRC = { teampulse: 'TeamPulse', github: 'GitHub', slack: 'Slack', gmail: 'Gmail', 'google-calendar': 'Calendar', 'google-sheets': 'Sheets', external: 'Request', gmail_intake: 'Email', slack_intake: 'Slack' }
const OUTCOME = { verified: ['Verified outcome', 'ok'], claimed: ['Outcome claimed', 'warn'], none: ['No outcome yet', 'outline'] }

export async function renderContributions(main, q) {
  const userId = q.get('userId') || app.me.id
  const days = [30, 90].includes(Number(q.get('days'))) ? Number(q.get('days')) : 30
  main.innerHTML = loading().toString()
  const r = await api(`/api/journeys?userId=${encodeURIComponent(userId)}&from=${encodeURIComponent(new Date(Date.now() - days * 86400000).toISOString())}`)
  const mine = userId === app.me.id
  main.innerHTML = html`<div class="page-head"><div><h1>${mine ? 'My contributions' : `${r.name}'s contributions`}</h1><p>Each piece of work as one journey — from request to outcome — with the evidence behind it. ${r.note}</p></div>
      <div class="row"><a class="btn ghost" href="#/contribution/${userId}">Assessments</a><a class="btn ghost" href="#/impact${mine && !app.isManager ? '?view=mine' : ''}">Outcomes</a></div></div>
    <div class="tabs">${[[30, 'Last 30 days'], [90, 'Last 90 days']].map(([n, l]) => html`<a href="#/contributions?userId=${userId}&days=${n}" ${n === days ? raw('aria-current="page"') : ''}>${l}</a>`)}</div>
    ${r.journeys.length ? html`<div class="journey-list">${r.journeys.map((j) => html`<a class="card journey-card" href="#/journey/${j.taskId}">
      <div class="row between" style="gap:6px"><b>${j.title}</b><span class="badge ${OUTCOME[j.outcome][1]}">${OUTCOME[j.outcome][0]}</span></div>
      <div class="stage-dots" aria-label="Stages reached">${['reported', 'planned', 'investigated', 'implemented', 'reviewed', 'delivered', 'accepted', 'outcome'].map((k) => html`<span class="sd ${j.stagesReached.includes(k) ? 'on' : ''}" title="${k}"></span>`)}</div>
      <div class="small muted">Now: ${j.stage}${j.complexity ? ` · ${j.complexity}` : ''}${j.shared ? ` · with ${j.contributors.filter((c) => c !== j.ownerName).join(', ')}` : ''} · ${j.sources.map((s) => SRC[s] || s).join(', ')}${j.blocked ? ' · blocked' : ''}${j.missing ? ` · ${j.missing} missing link(s)` : ''}</div>
      <div class="small muted">Last activity ${ago(j.lastActivityAt)}</div></a>`)}</div>`
      : empty('No contributions in this period', mine ? 'Work on a task, collect evidence from your apps, or ask the AI Work Assistant to analyse your day.' : 'Nothing recorded for this person in this period.', mine ? html`<a class="btn small" href="#/assistant">AI Work Assistant</a>` : '')}`.toString()
}

export async function renderJourney(main, taskId) {
  main.innerHTML = loading().toString()
  const j = await api(`/api/journeys/${taskId}`)
  const reload = () => renderJourney(main, taskId).catch((e) => toast(errorText(e), { error: true }))
  const byStage = (k) => j.steps.filter((s) => s.stage === k)
  main.innerHTML = html`<div class="small muted" style="margin-bottom:6px"><a href="#/contributions${j.task.ownerId && j.task.ownerId !== app.me.id ? `?userId=${j.task.ownerId}` : ''}">← Contributions</a></div>
    <div class="page-head"><div><h1>${j.task.title}</h1><p>${j.task.ref} · ${j.task.ownerName || 'unassigned'} · ${j.task.status.replace(/_/g, ' ').toLowerCase()}${j.assessment?.complexity ? ` · assessed ${j.assessment.complexity}` : ''}</p></div>
      <div class="row"><a class="btn ghost" href="#/tasks/${j.task.id}">Open the task</a></div></div>
    <div class="notice small">${j.note}</div>
    <section class="card"><div class="stage-strip" role="list">${j.stages.map((s) => html`<a class="stage ${s.reached ? 'on' : ''} ${['blocked', 'rework'].includes(s.key) ? 'side' : ''}" role="listitem" href="#st-${s.key}" ${s.reached ? '' : raw('aria-disabled="true"')}><span>${s.label}</span><small>${byStage(s.key).length ? `${byStage(s.key).length} step(s)` : 'not evidenced'}</small></a>`)}</div></section>
    <div class="grid side" style="margin-top:16px">
      <section class="card"><h2 style="margin-bottom:8px">Timeline</h2>
        <ol class="journey">${j.steps.map((s) => html`<li class="step st-${s.stage}" id="${byStage(s.stage)[0] === s ? `st-${s.stage}` : ''}">
          <div class="row" style="gap:6px"><span class="badge outline">${SRC[s.source] || s.source}</span><span class="badge ${s.stage === 'outcome' && s.verified ? 'ok' : ['blocked', 'rework'].includes(s.stage) ? 'warn' : 'brand'}">${s.stage}</span>
            ${s.verification ? html`<span class="small muted">${s.verification === 'system_recorded' ? 'recorded by the app' : s.verification === 'reported_figure' ? 'reported figure, not verified' : 'a person’s account'}</span>` : ''}${s.selfReported ? html`<span class="small muted">the employee’s own account</span>` : ''}
            ${s.disputed ? html`<span class="badge warn">authorship disputed</span>` : ''}${s.shared ? html`<span class="badge outline">shared</span>` : ''}${s.outsideControl ? html`<span class="badge info">outside their control</span>` : ''}</div>
          <div><a href="${s.href}" ${/^https?:/.test(s.href) ? raw('target="_blank" rel="noopener noreferrer"') : ''}><b>${s.title}</b></a></div>
          ${s.detail ? html`<div class="small pre">${s.detail}</div>` : ''}
          <div class="small muted">${dt(s.at)} · ${s.author?.name || 'unknown'}${s.author?.external ? ' (outside the organization)' : s.author?.unknown ? ' (not known to TeamPulse)' : ''}${s.linkedBy ? ` · ${s.linkedBy}` : ''}</div>
          ${s.linkIds?.length && (j.task.ownerId === app.me.id || app.isManager) ? html`<div class="row" style="gap:6px;margin-top:4px"><button class="btn small link" data-unlink="${s.linkIds.join(',')}">Not part of this work</button></div>` : ''}
        </li>`)}</ol></section>
      <div class="stack">
        <section class="card"><h2 style="margin-bottom:8px">Contributors</h2><ul class="plain">${j.contributors.map((c) => html`<li><b>${c.name}</b> <span class="small muted">${c.roles.join(', ')}</span></li>`)}</ul>
          <p class="small muted" style="margin-top:6px">Shared outcomes are counted once; each person’s part stays theirs.</p></section>
        <section class="card"><h2 style="margin-bottom:8px">What is missing</h2>${j.missing.length ? html`<ul class="plain">${j.missing.map((m) => html`<li>• ${m}</li>`)}</ul>` : html`<p class="small">Nothing obvious — the journey is evidenced from start to outcome.</p>`}</section>
        ${j.possibleLinks.length ? html`<section class="card"><h2 style="margin-bottom:8px">Possibly part of this work</h2><ul class="plain">${j.possibleLinks.map((p) => html`<li><span class="badge outline">${SRC[p.app] || p.app}</span> ${p.title} <span class="small muted">${p.method}, ${Math.round(p.confidence * 100)}%</span>
          <div class="row" style="gap:6px"><button class="btn small" data-link-act="CONFIRM" data-link="${p.linkId}">It belongs here</button><button class="btn small ghost" data-link-act="REJECT" data-link="${p.linkId}">No</button></div></li>`)}</ul></section>` : ''}
        ${j.related.length ? html`<section class="card"><h2 style="margin-bottom:8px">Related work</h2><ul class="plain">${j.related.map((r) => html`<li><a href="#/journey/${r.id}">${r.title}</a></li>`)}</ul></section>` : ''}
        <section class="card"><h2 style="margin-bottom:8px">Assessment</h2>${j.assessment ? html`<p>${j.assessment.complexity ? html`<span class="badge brand">${j.assessment.complexity}</span> ` : ''}${j.assessment.evidenceState} evidence · manager ${j.assessment.managerStatus.toLowerCase()}${j.assessment.simulated ? ' · simulated' : ''}</p><a class="small" href="#/tasks/${j.task.id}">See reasons and evidence →</a>` : html`<p class="small muted">Not analysed yet. The analysis on the task page is the source of truth for complexity and quality.</p>`}</section>
      </div></div>`.toString()
  main.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
    const r = await confirmDialog({ title: 'Not part of this work?', body: 'The evidence stays in TeamPulse but is no longer linked to this task.', confirm: 'Unlink' })
    if (!r?.ok) return
    try { for (const id of b.dataset.unlink.split(',')) await api(`/api/work-evidence-links/${id}`, { method: 'POST', body: { action: 'REJECT' } }); toast('Unlinked.'); reload() } catch (e) { toast(errorText(e), { error: true }) }
  }))
  main.querySelectorAll('[data-link-act]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/api/work-evidence-links/${b.dataset.link}`, { method: 'POST', body: { action: b.dataset.linkAct } }); toast('Saved.'); reload() } catch (e) { toast(errorText(e), { error: true }) }
  }))
}
