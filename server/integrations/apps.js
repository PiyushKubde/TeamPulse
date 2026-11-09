// The ViaSocket apps TeamPulse offers, each in context. Not an open catalog: the full catalog lives only in the
// Advanced Automation Builder. Availability verified on viasocket.com/docs/<slug>.md (2026-11-09).
// `actions` are the action_ids the Connect popup asks consent for (from DealSaathi's live-tested integration).
import { AppError } from '../errors.js'
import { viasocketError } from './errors.js'

export const CURATED_APPS = [
  {
    slug: 'slack', name: 'Slack', actions: ['row1jrbor', 'rowo0opjzsgk'], runsInTeamPulse: true, priority: 1,
    purpose: 'Task-assignment notifications (to you or a team channel), the weekly team report, and turning messages in an intake channel into task requests.',
    usedBy: ['My notifications', 'Team task notifications', 'Weekly team report', 'Slack intake → task requests', 'Share a task to Slack']
  },
  {
    slug: 'gmail', name: 'Gmail', actions: ['rowogelpy0h6', 'row9ls2itxoc'], runsInTeamPulse: true, priority: 1,
    purpose: 'Task-assignment emails, the weekly team report, and turning labelled emails into task requests.',
    usedBy: ['My notifications', 'Team task notifications', 'Weekly team report', 'Gmail intake → task requests']
  },
  {
    slug: 'google-sheets', name: 'Google Sheets', actions: null, runsInTeamPulse: false, priority: 1,
    purpose: 'Log your assigned tasks or each weekly report as rows in a sheet — built in place from My Tasks and Reports.',
    usedBy: ['My Tasks → Automate', 'Reports → Send to Google Sheets']
  },
  {
    slug: 'google-calendar', name: 'Google Calendar', actions: null, runsInTeamPulse: false, priority: 2,
    purpose: 'Put the deadline of each task assigned to you in your calendar — built in place from My Tasks.',
    usedBy: ['My Tasks → Automate']
  },
  {
    slug: 'github', name: 'GitHub', actions: null, runsInTeamPulse: false, priority: 2,
    purpose: 'Create or comment on an issue when a task in your team is completed — built in place from a task.',
    usedBy: ['Task page → Automate (managers)']
  }
]

export const curatedSlug = (slug) => CURATED_APPS.find((a) => a.slug === slug)

/** The curated apps with their live service ids. An app viaSocket cannot resolve carries its error. */
export async function curatedApps(vs) {
  return Promise.all(CURATED_APPS.map(async (app) => {
    if (!vs.configured) return { ...app, serviceId: null, error: null }
    try {
      return { ...app, serviceId: await vs.serviceIdFor(app.slug), error: null }
    } catch (error) {
      return { ...app, serviceId: null, error: viasocketError(error, `find ${app.name}`).message }
    }
  }))
}

export function requireCurated(slug) {
  const app = curatedSlug(slug)
  if (!app) throw new AppError(400, 'app_not_supported', 'TeamPulse does not use that app here. Use the Advanced Builder for other apps.')
  return app
}
