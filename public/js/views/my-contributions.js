// My Contributions (employees): finish your work and submit it; KONVO assesses it, and your manager reviews the meaningful contributions.
// Nothing here asks you to write anything up. Each submitted task shows where it stands (see LIFECYCLE in ui.js), and "other contributions"
// is only for meaningful work that has no task (mentoring, preventing an incident, helping another team, improving a process).
import { api, html, icon, errorText, loading, ago, lifecycleBadge, stageBadge } from '../ui.js'
import { app } from '../app.js'
import { openImpactForm } from './impact.js'

// Groups in the order a person cares about: what needs a manager, what is decided, what could not be judged, what is routine.
const GROUPS = [
  ['SUBMITTED_FOR_REVIEW', 'Awaiting your manager’s review', 'Meaningful contributions that KONVO assessed and sent to your manager.'],
  ['APPROVED', 'Approved', 'Your manager approved the assessment. These are part of your contribution history.', ['APPROVED', 'ADJUSTED']],
  ['DISPUTED', 'Disagreed with by your manager', 'Your manager did not agree with the assessment and gave a reason. You can read it on the task and add your side.'],
  ['NOT_ENOUGH_EVIDENCE', 'Not enough evidence yet', 'There was too little to judge, so nothing was assessed and nothing was invented. Adding detail or evidence to the task can change that.'],
  ['PENDING', 'Not assessed yet', 'Submitted tasks with no assessment: it may still be running, it may have been submitted before AI was on, or AI is not available. Open a task to run its assessment.', ['PENDING', 'UNAVAILABLE']],
  ['ROUTINE', 'Routine work', 'Assessed as routine. It is recorded and needs no review.']
]

export async function renderMyContributions(main) {
  main.innerHTML = loading().toString()
  const from = new Date(Date.now() - 180 * 86400000).toISOString()
  let profile; let tasks; let records
  try {
    [profile, tasks, records] = await Promise.all([
      api(`/api/contribution/people/${app.me.id}?from=${encodeURIComponent(from)}`),
      api('/api/tasks?view=mine&status=SUBMITTED_FOR_REVIEW,COMPLETED'),
      api(`/api/impact?userId=${app.me.id}`).catch(() => [])
    ])
  } catch (e) {
    main.innerHTML = html`<div class="notice err" role="alert"><b>Could not load your contributions.</b> ${errorText(e)} <button type="button" class="btn small ghost" id="mc-retry">Try again</button></div>`.toString()
    main.querySelector('#mc-retry')?.addEventListener('click', () => renderMyContributions(main))
    return
  }
  if (!main.isConnected) return
  const ai = app.session?.integrations?.ai // configured | simulated | not_configured
  const work = new Map(profile.work.map((w) => [w.taskId, w]))
  const rows = tasks.map((t) => {
    const w = work.get(t.id)
    return { t, w, state: w ? w.lifecycle : ai === 'not_configured' ? 'UNAVAILABLE' : 'PENDING' }
  })
  const has = (keys) => rows.filter((r) => keys.includes(r.state))
  const row = (r) => html`<li class="ov-row"><div class="grow"><a class="ov-ttl" href="#/tasks/${r.t.id}">${r.t.title}</a>
      <div class="small muted">${r.t.completedAt ? `Completed ${ago(r.t.completedAt)}` : r.t.submittedAt ? `Submitted ${ago(r.t.submittedAt)}` : ''}${r.w?.complexity ? ` · complexity ${r.w.complexity}` : ''}${r.w?.simulated ? ' · simulated assessment' : ''}${r.w?.provider === 'rules' && r.state !== 'NOT_ENOUGH_EVIDENCE' ? ' · rules only' : ''}</div></div>${lifecycleBadge(r.state)}</li>`
  const groups = GROUPS.map(([key, title, hint, keys]) => [key, title, hint, has(keys || [key])]).filter(([, , , list]) => list.length)
  const recent = records.slice(0, 5)

  main.innerHTML = html`<div class="ov">
    <header class="wb-head"><div><h1>My Contributions</h1><p>Finish your work and submit it. KONVO assesses it, and your manager reviews the meaningful contributions. You do not need to write anything up.</p></div>
      <div class="row"><a class="btn ghost" href="#/contribution/${app.me.id}">${icon('profile')}My contribution profile</a></div></header>
    ${ai === 'not_configured' ? html`<div class="notice" data-testid="ai-unavailable"><b>AI assessment is not switched on yet.</b> Your tasks are submitted and reviewed as usual. Assessments appear here once an administrator turns AI on; until then nothing is assessed and nothing is estimated.</div>` : ai === 'simulated' ? html`<div class="notice warn"><b>Development simulator.</b> Assessments here come from a built-in simulator, not from real AI.</div>` : ''}
    ${rows.length ? groups.map(([key, title, hint, list]) => html`<section class="wi-sec" data-group="${key}" aria-labelledby="mc-${key}"><h2 id="mc-${key}">${title} <span class="muted small">${list.length}</span></h2><p class="small muted" style="margin:8px 0 0">${hint}</p><ul class="ov-list">${list.map(row)}</ul></section>`)
      : html`<section class="wi-sec"><h2>Nothing submitted yet</h2><p class="muted" style="margin:10px 0 0">When you submit a task, KONVO assesses it automatically and it shows up here with where it stands. <a href="#/my-tasks">Go to My Tasks</a></p></section>`}
    <section class="wi-sec" aria-labelledby="mc-other"><h2 id="mc-other">Other contributions</h2>
      <p class="small muted" style="margin:8px 0 10px">For meaningful work that has no task: mentoring, preventing an incident, helping another team, improving a process. Finished tasks are assessed for you, so do not record them here.</p>
      ${recent.length ? html`<ul class="ov-list">${recent.map((c) => html`<li class="ov-row"><div class="grow"><a class="ov-ttl" href="#/impact/${c.id}">${c.title}</a><div class="small muted">${c.taskTitle ? `Linked to ${c.taskTitle}` : 'No task'}</div></div>${stageBadge(c)}</li>`)}</ul>` : html`<p class="muted small">Nothing recorded. That is normal: most of your work is shown through your tasks.</p>`}
      <div class="row" style="margin-top:12px"><button class="btn small ghost" id="mc-record">${icon('plus')}Record an exceptional contribution</button><a class="btn small subtle" href="#/impact">All other contributions</a><a class="btn small subtle" href="#/evidence">My work evidence</a></div></section>
  </div>`.toString()
  main.querySelector('#mc-record')?.addEventListener('click', () => openImpactForm())
}
