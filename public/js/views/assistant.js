// The AI Work Assistant (employees, and managers for their own work), the Manager Copilot panel, and the signal list
// used on dashboards and reviews. Answers come from KONVO records and say so; the AI only writes an optional
// summary, when the server allows it.
import { api, html, raw, toast, errorText, empty, loading, confirmDialog, icon, prov, appTile, avatar, ago } from '../ui.js'
import { app } from '../app.js'

const tz = () => -new Date().getTimezoneOffset()
const today = () => new Date(Date.now() + tz() * 60000).toISOString().slice(0, 10)
const SEV = { high: ['Important', 'bad'], medium: ['Worth a look', 'warn'], low: ['FYI', 'outline'] }

function answerBlock(a, question) {
  // Pending confirmation: show Confirm and Cancel buttons (uses server-issued confirmToken)
  const confirmSection = a.pendingConfirmation && a.confirmToken
    ? html`<div class="copilot-action-row" style="margin-top:12px"><button class="btn brand" data-confirm-token="${a.confirmToken}" data-confirm-intent="${a.intent}">${icon('check')}Confirm</button><button class="btn subtle" data-cancel-confirm>Cancel</button></div>`
    : ''
  // Team selection: clickable team chips
  const teamSelectSection = a.pendingTeamSelection
    ? html`<div class="chips" style="margin-top:10px">${a.items.map((i) => html`<button class="chip brand" data-select-team="${i.teamId}" data-select-email="${i.email}" data-select-intent="${i.intent}">${i.text}</button>`)}</div>`
    : ''
  // Not found: invite to workspace button
  const inviteSection = a.notFound && a.email && !a.pendingConfirmation
    ? html`<div class="copilot-invite-box" style="margin-top:14px;padding:14px;background:var(--surface-2,#f5f5f4);border-radius:8px;border:1px solid var(--border,#e7e7e5)">
        <p style="margin:0 0 10px"><b>This person is not in your workspace.</b> Send them an invitation link to join before adding them to your team.</p>
        <button class="btn brand" data-invite-email="${a.email}">${icon('send')}Invite to Workspace</button>
        <div class="copilot-invite-result" style="margin-top:10px"></div>
      </div>`
    : ''
  return html`<div class="turn">${question ? html`<div class="ask-bubble"><span class="sr">You asked: </span>${question}</div>` : ''}
    <div class="answer card flat"><h3>${a.title}</h3><p>${a.answer}</p>
    ${!a.pendingTeamSelection && a.items?.length ? html`<ul class="list">${a.items.map((i) => html`<li><div class="grow" style="min-width:0">${i.href ? html`<a href="${i.href}" ${/^https?:/.test(i.href) ? raw('target="_blank" rel="noopener noreferrer"') : ''}><b>${i.text}</b></a>` : html`<b>${i.text}</b>`}
      ${i.detail ? html`<div class="small muted">${i.detail}</div>` : ''}${i.taskId ? html`<button class="btn small link" data-ask-task="${i.taskId}">Find evidence for this</button>` : ''}</div>${i.severity ? html`<span class="badge ${SEV[i.severity][1]}">${SEV[i.severity][0]}</span>` : ''}</li>`)}</ul>` : ''}
    ${teamSelectSection}
    ${confirmSection}
    ${inviteSection}
    ${a.suggestions?.length ? html`<div class="chips">${a.suggestions.map((s) => html`<button class="chip" data-intent="${s.intent}">${s.label}</button>`)}</div>` : ''}
    ${a.journeyHref ? html`<p class="small" style="margin:10px 0 0"><a href="${a.journeyHref}">See the whole contribution journey ${icon('arrowRight', 'xs')}</a></p>` : ''}
    <div class="answer-foot">${prov('fact', 'From records')}<span class="small muted">${a.note || 'Answered from your KONVO records and linked evidence — not generated text.'}</span></div></div></div>`
}

