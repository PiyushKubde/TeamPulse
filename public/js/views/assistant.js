// The AI Work Assistant (employees, and managers for their own work), the Manager Copilot panel, and the signal list
// used on dashboards and reviews. Answers come from TeamPulse records and say so; the AI only writes an optional
// summary, when the server allows it.
import { api, html, raw, toast, errorText, empty, loading, confirmDialog } from '../ui.js'
import { app } from '../app.js'

const tz = () => -new Date().getTimezoneOffset()
const today = () => new Date(Date.now() + tz() * 60000).toISOString().slice(0, 10)
const SEV = { high: ['Important', 'bad'], medium: ['Worth a look', 'warn'], low: ['FYI', 'outline'] }

function answerBlock(a) {
  return html`<div class="answer"><h3>${a.title}</h3><p>${a.answer}</p>
    ${a.items?.length ? html`<ul class="list">${a.items.map((i) => html`<li><div class="grow" style="min-width:0">${i.href ? html`<a href="${i.href}" ${/^https?:/.test(i.href) ? raw('target="_blank" rel="noopener noreferrer"') : ''}><b>${i.text}</b></a>` : html`<b>${i.text}</b>`}
      ${i.detail ? html`<div class="small muted">${i.detail}</div>` : ''}${i.taskId ? html`<button class="btn small link" data-ask-task="${i.taskId}">Find evidence for this</button>` : ''}</div>${i.severity ? html`<span class="badge ${SEV[i.severity][1]}">${SEV[i.severity][0]}</span>` : ''}</li>`)}</ul>` : ''}
    ${a.suggestions?.length ? html`<div class="chips">${a.suggestions.map((s) => html`<button class="chip" data-intent="${s.intent}">${s.label}</button>`)}</div>` : ''}
    ${a.journeyHref ? html`<p class="small"><a href="${a.journeyHref}">See the whole contribution journey →</a></p>` : ''}
    <p class="small muted">${a.note || 'Answered from your TeamPulse records and linked evidence — not generated text.'}</p></div>`
}

/** A question box bound to /api/assistant/ask. team=true → Manager Copilot. */
export function questionBox(box, { team = false, suggestions = [] }) {
  box.innerHTML = html`<form class="ask-form" id="ask-${team ? 'team' : 'mine'}"><label class="sr" for="q-${team ? 'team' : 'mine'}" style="position:absolute;left:-999px">Ask</label>
      <input id="q-${team ? 'team' : 'mine'}" name="question" type="text" maxlength="300" placeholder="${team ? 'Ask about your team, e.g. Who is blocked and why?' : 'Ask about your work, e.g. What should I focus on next?'}" autocomplete="off"><button class="btn" type="submit">Ask</button></form>
    <div class="chips" style="margin:8px 0">${suggestions.map((s) => html`<button class="chip" data-intent="${s.intent}">${s.label}</button>`)}</div>
    <div class="ask-out" aria-live="polite"></div>`.toString()
  const out = box.querySelector('.ask-out')
  const run = async (body) => {
    out.innerHTML = loading('Looking through your records…').toString()
    try { out.innerHTML = answerBlock(await api('/api/assistant/ask', { method: 'POST', body: { ...body, team, tz: tz() } })).toString() } catch (e) { out.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString() }
  }
  box.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.question.value.trim(); if (q) run({ question: q }) })
  box.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-intent]')
    if (chip) { e.preventDefault(); run({ intent: chip.dataset.intent, question: chip.textContent }) }
    const t = e.target.closest('[data-ask-task]')
    if (t) run({ intent: 'find_evidence', taskId: t.dataset.askTask })
  })
}

/** Signals as a list with dismiss / resolve. */
export async function renderSignals(box, { scope = 'mine', limit = 8, title = null } = {}) {
  let rows
  try { rows = await api(`/api/signals?scope=${scope}`) } catch (e) { box.innerHTML = html`<div class="notice err">${errorText(e)}</div>`.toString(); return }
  const shown = rows.slice(0, limit)
  box.innerHTML = html`${title ? html`<div class="card-head"><div><h2>${title}</h2><p>Detected from your records by fixed rules — help to act, never a penalty.</p></div></div>` : ''}
    ${shown.length ? html`<ul class="list">${shown.map((s) => html`<li data-signal="${s.id}"><div class="grow" style="min-width:0"><div class="row" style="gap:6px"><span class="badge ${SEV[s.severity][1]}">${SEV[s.severity][0]}</span><b>${s.kindLabel}</b>${s.personName && scope === 'team' ? html`<span class="small muted">${s.personName}</span>` : ''}</div>
      <div>${s.task ? html`<a href="#/tasks/${s.task.id}">${s.task.title}</a> — ` : ''}${s.reason}</div><div class="small muted">Next: ${s.action}</div></div>
      <div class="row" style="gap:6px"><button class="btn small ghost" data-sig-act="RESOLVE">Done</button><button class="btn small link" data-sig-act="DISMISS">Dismiss</button></div></li>`)}</ul>${rows.length > limit ? html`<p class="small"><a href="${scope === 'team' ? '#/reviews' : '#/assistant'}">All ${rows.length} →</a></p>` : ''}`
      : empty('Nothing needs attention', scope === 'team' ? 'No stalled work, risky deadlines, long blockers or waiting reviews in your teams.' : 'No stalled work, risky deadlines or missing evidence.')}`.toString()
  box.querySelectorAll('[data-sig-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('[data-signal]').dataset.signal
    let reason
    if (b.dataset.sigAct === 'DISMISS') { const r = await confirmDialog({ title: 'Dismiss this signal?', body: 'It stays dismissed even if the condition continues. Your reason is kept in its history.', confirm: 'Dismiss', reason: { label: 'Why?', required: true } }); if (!r?.ok) return; reason = r.reason }
    try { await api(`/api/signals/${id}`, { method: 'POST', body: { action: b.dataset.sigAct, reason } }); toast(b.dataset.sigAct === 'DISMISS' ? 'Dismissed.' : 'Marked done.'); renderSignals(box, { scope, limit, title }) } catch (e) { toast(errorText(e), { error: true }) }
  }))
}

