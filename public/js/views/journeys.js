// Contributions: one journey per piece of work, and the journey itself as an interactive timeline across stages.
// Facts carry their source and author; the stage is TeamPulse's rule-based reading; suggestions and missing steps are
// labelled as such and never filled in.
import { api, html, raw, toast, errorText, ago, dt, empty, loading, confirmDialog, icon, avatar, appTile, prov } from '../ui.js'
import { app } from '../app.js'

const SRC = { teampulse: 'TeamPulse', github: 'GitHub', slack: 'Slack', gmail: 'Gmail', 'google-calendar': 'Calendar', 'google-sheets': 'Sheets', external: 'Request', gmail_intake: 'Email', slack_intake: 'Slack' }
const OUTCOME = { verified: () => prov('verified', 'Verified outcome'), claimed: () => prov('unverified', 'Outcome claimed'), none: () => prov('missing', 'No outcome yet') }
const STAGE_LABEL = { reported: 'Reported', planned: 'Planned', investigated: 'Investigated', implemented: 'Implemented', reviewed: 'Reviewed', rework: 'Rework', blocked: 'Blocked', delivered: 'Delivered', accepted: 'Accepted', outcome: 'Outcome' }
const sourceTile = (src, size = 'sm') => (['github', 'slack', 'gmail', 'google-calendar', 'google-sheets'].includes(src) ? appTile(src, size) : html`<span class="app-icon ${size} tp">${icon(src === 'external' || src === 'gmail_intake' || src === 'slack_intake' ? 'inbox' : 'tasks')}</span>`)

export async function renderContributions(main, q) {
  const userId = q.get('userId') || app.me.id
  const days = [30, 90].includes(Number(q.get('days'))) ? Number(q.get('days')) : 30
  main.innerHTML = loading().toString()
  const r = await api(`/api/journeys?userId=${encodeURIComponent(userId)}&from=${encodeURIComponent(new Date(Date.now() - days * 86400000).toISOString())}`)
  const mine = userId === app.me.id
  main.innerHTML = html`<div class="page-head"><div><div class="eyebrow">${icon('journeys', 'xs')}Contribution journeys</div><h1>${mine ? 'My contributions' : `${r.name}’s contributions`}</h1><p>Each piece of work as one journey — from request to outcome — with the evidence behind it. ${r.note}</p></div>
      <div class="row"><a class="btn ghost" href="#/contribution/${userId}">${icon('intelligence')}Assessments</a><a class="btn ghost" href="#/impact${mine && !app.isManager ? '?view=mine' : ''}">${icon('award')}Outcomes</a></div></div>
    <div class="segmented" role="group" aria-label="Period">${[[30, 'Last 30 days'], [90, 'Last 90 days']].map(([n, l]) => html`<a href="#/contributions?userId=${userId}&days=${n}" ${n === days ? raw('aria-current="page"') : ''}>${l}</a>`)}</div>
    ${r.journeys.length ? html`<div class="journey-list" style="margin-top:16px">${r.journeys.map((j) => html`<a class="card journey-card" href="#/journey/${j.taskId}">
      <div class="row between nowrap" style="gap:8px;align-items:flex-start"><b>${j.title}</b></div>
      <div class="row" style="gap:6px">${OUTCOME[j.outcome]()}${j.blocked ? html`<span class="badge warn">${icon('blocked', 'xs')}Blocked</span>` : ''}${j.complexity ? html`<span class="badge brand" title="Assessed complexity">${j.complexity}</span>` : ''}</div>
      <div class="stage-dots" aria-label="Stages reached">${['reported', 'planned', 'investigated', 'implemented', 'reviewed', 'delivered', 'accepted', 'outcome'].map((k) => html`<span class="sd ${j.stagesReached.includes(k) ? 'on' : ''}" title="${STAGE_LABEL[k]}"></span>`)}</div>
      <div class="small">Now: <b>${j.stage}</b>${j.shared ? html` · with ${j.contributors.filter((c) => c !== j.ownerName).join(', ')}` : ''}</div>
      <div class="meta">${j.sources.map((s) => html`<span class="row nowrap" style="gap:4px">${sourceTile(s, 'xs')}${SRC[s] || s}</span>`)}${j.missing ? html`<span class="sep"></span><span>${j.missing} missing link(s)</span>` : ''}</div>
      <div class="small muted">Last activity ${ago(j.lastActivityAt)}</div></a>`)}</div>`
      : empty('No contributions in this period', mine ? 'Work on a task, collect evidence from your apps, or ask Analyse My Day to read yours.' : 'Nothing recorded for this person in this period.', mine ? html`<a class="btn small ghost" href="#/assistant">${icon('sparkles')}Analyse My Day</a>` : '', 'journeys')}`.toString()
}