/** A question box bound to /api/assistant/ask. team=true → Manager Copilot. Answers stack up as a conversation. */
export function questionBox(box, { team = false, suggestions = [] }) {
  const id = team ? 'team' : 'mine'
  box.innerHTML = html`<form class="ask-form" id="ask-${id}"><label class="sr" for="q-${id}">${team ? 'Ask about your team' : 'Ask about your work'}</label>
      <input id="q-${id}" name="question" type="text" maxlength="300" placeholder="${team ? 'Ask about your team, e.g. Who is blocked and why?' : 'Ask about your work, e.g. What should I focus on next?'}" autocomplete="off"><button class="btn" type="submit">${icon('send')}Ask</button></form>
    ${suggestions.length ? html`<div class="chips suggestions" aria-label="Suggested questions">${suggestions.map((s) => html`<button type="button" class="chip" data-intent="${s.intent}">${s.label}</button>`)}</div>` : ''}
    <div class="ask-out" aria-live="polite"></div>`.toString()
  const out = box.querySelector('.ask-out')
  let inFlight = false
  const run = async (body, shown) => {
    if (inFlight) return
    inFlight = true
    const submitBtn = box.querySelector('form button[type=submit]')
    if (submitBtn) submitBtn.disabled = true
    const pending = document.createElement('div')
    pending.className = 'turn'
    pending.innerHTML = html`${shown ? html`<div class="ask-bubble">${shown}</div>` : ''}<div class="answer card flat"><span class="loading-label"><span class="spinner" aria-hidden="true"></span>Looking through your records…</span><span class="skel" style="margin-top:10px"></span><span class="skel" style="width:70%;margin-top:8px"></span></div>`.toString()
    out.prepend(pending)
    try {
      const a = await api('/api/assistant/ask', { method: 'POST', body: { ...body, team, tz: tz() } })
      pending.outerHTML = answerBlock(a, shown).toString()
    } catch (e) { pending.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() }
    finally { inFlight = false; if (submitBtn) submitBtn.disabled = false }
  }
  // Use named handlers so we can deduplicate if questionBox is called more than once on the same element.
  const onSubmit = (e) => { e.preventDefault(); const q = e.target.question.value.trim(); if (q) { run({ question: q }, q); e.target.question.value = '' } }
  const onAsk = (e) => run({ intent: e.detail.intent, question: e.detail.shown }, e.detail.shown)
  const onClick = (e) => {
    const chip = e.target.closest('[data-intent]')
    if (chip) { e.preventDefault(); run({ intent: chip.dataset.intent, question: chip.textContent }, chip.textContent.trim()) }
    const t = e.target.closest('[data-ask-task]')
    if (t) run({ intent: 'find_evidence', taskId: t.dataset.askTask }, 'Find evidence for this task')
    // Confirm a pending team-management action (server-issued token)
    const confirmBtn = e.target.closest('[data-confirm-token]')
    if (confirmBtn && !confirmBtn.disabled) {
      e.preventDefault()
      run({ intent: confirmBtn.dataset.confirmIntent, confirmToken: confirmBtn.dataset.confirmToken }, 'Confirm')
    }
    // Cancel a pending confirmation (remove just the action row)
    const cancelBtn = e.target.closest('[data-cancel-confirm]')
    if (cancelBtn) { e.preventDefault(); cancelBtn.closest('.copilot-action-row')?.remove() }
    // Select a team for add_to_team
    const teamBtn = e.target.closest('[data-select-team]')
    if (teamBtn && !teamBtn.disabled) {
      e.preventDefault()
      run({ intent: teamBtn.dataset.selectIntent || 'add_to_team', question: teamBtn.dataset.selectEmail ? `Add ${teamBtn.dataset.selectEmail} to my team` : '', teamId: teamBtn.dataset.selectTeam }, `Add to ${teamBtn.textContent.trim()}`)
    }
    // Invite to workspace
    const inviteBtn = e.target.closest('[data-invite-email]')
    if (inviteBtn && !inviteBtn.disabled) {
      e.preventDefault()
      inviteBtn.disabled = true
      inviteBtn.textContent = 'Sending invitation…'
      const email = inviteBtn.dataset.inviteEmail
      const resultBox = inviteBtn.closest('.copilot-invite-box')?.querySelector('.copilot-invite-result')
      api('/api/invitations', { method: 'POST', body: { email, role: 'employee' } })
        .then((inv) => {
          if (resultBox) {
            const link = inv.link || ''
            resultBox.innerHTML = html`<div class="notice ok" style="margin:0"><b>Invitation created for ${inv.email}.</b><br>Share this link with them:</div>
              <div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap"><code class="small" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--surface-1,#fff);border:1px solid var(--border,#e7e7e5);border-radius:4px;padding:4px 8px">${link}</code>
              <button class="btn small ghost" data-copy-link="${link}">${icon('copy', 'xs')}Copy Link</button></div>`.toString()
          }
          inviteBtn.remove()
        })
        .catch((err) => {
          if (resultBox) resultBox.innerHTML = html`<div class="notice err">${errorText(err)}</div>`.toString()
          inviteBtn.disabled = false
          inviteBtn.innerHTML = `${icon('send')}Invite to Workspace`
        })
    }
    // Copy invitation link
    const copyBtn = e.target.closest('[data-copy-link]')
    if (copyBtn) {
      e.preventDefault()
      navigator.clipboard?.writeText(copyBtn.dataset.copyLink).then(() => toast('Link copied!')).catch(() => toast('Copy failed — select the link manually.', { error: true }))
    }
  }
  if (!box.dataset.qbWired) {
    box.dataset.qbWired = '1'
    box.addEventListener('ask', onAsk)
    box.addEventListener('click', onClick)
  }
  box.querySelector('form').addEventListener('submit', onSubmit)
}