function digestBlock(d) {
  const group = (title, list, tone) => (list.length ? html`<div class="digest-group"><div class="row" style="gap:6px"><b>${title}</b><span class="badge ${tone}">${list.length}</span></div><ul class="plain">${list.map((i) => html`<li><a href="${i.href}">${i.title}</a>${i.complexity ? html` <span class="badge brand">${i.complexity}</span>` : ''}
    ${i.notes.length ? html`<div class="small muted">${i.notes.at(-1)}</div>` : ''}${i.evidence.length ? html`<div class="chips">${i.evidence.map((x) => html`<a class="chip" href="${x.href}" ${/^https?:/.test(x.href) ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${x.title}</a>`)}</div>` : ''}</li>`)}</ul></div>` : '')
  return html`<section class="card"><div class="card-head"><div><h2>Your day — ${d.day}</h2><p>${d.note}</p></div></div>
    <p class="digest-summary">${d.summary}</p>
    <div class="grid two" style="gap:12px">${group('Completed', d.completed, 'ok')}${group('Delivered for review', d.delivered, 'brand')}${group('Moved forward', d.progressed, 'info')}${group('Blocked', d.blocked, 'warn')}</div>
    ${d.highlights.length ? html`<h3 style="margin:14px 0 6px">Meaningful contributions</h3><ul class="plain">${d.highlights.map((h) => html`<li><a href="${h.href}"><b>${h.text}</b></a> — <span class="small">${h.why}</span></li>`)}</ul>` : ''}
    ${d.missing.length ? html`<h3 style="margin:14px 0 6px">Missing context</h3><ul class="plain">${d.missing.map((m) => html`<li><a href="${m.href}">${m.text}</a> <span class="small muted">${m.action}</span></li>`)}</ul>` : ''}
    ${d.priorities.length ? html`<h3 style="margin:14px 0 6px">Next priorities</h3><ol class="plain-ol">${d.priorities.map((p) => html`<li><a href="${p.href}">${p.text}</a> <span class="small muted">— ${p.why}</span></li>`)}</ol>` : ''}
    <div id="ai-writeup" style="margin-top:14px"></div></section>`
}

export async function renderAssistant(main, q) {
  const day = q.get('day') || today()
  main.innerHTML = loading().toString()
  const [sugg] = await Promise.all([api('/api/assistant/suggestions')])
  main.innerHTML = html`<div class="page-head"><div><h1>AI Work Assistant</h1><p>Understand your work without writing reports: what you did, what mattered, what is missing and what to do next — from your tasks and the evidence you chose to collect.</p></div></div>
    <section class="card"><form class="row" id="day-form" style="gap:8px;align-items:flex-end"><div class="field" style="margin:0"><label for="day">Day</label><input id="day" name="day" type="date" value="${day}" max="${today()}"></div><button class="btn" type="submit" id="analyse-day">Analyse my day</button>
      <a class="btn ghost" href="#/evidence">My evidence</a></form></section>
    <div id="digest" style="margin-top:16px"></div>
    <section class="card" style="margin-top:16px"><div class="card-head"><div><h2>Ask about your work</h2><p>Answers come from your records, with links to each one.</p></div></div><div id="ask-box"></div></section>
    <section class="card" style="margin-top:16px" id="my-signals"></section>`.toString()
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
        ai.innerHTML = html`<button class="btn small ghost" id="write-up">Write it up with AI</button> <span class="small muted">Optional. Uses only the facts above.</span>`.toString()
        ai.querySelector('#write-up').addEventListener('click', async (e) => {
          e.currentTarget.disabled = true
          try {
            const r = await api('/api/assistant/day/ai', { method: 'POST', body: { day: d, tz: tz() } })
            ai.innerHTML = r.ai ? html`<div class="ai-understood"><div class="small muted">AI write-up${r.ai.simulated ? ' — SIMULATED (development only, not AI)' : ` · ${r.ai.provider} · ${r.ai.model}`} · an interpretation of the records above</div><p>${r.ai.summary}</p>${r.ai.highlights.length ? html`<ul class="plain small">${r.ai.highlights.map((h) => html`<li><a href="${h.href}">${h.text}</a></li>`)}</ul>` : ''}</div>`.toString() : '<p class="small muted">Nothing to write up.</p>'
          } catch (err) { ai.innerHTML = html`<div class="notice">${errorText(err)}</div>`.toString() }
        })
      } else if (!sugg.ai) ai.innerHTML = '<p class="small muted">AI write-ups are not available on this server right now; the summary above is complete without them.</p>'
    } catch (e) { box.innerHTML = html`<div class="notice err">${errorText(e)} <button class="btn small ghost" id="retry-day">Retry</button></div>`.toString(); box.querySelector('#retry-day').onclick = () => show(d) }
  }
  main.querySelector('#day-form').addEventListener('submit', (e) => { e.preventDefault(); const d = e.target.day.value || today(); history.replaceState(null, '', `#/assistant?day=${d}`); show(d) })
  if (q.get('day') || q.get('run')) show(day)
  else main.querySelector('#digest').innerHTML = html`<section class="card digest-empty"><p>Press <b>Analyse my day</b> to see what you did, what mattered and what is next.</p></section>`.toString()
  void app
}
