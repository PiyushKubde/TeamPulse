import { expect, test, type Page } from '@playwright/test'

// Company transparency journey: reporting lines, the org chart, open vs private visibility, and KPIs for the person at the top.
const stamp = Date.now()
const owner = { name: 'Cleo Founder', email: `cleo.${stamp}@example.com`, password: 'Password123' }
const member = { name: 'Ravi Report', email: `ravi.${stamp}@example.com`, password: 'Password123' }
let inviteLink = ''

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(who.email)
  await page.getByLabel('Password').fill(who.password)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await expect(page).toHaveURL('/')
}

test.describe.configure({ mode: 'serial' })

test('1. a founder and a teammate join an organization', async ({ page, browser }) => {
  await page.goto('/register')
  await page.getByLabel('Full name').fill(owner.name)
  await page.getByLabel('Work email').fill(owner.email)
  await page.getByLabel('Password').fill(owner.password)
  await page.getByLabel('Mobile number').fill('+91 90000 00020')
  await page.getByRole('button', { name: /create account/i }).click()
  await page.getByLabel('Organization name').fill('Transparent Corp')
  await page.getByRole('button', { name: /create organization/i }).click()
  await expect(page.getByRole('heading', { name: /good (morning|afternoon|evening), cleo/i })).toBeVisible()

  await page.goto('/settings?tab=members')
  await page
    .getByRole('button', { name: /invite/i })
    .first()
    .click()
  const inv = page.getByRole('dialog')
  await inv.getByLabel('Email').fill(member.email)
  await inv.getByRole('button', { name: /send invitation/i }).click()
  inviteLink = await page.getByLabel('Invitation link').inputValue()

  const ctx = await browser.newContext()
  const guest = await ctx.newPage()
  await guest.goto(inviteLink.replace(/^https?:\/\/[^/]+/, 'http://localhost:5180'))
  await guest.getByLabel('Full name').fill(member.name)
  await guest.getByLabel('Choose a password').fill(member.password)
  await guest.getByLabel('Mobile number').fill('+91 90000 00021')
  await guest.getByRole('button', { name: /create account and join/i }).click()
  await expect(guest.getByRole('heading', { name: /good (morning|afternoon|evening), ravi/i })).toBeVisible()
  await ctx.close()
})

test('2. the founder sets who reports to whom and the org chart follows', async ({ page }) => {
  await signIn(page, owner)
  await page.goto('/company')
  await expect(page.getByRole('heading', { name: 'Company', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /structure/i }).click()
  const select = page.getByLabel(`Who ${member.name} reports to`)
  const founder = await select.locator('option', { hasText: owner.name }).first().getAttribute('value')
  await select.selectOption(founder!)
  await page.getByRole('tab', { name: /org chart/i }).click()
  const tree = page.getByRole('tree', { name: /reporting structure/i })
  // The founder is the top of the tree, with one person below.
  await expect(tree.getByRole('button', { name: new RegExp(`Open ${owner.name}'s scorecard`) })).toBeVisible()
  await expect(tree.getByRole('button', { name: new RegExp(`Collapse ${owner.name}'s line \\(1 people\\)`) })).toBeVisible()
  await expect(tree.getByRole('button', { name: new RegExp(`Open ${member.name}'s scorecard`) })).toBeVisible()
})

test('3. everyone sees the company when it is open, and only their own line when private', async ({ page, browser }) => {
  const ctx = await browser.newContext()
  const guest = await ctx.newPage()
  await signIn(guest, member)
  await guest.goto('/company')
  // Open (the default): the teammate sees the founder, and has no Structure tab.
  await expect(
    guest.getByRole('tree', { name: /reporting structure/i }).getByRole('button', { name: new RegExp(`Open ${owner.name}'s scorecard`) }),
  ).toBeVisible()
  await expect(guest.getByRole('tab', { name: /structure/i })).toHaveCount(0)

  await signIn(page, owner)
  await page.goto('/company')
  await page.getByRole('tab', { name: /structure/i }).click()
  await page.getByRole('radio', { name: 'Private' }).click()
  await expect(page.getByRole('radio', { name: 'Private' })).toHaveAttribute('aria-checked', 'true')

  await guest.reload()
  await expect(
    guest.getByRole('tree', { name: /reporting structure/i }).getByRole('button', { name: new RegExp(`Open ${owner.name}'s scorecard`) }),
  ).toHaveCount(0)
  await expect(
    guest.getByRole('tree', { name: /reporting structure/i }).getByRole('button', { name: new RegExp(`Open ${member.name}'s scorecard`) }),
  ).toBeVisible()

  // Back to open for the rest of the run.
  await page.getByRole('radio', { name: 'Open to everyone' }).click()
  await expect(page.getByRole('radio', { name: 'Open to everyone' })).toHaveAttribute('aria-checked', 'true')
  await ctx.close()
})

test('4. the founder has a KPI too: add it, log a reading, see the progress', async ({ page }) => {
  await signIn(page, owner)
  await page.goto('/company')
  await page
    .getByRole('button', { name: new RegExp(`Open ${owner.name}'s scorecard`) })
    .first()
    .click()
  const card = page.getByRole('dialog')
  await card.getByRole('button', { name: /add kpi for cleo/i }).click()
  await card.getByLabel('KPI name').fill('Monthly revenue')
  await card.getByLabel('Unit (optional)').fill('lakh')
  await card.getByLabel('Starting value').fill('0')
  await card.getByLabel('Target').fill('10')
  await card.getByRole('button', { name: /^add kpi$/i }).click()
  const bar = card.getByRole('progressbar', { name: 'Monthly revenue attainment' })
  await expect(bar).toHaveAttribute('aria-valuenow', '0')

  await card.getByPlaceholder('New value').fill('5')
  await card.getByRole('button', { name: /log reading/i }).click()
  await expect(bar).toHaveAttribute('aria-valuenow', '50')
})

test('5. the goal cascade and comparison views load for the whole company', async ({ page }) => {
  await signIn(page, owner)
  await page.goto('/company')
  await page.getByRole('tab', { name: /compare/i }).click()
  await page.getByRole('radio', { name: 'Everyone' }).click()
  await expect(page.getByText(member.name)).toBeVisible()
  await expect(page.getByText(/never use raw task counts or hours worked/i)).toBeVisible()
  await page.getByRole('tab', { name: /goal cascade/i }).click()
  // The KPI from the previous step has no objective, so it sits under "not tied to an objective".
  await expect(page.getByText('Monthly revenue').first()).toBeVisible()
})