const WHY = {
  stalled: 'Work that stops moving quietly slips; a short check-in usually reveals what is in the way.',
  deadline: 'A deadline is close and progress is behind it — an early conversation is cheaper than a late miss.',
  blocker: 'Blocked work waits on someone else. The longer it waits, the more the plan around it slips.',
  rework: 'Repeated change requests usually mean unclear acceptance criteria, not poor effort.',
  unverified_impact: 'An outcome nobody verified is only a claim; it cannot be counted as verified impact.',
  missing_evidence: 'Finished work with nothing showing it or its result is invisible to analyses.',
  duplicate_effort: 'Two people may be solving the same problem — worth a quick check before more time goes in.',
  unlinked_work: 'Merged work that is not linked to a task cannot be credited to the work it belongs to.',
  awaiting_review: 'People are waiting on a decision only you can make.'
}
const STATE = { OPEN: ['Open', 'outline'], DISMISSED: ['Dismissed', 'outline'], RESOLVED: ['Resolved', 'ok'] }

/**
 * Signals with dismiss / resolve. Compact (dashboards) or detailed (the Reviews workspace: why it matters, who is affected,
 * supporting context, state and history). Restrained: only "important" ones carry a colour label.
 */
export async function renderSignals(box, { scope = 'mine', limit = 8, title = null, subtitle = null, status = 'OPEN', detail = false } = {}) {
  if (!box?.isConnected) return // the page this belonged to is gone
  let rows
  try { rows = await api(`/api/signals?scope=${scope}${status !== 'OPEN' ? `&status=${status}` : ''}`) } catch (e) { if (!box.isConnected) return; box.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
  if (!box.isConnected) return // the page was replaced while the signals loaded
  const shown = rows.slice(0, limit)
  const again = () => renderSignals(box, { scope, limit, title, subtitle, status, detail })
  box.innerHTML = html`${title ? html`<div class="card-head"><div><h2><span class="card-icon warn">${icon('target')}</span>${title}</h2><p>${subtitle || 'Detected from your records by fixed rules — to help you act, never as a penalty.'}</p></div>${rows.length > limit ? html`<a class="btn small subtle" href="${scope === 'team' ? '#/reviews?tab=signals' : '#/assistant'}">All ${rows.length}${icon('arrowRight', 'sm')}</a>` : ''}</div>` : ''}
    ${shown.length ? html`<ul class="signal-list">${shown.map((s) => html`<li class="signal sev-${s.severity} state-${s.status.toLowerCase()}" data-signal="${s.id}"><span class="sev" aria-hidden="true"></span>
      <div class="body"><div class="title"><span>${s.kindLabel}</span>${s.severity === 'high' ? html`<span class="badge bad">${SEV.high[0]}</span>` : s.severity === 'low' ? html`<span class="badge outline">${SEV.low[0]}</span>` : html`<span class="sr">${SEV.medium[0]}</span>`}${s.status !== 'OPEN' ? html`<span class="badge ${STATE[s.status][1]}">${STATE[s.status][0]}</span>` : ''}${s.personName && scope === 'team' ? html`<span class="small muted row nowrap" style="gap:6px">${avatar(s.personName, null, 'sm')}<a href="#/contribution/${s.personId}">${s.personName}</a></span>` : ''}</div>
        <div class="why">${s.task ? html`<a href="#/tasks/${s.task.id}">${s.task.title}</a> — ` : ''}${s.reason}</div>
        ${detail ? html`<div class="sig-detail"><div><span class="sig-label">Why it matters</span><span>${WHY[s.kind] || ''}</span></div>
          ${s.evidence.length ? html`<div><span class="sig-label">Supporting context</span><span class="chips" style="margin:0">${s.evidence.map((x) => (x.href ? html`<a class="chip" href="${x.href}" ${/^https?:/.test(x.href) ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${x.label}</a>` : html`<span class="chip">${x.label}${x.at ? ` · ${ago(x.at)}` : ''}</span>`))}</span></div>` : ''}
          <div><span class="sig-label">First noticed</span><span>${ago(s.firstSeenAt)}${s.lastSeenAt !== s.firstSeenAt ? ` · still seen ${ago(s.lastSeenAt)}` : ''}</span></div>
          ${s.history.some((h) => h.by) ? html`<div><span class="sig-label">History</span><span>${s.history.filter((h) => h.by).map((h) => `${h.event} by ${h.by} ${ago(h.at)}${h.reason ? `: “${h.reason}”` : ''}`).join(' · ')}</span></div>` : ''}</div>` : ''}
        ${s.status === 'OPEN' ? html`<div class="next">${icon('arrowRight')}<span><b>Recommended:</b> ${s.action}</span></div>
        <div class="actions"><button class="btn small ghost" data-sig-act="RESOLVE">${icon('check')}Done</button><button class="btn small subtle" data-sig-act="DISMISS">Dismiss</button></div>` : ''}</div></li>`)}</ul>`
      : empty(status === 'OPEN' ? 'Nothing needs attention' : `No ${STATE[status][0].toLowerCase()} signals`, status !== 'OPEN' ? 'They appear here with the reason and who closed them.' : scope === 'team' ? 'No stalled work, risky deadlines, long blockers or waiting reviews in your teams.' : 'No stalled work, risky deadlines or missing evidence.', '', 'checkCircle')}`.toString()
  box.querySelectorAll('[data-sig-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('[data-signal]').dataset.signal
    let reason
    if (b.dataset.sigAct === 'DISMISS') { const r = await confirmDialog({ title: 'Dismiss this signal?', body: 'It stays dismissed even if the condition continues. Your reason is kept in its history.', confirm: 'Dismiss', reason: { label: 'Why?', required: true } }); if (!r?.ok) return; reason = r.reason }
    try { await api(`/api/signals/${id}`, { method: 'POST', body: { action: b.dataset.sigAct, reason } }); toast(b.dataset.sigAct === 'DISMISS' ? 'Dismissed.' : 'Marked done.'); again(); app.refreshCounts?.() } catch (e) { toast(errorText(e), { error: true }) }
  }))
}

