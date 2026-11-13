// Manager-led work expectations in a real browser: a task created without a priority shows "Priority not set", the manager confirms values
// in the Expectations panel, asks for and accepts or overrides a priority recommendation, an employee-created task shows in the review queue
// as a proposal until confirmed, an employee's change request is approved, and the analytics view loads with a filter and its notes.
// Starts the app on a temporary DATA_DIR with DEV_LOGIN=1 and demo data; nothing else is touched. Usage: node --disable-warning=ExperimentalWarning scripts/e2e-manager-led.mjs
/* global document, location, window */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'konvo-e2e-led-'))
if (dataDir.replace(/\\/g, '/') === join(process.cwd(), 'data').replace(/\\/g, '/')) throw new Error('refusing to use the real data directory')
const port = 4900 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER', 'M91_SEND_LINK', 'M91_API_KEY', 'VIASOCKET_EMBED_SECRET', 'LOCAL_SCHEDULER']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
const base = `http://127.0.0.1:${port}`
const browser = await chromium.launch()
const problems = []
let step = ''
const check = (ok, msg) => { if (!ok) problems.push(`${step}: ${msg}`) }
const DAY = 86400000

async function open(email) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`${step}: page error ${e.message}`))
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  return page
}
const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TeamPulse' }, body: b === undefined ? undefined : JSON.stringify(b) })
  const t = await r.text()
  return { status: r.status, body: t ? JSON.parse(t) : null }
}, [method, path, body])
const go = (page, hash) => page.evaluate((h) => { location.hash = h }, hash)
const taskIdFromUrl = (page) => page.url().split('/tasks/')[1]

