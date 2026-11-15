import { expect, test, type Page } from '@playwright/test'

const stamp = Date.now()
const owner = { name: 'Olive Founder', email: `olive.${stamp}@example.com`, password: 'Password123' }
const member = { name: 'Max Member', email: `max.${stamp}@example.com`, password: 'Password123' }
let inviteLink = ''

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await expect(page).toHaveURL('/')
}

test.describe.configure({ mode: 'serial' })

test('1–2. register and create an organization', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('Full name').fill(owner.name)
  await page.getByLabel('Work email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByRole('button', { name: /create account/i }).click()
  await expect(page.getByRole('heading', { name: /create your organization/i })).toBeVisible()
  await page.getByLabel('Organization name').fill('E2E Corp')
  await page.getByRole('button', { name: /create organization/i }).click()
  await expect(page.getByRole('heading', { name: /good (morning|afternoon|evening), olive/i })).toBeVisible()
  await expect(page.getByText('E2E Corp')).toBeVisible()
})

test('3. create a team and invite a member who accepts', async ({ page, browser }) => {
  await signIn(page, owner)
  await page.goto('/settings?tab=teams')
  await page.getByRole('button', { name: /new team/i }).click()
  const teamDialog = page.getByRole('dialog')
  await teamDialog.getByLabel('Name', { exact: true }).fill('Core')
  await teamDialog.getByLabel('Manager').selectOption({ label: owner.name })
  await teamDialog.getByRole('button', { name: /^create$/i }).click()
  await expect(page.getByText('Core', { exact: true })).toBeVisible()

  await page.goto('/settings?tab=members')
  await page
    .getByRole('button', { name: /invite/i })
    .first()
    .click()
  const inv = page.getByRole('dialog')
  await inv.getByLabel('Email').fill(member.email)
  await inv.getByLabel('Team', { exact: true }).selectOption({ label: 'Core' })
  await inv.getByRole('button', { name: /send invitation/i }).click()
  // No SMTP in this environment: the link is shown to share by hand.
  inviteLink = await page.getByLabel('Invitation link').inputValue()
  expect(inviteLink).toContain('/accept-invite?token=')

  const ctx = await browser.newContext()
  const guest = await ctx.newPage()
  await guest.goto(inviteLink.replace(/^https?:\/\/[^/]+/, 'http://localhost:5180'))
  await expect(guest.getByRole('heading', { name: /join e2e corp/i })).toBeVisible()
  await guest.getByLabel('Full name').fill(member.name)
  await guest.getByLabel('Choose a password').fill(member.password)
  await guest.getByRole('button', { name: /create account and join/i }).click()
  await expect(guest.getByRole('heading', { name: /good (morning|afternoon|evening), max/i })).toBeVisible()
  // Members do not see team navigation.
  await expect(guest.getByRole('link', { name: /team overview/i })).toHaveCount(0)
  await ctx.close()
})

test('4–8. project, goal, task, complete it, attach evidence', async ({ page }) => {
  await signIn(page, owner)
  await page.goto('/projects')
  await page
    .getByRole('button', { name: /new project/i })
    .first()
    .click()
  const pd = page.getByRole('dialog')
  await pd.getByLabel('Name', { exact: true }).fill('Launch site')
  await pd.getByLabel('Team', { exact: true }).selectOption({ label: 'Core' })
  await pd.getByRole('button', { name: /^create$/i }).click()
  await expect(page.getByText('Launch site')).toBeVisible()

  await page.goto('/goals')
  await page
    .getByRole('button', { name: /new goal/i })
    .first()
    .click()
  const gd = page.getByRole('dialog')
  await gd.getByLabel('Goal', { exact: true }).fill('Ship the new site')
  await gd.getByRole('button', { name: /^add$/i }).click()
  await gd.getByLabel('Key result').fill('Pages migrated')
  await gd.getByLabel('Target').fill('10')
  await gd.getByRole('button', { name: /create goal/i }).click()
  await expect(page.getByText('Ship the new site')).toBeVisible()

  await page.goto('/tasks')
  await page
    .getByRole('button', { name: /new task/i })
    .first()
    .click()
  const td = page.getByRole('dialog')
  await td.getByLabel('Title', { exact: true }).fill('Migrate pricing page')
  await td.getByLabel('Expected impact').selectOption('HIGH')
  await td.getByLabel('Project', { exact: true }).selectOption({ label: 'Launch site' })
  await td.getByLabel('Goal', { exact: true }).selectOption({ label: 'Ship the new site' })
  await td.getByLabel('Due date').fill(new Date(Date.now() + 864e5).toISOString().slice(0, 10))
  await td.getByRole('button', { name: /create task/i }).click()
  await expect(page.getByRole('button', { name: /open migrate pricing page/i })).toBeVisible()

  // Complete it by dragging is mouse-only; use the drawer's status control (keyboard accessible).
  await page.getByRole('button', { name: /open migrate pricing page/i }).click()
  const drawer = page.getByRole('dialog')
  await drawer.getByLabel('Status', { exact: true }).selectOption('COMPLETED')
  await expect(drawer.getByLabel('Status', { exact: true })).toHaveValue('COMPLETED')
  await expect(drawer.locator('span', { hasText: /^Completed$/ }).first()).toBeVisible()

  await drawer.getByRole('tab', { name: /evidence/i }).click()
  await drawer.getByRole('button', { name: /add link/i }).click()
  const ed = page.getByRole('dialog').last()
  await ed.getByLabel('Title', { exact: true }).fill('Production deploy')
  await ed.getByLabel('Link', { exact: true }).fill('https://example.com/deploy/42')
  await ed.getByRole('button', { name: /^add$/i }).click()
  await expect(page.getByRole('link', { name: /production deploy/i })).toBeVisible()
  await expect(drawer.locator('span', { hasText: /^Received$/ }).first()).toBeVisible()
})