/** Manager Copilot: questions about the team, answered from records with links. */
const COPILOT_QUESTIONS = [
  ['attention', 'Who needs my attention today?', 'target'], ['blocked', 'What work is currently blocked?', 'blocked'], ['review', 'Which contributions need review?', 'reviews'],
  ['team_week', 'What has moved forward this week?', 'trending'], ['help', 'Where can I help the team?', 'heart'],
  ['complex_solved', 'Which complex problems were solved?', 'intelligence'], ['verified', 'Which outcomes are verified?', 'shield'], ['delays', 'Where is work getting delayed?', 'clock']
]
export async function renderCopilot(main) {
  main.innerHTML = html`<div class="page-head"><div><div class="eyebrow">${icon('copilot', 'xs')}Manager Copilot</div><h1>Ask about your team</h1><p>Answers come from your team’s tasks, reviews, signals and linked evidence — each item links to its record. The Copilot never ranks or scores people.</p></div></div>
    <div class="assistant-layout copilot-layout"><section class="card"><div id="copilot"></div></section>
      <aside class="stack"><div class="principle">${icon('shield')}<span>Grounded in KONVO records only. If something is not recorded, the Copilot says so instead of guessing.</span></div>
        <section class="card"><div class="card-head"><h2><span class="card-icon brand">${icon('sparkles')}</span>Try asking</h2></div><div class="q-cards" id="q-cards">${COPILOT_QUESTIONS.map(([k, l, ic]) => html`<button type="button" class="q-card" data-intent="${k}"><span class="lead-icon">${icon(ic)}</span><span>${l}</span></button>`)}</div></section></aside></div>`.toString()
  const box = main.querySelector('#copilot')
  questionBox(box, { team: true, suggestions: [] })
  main.querySelector('#q-cards').addEventListener('click', (e) => { const b = e.target.closest('[data-intent]'); if (b) box.dispatchEvent(new CustomEvent('ask', { detail: { intent: b.dataset.intent, shown: b.textContent.trim() } })) })
}

