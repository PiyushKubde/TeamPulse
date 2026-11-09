// The ViaSocket apps TeamPulse offers, each in context. Not an open catalog: the full catalog lives only in the
// Advanced Automation Builder. Availability verified on viasocket.com/docs/<slug>.md (2026-11-09).
// `actions` are the action_ids the Connect popup asks consent for (from DealSaathi's live-tested integration).
import { AppError } from '../errors.js'
import { viasocketError } from './errors.js'

export const CURATED_APPS = [
  {
    slug: 'slack', name: 'Slack', actions: ['row1jrbor'], runsInTeamPulse: true,
    purpose: 'Posts new-task notifications and the weekly team report to a channel you choose.',
    usedBy: ['New Task Notification', 'Weekly Team Report', 'Share a task to Slack (task page)']
  },
  {
    slug: 'gmail', name: 'Gmail', actions: ['rowogelpy0h6'], runsInTeamPulse: true,
    purpose: 'Emails new-task notifications to the assignee and the weekly team report, from your own Gmail.',
    usedBy: ['New Task Notification', 'Weekly Team Report']
  },
  {
    slug: 'github', name: 'GitHub', actions: null, runsInTeamPulse: false,
    purpose: 'Build flows from GitHub events (pull requests, issues) — for example post a merged PR link to TeamPulse as task evidence through the Advanced Builder.',
    usedBy: ['Advanced Builder (opens filtered to GitHub)']
  },
  {
    slug: 'google-calendar', name: 'Google Calendar', actions: null, runsInTeamPulse: false,
    purpose: 'Build calendar flows, such as creating a deadline event when a task is assigned.',
    usedBy: ['Advanced Builder (opens filtered to Google Calendar)']
  },
  {
    slug: 'google-sheets', name: 'Google Sheets', actions: null, runsInTeamPulse: false,
    purpose: 'Build reporting flows, such as appending the weekly summary to a sheet.',
    usedBy: ['Advanced Builder (opens filtered to Google Sheets)']
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
