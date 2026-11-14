// What an organization admin needs to know about the system, read-only: who is in the organization, whether AI evaluation can run (and exactly what
// would have to be configured and approved to turn it on), which integrations are set up, and the state of backups. It never contains a secret,
// a key, a token or any employee data; it only says whether each thing is configured. Admins only.
import { requireAdmin } from '../access.js'
import { lastBackup } from './backups.js'
import { backlogCount } from '../measurement/backlog.js'

export function aiActivationSteps({ configured, simulated, requested, policyConfirmed, mode }) {
  if (configured && simulated) return ['This is the development simulator. It is never real AI and is refused in production; nothing to activate here.']
  const steps = []
  if (!configured) {
    steps.push('Choose a provider on the server: AI_PROVIDER=viasocket (with AI_VIASOCKET_SERVICE and AI_VIASOCKET_MODEL), or AI_PROVIDER=anthropic with ANTHROPIC_API_KEY.')
    if (requested === 'viasocket' && !policyConfirmed) steps.push('viaSocket is chosen, but it stays off until viaSocket has answered the data-policy questions (docs/viasocket-ai-data-policy.md). Then set AI_VIASOCKET_POLICY_CONFIRMED=true.')
  }
  if (mode !== 'on') steps.push('Set AI_MODE=on so every submitted task is assessed automatically. The default for a real provider is "supervised": admins only, selected tasks, no automatic runs.')
  steps.push('Restart the app after changing the environment. Employee task data is sent only to the provider you approved, only for tasks with enough evidence; tasks with too little evidence are answered by rules and never leave KONVO.')
  return steps
}

export function systemStatus(db, ctx, { cfg, ai, aiMode, vs, m91, mailer }) {
  requireAdmin(ctx)
  const roles = Object.fromEntries(db.prepare(`SELECT role, COUNT(*) AS n FROM memberships WHERE org_id = ? AND status = 'active' GROUP BY role`).all(ctx.orgId).map((r) => [r.role, r.n]))
  const teams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE org_id = ?').get(ctx.orgId).n
  const policyConfirmed = Boolean(cfg.ai?.viasocketPolicyConfirmed)
  const requested = cfg.ai?.provider || null
  const mode = aiMode.mode
  let backup = null
  try { const b = lastBackup(db); backup = b ? { at: b.at, offsite: b.offsite, restoreVerified: Boolean(b.restoreVerifiedAt) } : null } catch { backup = null }
  return {
    unassessedSubmitted: backlogCount(db, ctx.orgId), // a count only: the admin runs the organization, the team's manager starts and reads the assessments
    organization: { name: ctx.orgName, members: { admin: roles.admin || 0, manager: roles.manager || 0, employee: roles.employee || 0 }, teams },
    ai: {
      configured: Boolean(ai.configured), provider: ai.configured ? ai.name : null, model: ai.configured ? ai.model : null, simulated: Boolean(ai.simulated), live: Boolean(ai.configured && !ai.simulated),
      requestedProvider: requested, policyConfirmed, mode, automatic: Boolean(ai.configured && mode === 'on'), reason: ai.configured ? null : ai.reason || null,
      steps: aiActivationSteps({ configured: Boolean(ai.configured), simulated: Boolean(ai.simulated), requested, policyConfirmed, mode })
    },
    integrations: { google: Boolean(cfg.google?.configured), email: Boolean(mailer?.configured), viasocket: Boolean(vs?.configured), m91: Boolean(m91?.ready) },
    backup,
    environment: { production: Boolean(cfg.production) }
  }
}