const LANES = [['completed', 'Completed', 'checkCircle', 'ok'], ['delivered', 'Delivered for review', 'send', 'brand'], ['progressed', 'Moved forward', 'trending', ''], ['blocked', 'Blocked', 'blocked', 'bad']]
const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

function laneCard([key, title, ic, tone], list) {
  if (!list.length) return ''
  return html`<section class="card lane" aria-labelledby="lane-${key}"><div class="card-head"><h2 id="lane-${key}"><span class="card-icon ${tone}">${icon(ic)}</span>${title}</h2><span class="badge outline">${list.length}</span></div>
    <ul class="mini-list">${list.map((i) => html`<li><div class="grow"><a class="ttl" href="${i.href}">${i.title}</a>${i.complexity ? html` <span class="badge brand" title="Assessed complexity">${i.complexity}</span>` : ''}
      ${i.notes.length ? html`<div class="note-line">${prov('self', 'Your note')}<span>${i.notes.at(-1)}</span></div>` : ''}
      ${i.evidence.length ? html`<div class="ev-chips">${i.evidence.map((x) => html`<a class="chip ev ${x.linked ? 'linked' : 'unlinked'}" href="${x.href}" ${/^https?:/.test(x.href) ? raw('target="_blank" rel="noopener noreferrer"') : ''} title="${x.linked ? 'Linked to this task' : 'Suggested, not confirmed'}">${appTile(x.app, 'xs')}<span class="clip">${x.title}</span>${x.linked ? icon('check', 'xs') : ''}</a>`)}</div>` : ''}
      ${key === 'blocked' ? html`<div class="small muted" style="margin-top:4px">Blocked time is a reason, not a fault.</div>` : ''}</div></li>`)}</ul></section>`
}