test('9. individual analytics reflect the completed outcome', async ({ page }) => {
  await signIn(page, owner)
  await page.goto('/analytics')
  const completed = page.getByRole('button', { name: /completed outcomes: show details/i }).locator('..')
  await expect(completed).toContainText('1')
  await expect(completed).toContainText('1 high or critical impact')
  // The score explains itself, including missing dimensions.
  await page.getByRole('button', { name: /overall score: show details/i }).click()
  await expect(page.getByRole('heading', { name: /why this score/i })).toBeVisible()
  await expect(page.getByText(/no quality assessments/i)).toBeVisible()
})

test('10–11. manager dashboard and team filter', async ({ page }) => {
  await signIn(page, owner)
  await page.goto('/team')
  await expect(page.getByRole('heading', { name: 'Team overview' })).toBeVisible()
  await expect(page.getByRole('link', { name: member.name })).toBeVisible()
  await page.getByLabel('Team', { exact: true }).selectOption({ label: 'Core' })
  await expect(page).toHaveURL(/team=/)
  await page.goto('/team/analytics' + new URL(page.url()).search)
  await expect(page.getByText(/work by status/i)).toBeVisible()
  // Drill-down: clicking a person opens their profile.
  await page.goto('/team/members')
  await page.getByRole('link', { name: member.name }).click()
  await expect(page.getByRole('heading', { name: member.name })).toBeVisible()
})

test('12. generate a weekly report and export it', async ({ page }) => {
  await signIn(page, owner)
  await page.goto('/reports')
  await page.getByLabel('Type').selectOption('WEEKLY')
  await page.getByLabel(/any day in the week/i).fill(new Date().toISOString().slice(0, 10))
  await page.getByRole('button', { name: /^generate$/i }).click()
  await expect(page.getByRole('heading', { name: /weekly report/i })).toBeVisible()
  await expect(page.getByText('Migrate pricing page').first()).toBeVisible()
  const pdf = await page.request.get((await page.getByRole('link', { name: /pdf/i }).getAttribute('href')) as string)
  expect(pdf.status()).toBe(200)
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')
})

test('responsive: navigation collapses on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await signIn(page, owner)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  await page.getByRole('button', { name: /open navigation/i }).click()
  await page.getByRole('link', { name: /goals & okrs/i }).click()
  await expect(page.getByRole('heading', { name: /goals & okrs/i })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
})

// Steps 13–18 need real, connected test accounts (Linear/Jira/GitHub/Slack) and a public URL for events.
// They are BLOCKED until those exist; set E2E_REAL_INTEGRATIONS=1 after connecting them to run the manual checklist in
// docs/viasocket-test-report.md. Mocked coverage of the same pipeline lives in apps/api/test/api-integrations.test.ts.
test('13–18. real integration journey', async () => {
  test.skip(!process.env.E2E_REAL_INTEGRATIONS, 'BLOCKED: needs connected test accounts and PUBLIC_API_URL (see docs/viasocket-test-report.md)')
})
