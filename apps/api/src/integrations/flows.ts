// Per-user flows for actions fixed in KONVO's code: one webhook-triggered flow per saved action, as the skill
// requires. The flow's script_id is stored encrypted on an IntegrationSubscription row with triggerKey "flow:<name>".
import { prisma, type IntegrationConnection, type Prisma } from '../lib/prisma.js'
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js'
import { automationToken, createFlow, saveSteps, setTrigger, runWebhookFlow, type Step } from './viasocket/automations.js'
import { authIdOf } from './connections.js'
import { ACTIONS, provider } from './catalog.js'

export type FlowName = 'slack_delivery' | 'gmail_delivery' | 'system_mail' | 'linear_status' | 'jira_backfill'

const flowKey = (n: FlowName) => `flow:${n}`

/** Steps per flow. Values fixed for this user are baked in; per-run values come from the POSTed body. */
function stepsFor(name: FlowName, conn: IntegrationConnection, email?: string): Step[] {
  const auth = authIdOf(conn)
  const s = conn.settings as { delivery?: { messageto: 'channel' | 'user'; channelId?: string; userId?: string }; teamId?: string }
  if (name === 'slack_delivery') {
    const d = s.delivery
    if (!d || (d.messageto === 'channel' ? !d.channelId : !d.userId)) throw new Error('Choose a Slack channel or yourself first.')
    const destination = d.messageto === 'channel' ? { messageto: 'channel', channel_id: [d.channelId] } : { messageto: 'user', userId: [d.userId] }
    return [
      {
        stepname: 'send',
        service_action_functions: [{ name: 'sendMessage', auth_id: auth, action_id: ACTIONS.slackSendMessage.actionId }],
        code: `const text = String(context?.req?.body?.text || '').slice(0, 39000)\nif (!text) return { skipped: true }\nreturn await sendMessage({ inputData: { destination: ${JSON.stringify(destination)}, markdown_content: text } })`,
      },
    ]
  }
  if (name === 'gmail_delivery') {
    if (!email) throw new Error('No recipient.')
    return [
      {
        stepname: 'send',
        service_action_functions: [{ name: 'sendEmail', auth_id: auth, action_id: ACTIONS.gmailSendEmail.actionId }],
        // `to` is fixed to the person's own verified email; `from` left out: sends as the connected account.
        code: `const b = context?.req?.body || {}\nif (!b.subject || !b.text) return { skipped: true }\nreturn await sendEmail({ inputData: { to: ${JSON.stringify(email)}, subject: String(b.subject).slice(0, 200), messageBody: String(b.text).slice(0, 100000), fromName: "KONVO" } })`,
      },
    ]
  }
  if (name === 'system_mail') {
    return [
      {
        stepname: 'send',
        service_action_functions: [{ name: 'sendEmail', auth_id: auth, action_id: ACTIONS.gmailSendEmail.actionId }],
        // System email: the recipient varies per run (verification, reset, invitation); KONVO validated it.
        code: `const b = context?.req?.body || {}\nconst to = String(b.to || '')\nif (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(to) || !b.subject || !b.text) return { skipped: true }\nreturn await sendEmail({ inputData: { to, subject: String(b.subject).slice(0, 200), messageBody: String(b.text).slice(0, 100000), fromName: "KONVO" } })`,
      },
    ]
  }
  if (name === 'linear_status') {
    if (!s.teamId) throw new Error('Choose a Linear team first.')
    return [
      {
        stepname: 'update_status',
        service_action_functions: [{ name: 'updateIssueStatus', auth_id: auth, action_id: ACTIONS.linearUpdateStatus.actionId }],
        code: `const b = context?.req?.body || {}\nif (!b.issue || !b.stateID) return { skipped: true }\nreturn await updateIssueStatus({ inputData: { teams: ${JSON.stringify(s.teamId)}, issue: String(b.issue), stateID: String(b.stateID) } })`,
      },
    ]
  }
  return [
    {
      stepname: 'find',
      service_action_functions: [{ name: 'findIssueViaJql', auth_id: auth, action_id: ACTIONS.jiraFindByJql.actionId }],
      code: `const jql = String(context?.req?.body?.jql || '')\nif (!jql) return { skipped: true }\nreturn await findIssueViaJql({ inputData: { jql } })`,
    },
  ]
}

/** Creates the flow once, or re-saves its steps when the user's choices changed. Returns the script_id. */
export async function ensureFlow(conn: IntegrationConnection, name: FlowName, opts: { email?: string; resave?: boolean } = {}) {
  const key = flowKey(name)
  const existing = await prisma.integrationSubscription.findUnique({
    where: { connectionId_triggerKey_resource: { connectionId: conn.id, triggerKey: key, resource: '' } },
  })
  if (existing?.scriptIdEnc && existing.status === 'ACTIVE' && !opts.resave) return decrypt(existing.scriptIdEnc)
  const steps = stepsFor(name, conn, opts.email)
  const token = await automationToken(conn.userId)
  let scriptId = existing?.scriptIdEnc ? decrypt(existing.scriptIdEnc) : null
  if (!scriptId) {
    scriptId = await createFlow(token, {
      title: `KONVO · ${name.replace('_', ' ')}`,
      description: `Created by KONVO for ${provider(conn.provider)?.name ?? conn.provider}. Do not edit; change it in KONVO.`,
    })
    await setTrigger(token, scriptId, { triggerType: 'webhook' })
  }
  await saveSteps(token, scriptId, steps)
  const data = {
    scriptIdEnc: encrypt(scriptId),
    version: 'flow',
    inputData: {} as Prisma.InputJsonValue,
    handlerHash: sha256(JSON.stringify(steps.map((s) => s.code))),
    status: 'ACTIVE',
  }
  await prisma.integrationSubscription.upsert({
    where: { connectionId_triggerKey_resource: { connectionId: conn.id, triggerKey: key, resource: '' } },
    create: { connectionId: conn.id, triggerKey: key, resource: '', tokenHash: sha256(randomToken()), ...data },
    update: data,
  })
  return scriptId
}

/** Runs a flow and turns a failed step (which still answers 200) into an error. */
export async function runFlow(conn: IntegrationConnection, name: FlowName, body: Record<string, unknown>, opts: { email?: string } = {}) {
  const scriptId = await ensureFlow(conn, name, opts)
  const out = await runWebhookFlow<Record<string, unknown> | string>(scriptId, body)
  const failed = typeof out === 'object' && out !== null && ('error' in out || (out as { success?: boolean }).success === false)
  if (failed) throw new Error(`The ${name.replace('_', ' ')} step failed: ${JSON.stringify(out).slice(0, 300)}`)
  return out
}