function digestBlock(d) {
  const any = d.completed.length + d.delivered.length + d.progressed.length + d.blocked.length
  return html`<section class="card day-hero" aria-labelledby="day-h"><div class="card-head"><div><div class="eyebrow">${icon('calendar', 'xs')}${dayLabel(d.day)}</div><h2 id="day-h">Your day — ${d.day}</h2></div>${prov('fact', 'Built from your records')}</div>
      <p class="digest-summary">${d.summary}</p>
      <p class="small muted" style="margin:0">${d.note}</p>
      ${!any ? html`<div class="suggest-block" style="margin-top:14px"><b>Nothing was recorded for this day.</b><div class="small muted">If you worked on something, add a progress note on the task or link evidence from your apps so it is visible.</div><div class="row" style="margin-top:8px"><a class="btn small ghost" href="#/my-tasks">${icon('tasks')}My tasks</a><a class="btn small ghost" href="#/evidence">${icon('evidence')}My Work Evidence</a></div></div>` : ''}
    </section>
    ${any ? html`<div class="lanes">${LANES.map((l) => laneCard(l, d[l[0]]))}</div>` : ''}
    ${d.highlights.length ? html`<section class="card" style="margin-top:16px"><div class="card-head"><div><h2><span class="card-icon brand">${icon('award')}</span>Contributions that mattered</h2><p>Why these stand out today — stated plainly, never scored.</p></div>${prov('fact', 'Rule-based')}</div>
      <ul class="mini-list">${d.highlights.map((h) => html`<li><span class="lead-icon brand">${icon('sparkles')}</span><div class="grow"><a class="ttl" href="${h.href}">${h.text}</a>${h.complexity ? html` <span class="badge brand">${h.complexity}</span>` : ''}<div class="small muted">${h.why}</div></div></li>`)}</ul></section>` : ''}
    <div class="grid two" style="margin-top:16px">
      <section class="card" aria-labelledby="miss-h"><div class="card-head"><div><h2 id="miss-h"><span class="card-icon">${icon('help')}</span>Missing context</h2><p>Small additions that make your work visible.</p></div>${prov('missing', 'Not recorded')}</div>
        ${d.missing.length ? html`<ul class="mini-list">${d.missing.map((m) => html`<li><div class="grow"><a class="ttl" href="${m.href}">${m.text}</a><div class="small muted">${m.action}</div></div></li>`)}</ul>` : html`<p class="small muted" style="margin:0">Nothing missing — your day is well evidenced.</p>`}</section>
      <section class="card" aria-labelledby="next-h"><div class="card-head"><div><h2 id="next-h" class="sr">Next priorities</h2><h3 style="display:flex;align-items:center;gap:8px"><span class="card-icon teal">${icon('target')}</span>Next priorities</h3><p>Most urgent first.</p></div>${prov('fact', 'From your tasks')}</div>
        ${d.priorities.length ? html`<ol class="focus-list">${d.priorities.map((p) => html`<li><div style="min-width:0"><a href="${p.href}">${p.text}</a><div class="why">${p.why}</div></div></li>`)}</ol>` : html`<p class="small muted" style="margin:0">Nothing urgent. A good moment to pick up something new.</p>`}</section>
    </div>
    <div id="ai-writeup" style="margin-top:16px"></div>`
}