try {
  const manager = await open('manager@demo.teampulse')
  const priya = await open('priya@demo.teampulse')
  const members = (await call(manager, 'GET', '/api/members')).body
  const priyaId = members.find((m) => m.name === 'Priya Sharma').userId
  // Priya may create tasks directly (her values are still only proposals).
  check((await call(manager, 'PATCH', `/api/permissions/${priyaId}`, { can_create_directly: true, approval_required: false, can_self_assign: true })).status === 200, 'could not grant direct creation')

  // 1. The manager creates a task through the form without choosing a priority: it is "not set", never Medium.
  step = 'manager creates a task without a priority'
  await go(manager, '#/team-tasks')
  await manager.click('#new-task')
  await manager.fill('#t-title', 'Review vendor contract terms')
  await manager.click('#task-more summary')
  check(await manager.inputValue('[data-testid=f-priority]') === '', 'the priority field does not start empty')
  check((await manager.textContent('[data-testid=f-priority]')).includes('Not decided yet'), 'no "Not decided yet" choice')
  await manager.selectOption('[data-testid=f-complexity]', 'L3')
  await manager.fill('[data-testid=f-criteria]', 'Legal signs off on the terms')
  await manager.selectOption('#t-assignee', priyaId)
  await manager.click('#task-form [type=submit]')
  await manager.waitForSelector('[data-testid=expectations]')
  const taskA = taskIdFromUrl(manager)
  await manager.waitForSelector('[data-testid=expectations] [data-field=priority]')
  check((await manager.textContent('[data-testid=prio-badge]')).includes('Priority not set'), 'the task header does not say "Priority not set"')
  check(await manager.getAttribute('[data-testid=expectations] [data-field=priority]', 'data-state') === 'UNRESOLVED', 'priority is not shown as not set in the panel')
  check(await manager.getAttribute('[data-testid=expectations] [data-field=complexityExpectation]', 'data-state') === 'CONFIRMED', 'the complexity expectation was not saved as confirmed')

  // 2. Confirm a priority from the panel.
  step = 'manager confirms the priority in the Expectations panel'
  await manager.click('[data-testid=set-priority]')
  await manager.selectOption('[data-testid=value-input]', 'MEDIUM')
  await manager.click('[data-testid=value-confirm]')
  await manager.waitForSelector('[data-testid=expectations] [data-field=priority][data-state=CONFIRMED]')
  check((await manager.textContent('[data-testid=expectations] [data-field=priority]')).includes('Medium'), 'the confirmed priority is not shown')

  // 3. Priority recommendation: rate factors, accept; then override on a second task.
  step = 'priority recommendation: accept'
  await manager.click('[data-testid=reco] summary')
  for (const [k, n] of [['businessImpact', '5'], ['urgency', '4'], ['dependencies', '3'], ['risk', '3'], ['strategic', '2']]) await manager.selectOption(`[data-testid=factor-${k}]`, n)
  await manager.click('[data-testid=suggest-priority]')
  await manager.waitForSelector('[data-testid=recommendation]')
  check((await manager.textContent('[data-testid=recommendation]')).includes('not a decision') || (await manager.textContent('[data-testid=reco]')).includes('not a decision'), 'the recommendation is not labelled as not a decision')
  await manager.click('[data-testid=reco-accept]')
  await manager.waitForSelector('[data-testid=expectations] [data-field=priority][data-state=CONFIRMED]')
  const accepted = (await call(manager, 'GET', `/api/tasks/${taskA}/parameters`)).body
  check(accepted.priority.value === 'HIGH', `accepting a score of 75 should confirm HIGH, got ${accepted.priority.value}`)
  check(accepted.history.some((e) => e.field === 'priority' && e.kind === 'CHANGE' && e.oldValue === 'MEDIUM'), 'the earlier value is not kept in the history')

  step = 'priority recommendation: override with a reason'
  const taskB = (await call(manager, 'POST', '/api/tasks', { title: 'Payments outage follow-up', assigneeId: priyaId, factors: { businessImpact: 5, urgency: 5, dependencies: 5, risk: 5, strategic: 5 } })).body.task.id
  await go(manager, `#/tasks/${taskB}`)
  await manager.waitForSelector('[data-testid=reco] summary')
  await manager.click('[data-testid=reco] summary')
  await manager.click('[data-testid=suggest-priority]')
  await manager.waitForSelector('[data-testid=critical-warning]')
  await manager.click('[data-testid=reco-override]')
  await manager.selectOption('[data-testid=override-priority]', 'HIGH')
  await manager.fill('[data-testid=override-reason]', 'A workaround is in place')
  await manager.click('[data-testid=override-submit]')
  await manager.waitForSelector('[data-testid=expectations] [data-field=priority][data-state=CONFIRMED]')
  const overridden = (await call(manager, 'GET', `/api/tasks/${taskB}/parameters`)).body
  check(overridden.priority.value === 'HIGH', 'the override did not confirm HIGH')

  // 4. An employee-created task: values are proposals, visible in the review queue, confirmed by the manager.
  step = 'employee-created proposal appears in the review queue'
  const prop = (await call(priya, 'POST', '/api/tasks', { title: 'Tidy the onboarding docs', priority: 'CRITICAL', dueAt: new Date(Date.now() + 3 * DAY).toISOString(), assigneeId: priyaId })).body.task.id
  await go(priya, `#/tasks/${prop}`)
  await priya.waitForSelector('[data-testid=expectations] [data-field=priority]')
  check(await priya.getAttribute('[data-testid=expectations] [data-field=priority]', 'data-state') === 'PROPOSED', 'the employee does not see their own value as proposed')
  check(await priya.locator('[data-testid^=accept-]').count() === 0, 'an employee can confirm values')
  await go(manager, '#/review')
  await manager.waitForSelector('[data-testid=review-queue]')
  check(await manager.locator(`[data-testid=review-item][data-task="${prop}"]`).count() === 1, 'the proposal is not in the review queue')
  await manager.click(`[data-testid=review-item][data-task="${prop}"] [data-testid=review-open]`)
  await manager.waitForSelector('[data-testid=suggestion-priority]')
  await manager.click('[data-testid=edit-priority]')
  await manager.selectOption('[data-testid=value-input]', 'HIGH')
  await manager.click('[data-testid=value-confirm]')
  await manager.waitForSelector('[data-testid=expectations] [data-field=priority][data-state=CONFIRMED]')
  await manager.click('[data-testid=accept-deadline]')
  await manager.waitForSelector('[data-testid=expectations] [data-field=deadline][data-state=CONFIRMED]')
  await go(manager, '#/review')
  await manager.waitForSelector('[data-testid=review-queue]')
  check(await manager.locator(`[data-testid=review-item][data-task="${prop}"]`).count() === 0, 'the confirmed task is still in the review queue')

  // 5. An employee change request, approved by the manager.
  step = 'employee asks for a different deadline; the manager approves'
  await go(priya, `#/tasks/${taskA}`)
  await priya.waitForSelector('[data-testid=request-change]')
  const before = (await call(manager, 'GET', `/api/tasks/${taskA}`)).body.task.dueAt
  await priya.click('[data-testid=request-change]')
  await priya.selectOption('[data-testid=cr-kind]', 'DEADLINE')
  await priya.fill('[data-testid=cr-deadline]', new Date(Date.now() + 10 * DAY).toISOString().slice(0, 16))
  await priya.fill('[data-testid=cr-reason]', 'The vendor is slow to reply')
  await priya.click('[data-testid=cr-submit]')
  await priya.waitForSelector('[data-testid=change-requests] [data-status=PENDING]')
  check((await call(manager, 'GET', `/api/tasks/${taskA}`)).body.task.dueAt === before, 'the deadline changed before the manager decided')
  await go(manager, '#/dashboard')
  await manager.waitForSelector('main')
  await go(manager, '#/review')
  await manager.waitForSelector('[data-testid=cr-item]')
  await manager.click('[data-testid=cr-item] [data-testid=cr-decide]')
  await manager.click('[data-testid=decision-approve]')
  await manager.fill('[data-testid=decision-note]', 'Agreed')
  await manager.click('[data-testid=decision-submit]')
  await manager.waitForFunction(() => !document.querySelector('[data-testid=cr-item]'))
  const after = (await call(manager, 'GET', `/api/tasks/${taskA}/parameters`)).body
  check(Boolean(after.deadline.value) && after.deadline.value !== before, 'the approved deadline was not applied')
  check(after.history.some((e) => e.field === 'deadline' && e.source === 'CHANGE_REQUEST'), 'the history does not say the change came from a request')

  // 6. Analytics: the team view loads, a filter applies, the server's notes are shown, no ranking.
  step = 'analytics team view with a filter'
  await go(manager, '#/analytics')
  await manager.waitForSelector('[data-testid=analytics-summary]')
  check((await manager.textContent('[data-testid=analytics-notes]')).includes('never a performance score'), 'the fairness notes are not shown')
  const total = Number(await manager.textContent('[data-testid=stat-tasks] .value'))
  check(total >= 3, `the team view lists too few tasks (${total})`)
  await manager.click('[data-testid=filters-toggle]')
  await manager.selectOption('[data-testid=af-priority]', 'HIGH')
  await manager.click('[data-testid=af-apply]')
  await manager.waitForFunction((t) => Number(document.querySelector('[data-testid=stat-tasks] .value')?.textContent) < t, total)
  check(await manager.locator('[data-testid=analytics-tasks] tbody tr').count() >= 1, 'the filtered table is empty')
  check(!(await manager.textContent('[data-testid=analytics-body]')).match(/leaderboard|top performer|score:/i), 'the analytics page shows a ranking or score')
  step = 'analytics task view'
  await go(manager, `#/analytics?tab=task&taskId=${taskA}`)
  await manager.waitForSelector('[data-testid=task-original]')
  check((await manager.textContent('[data-testid=task-original]')).includes('Medium'), 'the original priority (Medium) is not shown')
  check((await manager.textContent('[data-testid=task-current]')).includes('High'), 'the current priority (High) is not shown')
  step = 'analytics is limited for employees'
  await go(priya, '#/analytics')
  await priya.waitForSelector('[data-testid=analytics-summary]')
  check(await priya.locator('[data-testid=tab-team]').count() === 0, 'an employee sees the team tab')
  check((await call(priya, 'GET', '/api/analytics/team')).status === 403, 'the server allowed team analytics for an employee')

  // 7. The employee sees the decision, then does the work: progress and evidence; the manager reviews it.
  step = 'employee sees the decision'
  await go(priya, '#/dashboard'); await priya.waitForSelector('main')
  await go(priya, `#/tasks/${taskA}`)
  await priya.waitForSelector('[data-testid=change-requests] [data-status=APPROVED]')
  check(await priya.locator('[data-testid=value-input], [data-testid=edit-deadline], [data-testid=accept-deadline]').count() === 0, 'an employee sees an editor for confirmed values')
  step = 'employee reports progress and evidence'
  const st = (await call(priya, 'POST', `/api/tasks/${taskA}/status`, { status: 'IN_PROGRESS' })).status
  check(st === 200 || st === 409, `could not start the task (${st})`)
  check((await call(priya, 'POST', `/api/tasks/${taskA}/progress`, { progress: 70, note: 'Index rebuilt' })).status === 200, 'progress was not saved')
  const sub = await call(priya, 'POST', `/api/tasks/${taskA}/submit`, { summary: 'Rebuilt the index', outcome: 'Search is faster', evidenceLinks: [{ url: 'https://github.com/acme/app/pull/7', label: 'PR' }] })
  check(sub.status === 200, `submission failed (${sub.status})`)
  step = 'manager reviews the task and its evidence'
  await go(manager, '#/dashboard'); await manager.waitForSelector('main')
  await go(manager, `#/tasks/${taskA}`)
  await manager.waitForFunction(() => /waiting for/i.test(document.body.textContent || '') || document.querySelector('[data-act=review], #review'))
  const detail = (await call(manager, 'GET', `/api/tasks/${taskA}`)).body
  check(detail.task.status === 'SUBMITTED_FOR_REVIEW' && detail.submissions[0].evidence.length === 1, 'the manager does not see the submission with its evidence')
  check((await call(manager, 'POST', `/api/tasks/${taskA}/review`, { decision: 'APPROVED', comment: 'Good' })).status === 200, 'the review was not saved')

  // 8. Person analytics and who may open it.
  step = 'person analytics and access'
  await go(manager, `#/analytics?tab=person&userId=${priyaId}`)
  await manager.waitForSelector('[data-testid=analytics-summary]')
  check((await manager.textContent('[data-testid=analytics-body]')).includes('Priya'), 'the person view does not name the person')
  const managerId = members.find((m) => m.name !== 'Priya Sharma' && m.role !== 'employee')?.userId
  check((await call(priya, 'GET', `/api/analytics/person/${priyaId}`)).status === 200, 'an employee cannot open their own analytics')
  if (managerId) check((await call(priya, 'GET', `/api/analytics/person/${managerId}`)).status === 404, 'an employee can open someone else\'s analytics')
  const other = members.find((m) => m.role === 'employee' && m.userId !== priyaId)
  if (other) check((await call(priya, 'GET', `/api/analytics/person/${other.userId}`)).status === 404, 'an employee can open a colleague\'s analytics')

  // 9. Mobile layouts stay usable: no horizontal scrolling on the new pages.
  step = 'mobile layouts'
  for (const [page, hashes] of [[manager, ['#/review', '#/analytics', `#/tasks/${taskA}`, '#/team-tasks']], [priya, [`#/tasks/${taskA}`, '#/analytics']]]) {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const h of hashes) {
      await go(page, '#/dashboard'); await page.waitForSelector('main'); await go(page, h)
      await page.waitForSelector('main h1, main h2'); await page.waitForTimeout(400)
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      check(over <= 1, `${h} scrolls horizontally on a phone (${over}px)`)
    }
  }
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
} finally {
  await browser.close(); server.kill()
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log('E2E manager-led expectations passed (priority not set, confirmation, recommendation accept/override, proposals in the review queue, change request approval, analytics, employee decision, progress and evidence, manager review, person analytics access, mobile).')