const stepProvenance = (s) => {
  if (s.linkedBy && s.linkedBy.startsWith('suggested')) return prov('suggested', `Suggested — ${s.linkedBy.replace('suggested ', '').replace(/[()]/g, '')}`)
  if (s.linkedBy === 'confirmed by a person') return prov('self', 'Confirmed by a person')
  if (s.stage === 'outcome') return s.verified ? prov('verified', 'Manager verified') : prov('unverified', s.verification === 'reported_figure' ? 'Reported figure, not verified' : 'A person’s account')
  if (s.selfReported) return prov('self', 'The employee’s own account')
  return prov('fact', s.source === 'teampulse' ? 'Recorded by TeamPulse' : 'Recorded by the app')
}

export async function renderJourney(main, taskId) {
  main.innerHTML = loading().toString()
  const j = await api(`/api/journeys/${taskId}`)
  const reload = () => renderJourney(main, taskId).catch((e) => toast(errorText(e), { error: true }))
  const byStage = (k) => j.steps.filter((s) => s.stage === k)
  const back = `#/contributions${j.task.ownerId && j.task.ownerId !== app.me.id ? `?userId=${j.task.ownerId}` : ''}`
  main.innerHTML = html`<div class="crumbs"><a href="${back}">Contributions</a>${icon('chevronRight', 'xs')}<span>${j.task.title.length > 48 ? `${j.task.title.slice(0, 48)}…` : j.task.title}</span></div>
    <div class="page-head"><div><h1>${j.task.title}</h1><p>${j.task.ref} · ${j.task.ownerName || 'unassigned'} · ${j.task.status.replace(/_/g, ' ').toLowerCase()}${j.assessment?.complexity ? ` · assessed ${j.assessment.complexity}` : ''}</p></div>
      <div class="row"><a class="btn ghost" href="#/tasks/${j.task.id}">Open the task</a></div></div>
    <div class="principle" style="margin-bottom:16px">${icon('eye')}<span>Each step is a recorded fact with its source and author. The stage it sits in is TeamPulse’s rule-based reading. <b>Suggestions</b> and <b>missing steps</b> are labelled and never filled in.</span></div>
    <section class="card"><div class="stage-strip" role="list">${j.stages.map((s) => html`<a class="stage ${s.reached ? 'on' : ''} ${['blocked', 'rework'].includes(s.key) ? 'side' : ''}" role="listitem" href="#st-${s.key}" ${s.reached ? '' : raw('aria-disabled="true"')}><span>${s.label}</span><small>${byStage(s.key).length ? `${byStage(s.key).length} step(s)` : 'not evidenced'}</small></a>`)}</div></section>
    <div class="grid side" style="margin-top:16px">
      <section class="card"><div class="card-head"><h2>Timeline</h2>${prov('fact', 'From records')}</div>
        <ol class="journey">${j.steps.map((s) => html`<li class="step st-${s.stage}" id="${byStage(s.stage)[0] === s ? `st-${s.stage}` : ''}">
          <div class="step-head">${sourceTile(s.source)}<span class="small muted">${SRC[s.source] || s.source}</span><span class="badge ${s.stage === 'outcome' && s.verified ? 'ok' : ['blocked', 'rework'].includes(s.stage) ? 'warn' : 'brand'}">${STAGE_LABEL[s.stage] || s.stage}</span>${stepProvenance(s)}
            ${s.disputed ? html`<span class="badge warn">authorship disputed</span>` : ''}${s.shared ? html`<span class="badge outline">shared</span>` : ''}${s.outsideControl ? html`<span class="badge info">outside their control</span>` : ''}</div>
          <div class="step-title"><a href="${s.href}" ${/^https?:/.test(s.href) ? raw('target="_blank" rel="noopener noreferrer"') : ''}><b>${s.title}</b></a></div>
          ${s.detail ? html`<div class="small pre step-detail">${s.detail}</div>` : ''}
          <div class="meta" style="margin-top:4px">${s.author?.name ? html`<span class="row nowrap" style="gap:6px">${avatar(s.author.name, null, 'sm')}${s.author.name}</span>` : html`<span>unknown</span>`}${s.author?.external ? html`<span>(outside the organization)</span>` : s.author?.unknown ? html`<span>(not known to TeamPulse)</span>` : ''}<span class="sep"></span><span>${dt(s.at)}</span></div>
          ${s.linkIds?.length && (j.task.ownerId === app.me.id || app.isManager) ? html`<div class="row" style="gap:6px;margin-top:6px"><button class="btn small link" data-unlink="${s.linkIds.join(',')}">Not part of this work</button></div>` : ''}
        </li>`)}</ol></section>
      <div class="stack">
        <section class="card"><div class="card-head"><h2><span class="card-icon">${icon('team')}</span>Contributors</h2></div><ul class="list">${j.contributors.map((c) => html`<li>${avatar(c.name, null, 'sm')}<div class="grow"><b>${c.name}</b><div class="small muted">${c.roles.join(', ')}</div></div></li>`)}</ul>
          <p class="small muted" style="margin:10px 0 0">Shared outcomes are counted once; each person’s part stays theirs.</p></section>
        <section class="card"><div class="card-head"><h2><span class="card-icon">${icon('help')}</span>What is missing</h2>${prov('missing', 'Not recorded')}</div>${j.missing.length ? html`<ul class="plain">${j.missing.map((m) => html`<li>• ${m}</li>`)}</ul>` : html`<p class="small" style="margin:0">Nothing obvious — the journey is evidenced from start to outcome.</p>`}</section>
        ${j.possibleLinks.length ? html`<section class="card"><div class="card-head"><h2><span class="card-icon brand">${icon('sparkles')}</span>Possibly part of this work</h2>${prov('suggested')}</div><ul class="list">${j.possibleLinks.map((p) => html`<li>${sourceTile(p.app)}<div class="grow"><div>${p.title}</div><div class="small muted">${p.method.replace('_', ' ')}, ${Math.round(p.confidence * 100)}% — not counted until confirmed</div>
          <div class="row" style="gap:6px;margin-top:8px"><button class="btn small" data-link-act="CONFIRM" data-link="${p.linkId}">${icon('check')}It belongs here</button><button class="btn small ghost" data-link-act="REJECT" data-link="${p.linkId}">No</button></div></div></li>`)}</ul></section>` : ''}
        ${j.related.length ? html`<section class="card"><div class="card-head"><h2>Related work</h2></div><ul class="plain">${j.related.map((r) => html`<li><a href="#/journey/${r.id}">${r.title}</a></li>`)}</ul></section>` : ''}
        <section class="card"><div class="card-head"><h2><span class="card-icon brand">${icon('intelligence')}</span>Assessment</h2></div>${j.assessment ? html`<p>${j.assessment.complexity ? html`<span class="badge brand">${j.assessment.complexity}</span> ` : ''}${j.assessment.evidenceState} evidence · manager ${j.assessment.managerStatus.toLowerCase()}${j.assessment.simulated ? ' · simulated' : ''}</p><a class="small" href="#/tasks/${j.task.id}">See reasons and evidence ${icon('arrowRight', 'xs')}</a>` : html`<p class="small muted" style="margin:0">Not analysed yet. The analysis on the task page is the source of truth for complexity and quality.</p>`}</section>
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