export async function renderAssistant(main, q) {
  const day = q.get('day') || today()
  main.innerHTML = loading().toString()
  const [sugg] = await Promise.all([api('/api/assistant/suggestions')])
  const yesterday = new Date(Date.now() + tz() * 60000 - 86400000).toISOString().slice(0, 10)
  main.innerHTML = html`<div class="page-head"><div><div class="eyebrow">${icon('sparkles', 'xs')}Analyse my day</div><h1>AI Work Assistant</h1><p>Understand your work without writing reports: what you did, what mattered, what is missing and what to do next — from your tasks and the evidence you chose to collect.</p></div></div>
    <div class="assistant-layout">
      <div class="assistant-main">
        <section class="card"><form class="row day-form" id="day-form"><div class="segmented" role="group" aria-label="Quick pick"><button type="button" data-pick="${today()}" aria-pressed="${day === today()}">Today</button><button type="button" data-pick="${yesterday}" aria-pressed="${day === yesterday}">Yesterday</button></div>
          <div class="field" style="margin:0"><label for="day" class="sr">Day</label><input id="day" name="day" type="date" value="${day}" max="${today()}"></div>
          <button class="btn" type="submit" id="analyse-day">${icon('sparkles')}Analyse my day</button><a class="btn subtle" href="#/evidence">${icon('evidence')}My Work Evidence</a></form></section>
        <div id="digest" style="margin-top:16px"></div>
      </div>
      <aside class="assistant-side" aria-label="Ask about your work">
        <section class="card ask-panel"><div class="card-head"><div><h2><span class="card-icon brand">${icon('message')}</span>Ask about your work</h2><p>Answers come from your records, with a link to each one.</p></div></div><div id="ask-box"></div></section>
        <section class="card" id="my-signals" style="margin-top:16px"></section>
      </aside>
    </div>`.toString()
  questionBox(main.querySelector('#ask-box'), { suggestions: sugg.mine })
  renderSignals(main.querySelector('#my-signals'), { scope: 'mine', title: 'Needs your attention' })
  const show = async (d) => {
    const box = main.querySelector('#digest')
    box.innerHTML = loading('Reading your day…').toString()
    try {
      const dg = await api(`/api/assistant/day?day=${encodeURIComponent(d)}&tz=${tz()}`)
      box.innerHTML = digestBlock(dg).toString()
      const ai = box.querySelector('#ai-writeup')
      if (sugg.ai && (dg.completed.length + dg.delivered.length + dg.progressed.length + dg.blocked.length)) {
        ai.innerHTML = html`<div class="ai-block"><div class="row between"><div><b>Want a written summary?</b><div class="small muted">Optional. An AI writes it using only the facts above and may be wrong — it is labelled as an interpretation.</div></div><button class="btn small ghost" id="write-up">${icon('sparkles')}Write it up with AI</button></div></div>`.toString()
        ai.querySelector('#write-up').addEventListener('click', async (e) => {
          e.currentTarget.disabled = true
          try {
            const r = await api('/api/assistant/day/ai', { method: 'POST', body: { day: d, tz: tz() } })
            ai.innerHTML = r.ai ? html`<div class="ai-block"><div class="row" style="gap:8px;margin-bottom:6px">${prov('ai')}<span class="small muted">${r.ai.simulated ? 'SIMULATED (development only, not AI)' : `${r.ai.provider} · ${r.ai.model}`}</span></div><p style="margin:0 0 6px">${r.ai.summary}</p>${r.ai.highlights.length ? html`<ul class="plain small">${r.ai.highlights.map((h) => html`<li><a href="${h.href}">${h.text}</a></li>`)}</ul>` : ''}<div class="small muted" style="margin-top:6px">An interpretation of the records above, not a record itself.</div></div>`.toString() : '<p class="small muted">Nothing to write up.</p>'
          } catch (err) { ai.innerHTML = html`<div class="notice">${errorText(err)}</div>`.toString() }
        })
      } else if (!sugg.ai) ai.innerHTML = '<p class="small muted">AI write-ups are not available on this server right now; the analysis above is complete without them.</p>'
    } catch (e) { box.innerHTML = html`<div class="notice err">${errorText(e)} <button class="btn small ghost" id="retry-day">Retry</button></div>`.toString(); box.querySelector('#retry-day').onclick = () => show(d) }
  }
  const go = (d) => { history.replaceState(null, '', `#/assistant?day=${d}`); main.querySelector('#day').value = d; main.querySelectorAll('[data-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === d))); show(d) }
  main.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => go(b.dataset.pick)))
  main.querySelector('#day-form').addEventListener('submit', (e) => { e.preventDefault(); go(e.target.day.value || today()) })
  if (q.get('day') || q.get('run')) show(day)
  else main.querySelector('#digest').innerHTML = html`<section class="card digest-empty">${empty('See your day in one view', 'Press Analyse my day to see what you completed, delivered and moved forward, what mattered, what is missing and what to do next.', '', 'sparkles')}</section>`.toString()
  void app; void avatar
}
