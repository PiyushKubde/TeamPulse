// The allowlist. Every viaSocket app, trigger, action, key, version and id WorkPulse uses is here, copied from the
// app pages on viasocket.com (2026-11-15). Nothing outside this file can be subscribed to or run, by code or by AI.
export type Capability = 'tasks' | 'evidence' | 'delivery' | 'intake'

export interface TriggerDef {
  key: string
  version: string
  triggerId: string
  kind: 'task' | 'comment' | 'evidence_pr' | 'evidence_commit' | 'evidence_release' | 'task_github_issue' | 'slack_message'
  /** One subscription per resource (a repo, a team), with inputData from the choices made once after Connect. Empty = not configured yet. */
  inputs: (s: ConnectionSettings) => { resource: string; inputData: Record<string, unknown> }[]
  /** Only subscribed when this returns true. */
  enabled?: (s: ConnectionSettings) => boolean
}

export interface PickerDef {
  /** WorkPulse's settings field the choice is stored in. */
  setting: string
  label: string
  app: string
  event: string
  version: string
  fieldKey: string
  multiple?: boolean
  /** existingFields built from earlier choices. */
  needs?: (s: ConnectionSettings) => Record<string, unknown>
}

export interface ProviderDef {
  slug: string
  name: string
  icon: string
  description: string
  capabilities: Capability[]
  triggers: TriggerDef[]
  pickers: PickerDef[]
  supportsTwoWay: boolean
  /** Set to an ISO date only after a real account was connected and every trigger/action passed a real test. */
  verifiedLiveAt: string | null
}

export interface ConnectionSettings {
  syncMode?: 'IMPORT_ONLY' | 'ONE_WAY' | 'TWO_WAY'
  teamId?: string
  teamName?: string
  projectKey?: string
  projectName?: string
  repos?: string[]
  importIssues?: boolean
  delivery?: { messageto: 'channel' | 'user'; channelId?: string; userId?: string; label?: string }
  intake?: { channelId: string; label?: string } | null
  statusMap?: Record<string, string>
  userMap?: Record<string, string>
}

const perRepo = (s: ConnectionSettings) => (s.repos ?? []).map((r) => ({ resource: r, inputData: { repoFullName: r } }))
const team = (s: ConnectionSettings) => (s.teamId ? [{ resource: s.teamId, inputData: { team_id: s.teamId } }] : [])
const project = (s: ConnectionSettings) => (s.projectKey ? [{ resource: s.projectKey, inputData: { project: s.projectKey } }] : [])

export const PROVIDERS: Record<string, ProviderDef> = {
  linear: {
    slug: 'linear',
    name: 'Linear',
    icon: 'https://stuff.thingsofbrand.com/linear.app/images/img6e7b754f26_linear.jpg',
    description: 'New and updated Linear issues become WorkPulse tasks. Optional two-way status sync.',
    capabilities: ['tasks'],
    triggers: [
      { key: 'New_Issue_Created', version: 'v1', triggerId: 'rowm5zd4n3lt', kind: 'task', inputs: team },
      { key: 'Updated_Issue', version: 'v2', triggerId: 'row6a0fpu4gh', kind: 'task', inputs: team },
      { key: 'New_Issue_Comment', version: 'v1', triggerId: 'rowcv4jphhb7', kind: 'comment', inputs: team },
    ],
    pickers: [
      { setting: 'teamId', label: 'Linear team', app: 'linear', event: 'New_Issue_Created', version: 'v1', fieldKey: 'team_id' },
      {
        setting: 'statusMap',
        label: 'Linear status',
        app: 'linear',
        event: 'Update_Issue_Status',
        version: 'v3',
        fieldKey: 'stateID',
        needs: (s) => ({ teams: s.teamId }),
      },
    ],
    supportsTwoWay: true,
    verifiedLiveAt: null,
  },
  'jira-software-cloud': {
    slug: 'jira-software-cloud',
    name: 'Jira',
    icon: 'https://stuff.thingsofbrand.com/atlassian.com/images/img681685c8a4_atlassian.jpg',
    description: 'New and updated Jira issues in one project become WorkPulse tasks.',
    capabilities: ['tasks'],
    triggers: [
      // `status` left out on purpose: every status is synced.
      { key: 'New_Issue', version: 'v2', triggerId: 'rowdqvg70194', kind: 'task', inputs: project },
      { key: 'Updated_Issue', version: 'v4', triggerId: 'rowvosv9vh09', kind: 'task', inputs: project },
    ],
    pickers: [{ setting: 'projectKey', label: 'Jira project', app: 'jira-software-cloud', event: 'Updated_Issue', version: 'v4', fieldKey: 'project' }],
    supportsTwoWay: false,
    verifiedLiveAt: null,
  },
  github: {
    slug: 'github',
    name: 'GitHub',
    icon: 'https://stuff.thingsofbrand.com/github.com/images/img65d45fd9b8_github.jpg',
    description: 'Pull requests, commits and releases arrive as evidence and are matched to tasks.',
    capabilities: ['evidence', 'tasks'],
    triggers: [
      { key: 'Pull_Request_Opens_or_Closes', version: 'v22', triggerId: 'rowru54g3wrd', kind: 'evidence_pr', inputs: perRepo },
      // `sha` is the branch to watch; the repository's default branch "main" (the trigger's own default).
      {
        key: 'New_Commit_Pushed',
        version: 'v6',
        triggerId: 'rowaygkq46ev',
        kind: 'evidence_commit',
        inputs: (s) => (s.repos ?? []).map((r) => ({ resource: r, inputData: { repoFullName: r, sha: 'main' } })),
      },
      { key: 'New_Release_Published', version: 'v6', triggerId: 'rowi8rqh3mlu', kind: 'evidence_release', inputs: perRepo },
      {
        key: 'When_a_new_issue_is_created',
        version: 'v7',
        triggerId: 'rowbsm4g8zdq',
        kind: 'task_github_issue',
        inputs: perRepo,
        enabled: (s) => Boolean(s.importIssues),
      },
    ],
    pickers: [{ setting: 'repos', label: 'Repository', app: 'github', event: 'Pull_Request_Opens_or_Closes', version: 'v22', fieldKey: 'repoFullName' }],
    supportsTwoWay: false,
    verifiedLiveAt: null,
  },
  slack: {
    slug: 'slack',
    name: 'Slack',
    icon: 'https://stuff.thingsofbrand.com/slack.com/images/img668216333e_slack.jpg',
    description: 'Messages in a channel you choose become tasks automatically (AI reads each one). Reports and alerts post to your channel or DM.',
    capabilities: ['intake', 'delivery'],
    triggers: [
      // channel_id: the one intake channel the user picks once after Connect (PICK).
      {
        key: 'New_Message_Posted_in_Channel_Instant',
        version: 'v2',
        triggerId: 'rowo0opjzsgk',
        kind: 'slack_message',
        inputs: (s) => (s.intake?.channelId ? [{ resource: s.intake.channelId, inputData: { channel_id: [s.intake.channelId] } }] : []),
      },
    ],
    pickers: [
      {
        setting: 'intake.channelId',
        label: 'Channel to turn into tasks',
        app: 'slack',
        event: 'New_Message_Posted_in_Channel_Instant',
        version: 'v2',
        fieldKey: 'channel_id',
      },
      {
        setting: 'delivery.channelId',
        label: 'Slack channel',
        app: 'slack',
        event: 'Send_Message',
        version: 'v107',
        fieldKey: 'destination.channel_id',
        needs: () => ({ destination: { messageto: 'channel' } }),
      },
      {
        setting: 'delivery.userId',
        label: 'Slack user (you)',
        app: 'slack',
        event: 'Send_Message',
        version: 'v107',
        fieldKey: 'destination.userId',
        needs: () => ({ destination: { messageto: 'user' } }),
      },
    ],
    supportsTwoWay: false,
    // 2026-11-15: real message → task, confirmation posted, bot echo ignored (docs/viasocket-test-report.md).
    verifiedLiveAt: '2026-11-15',
  },
  gmail: {
    slug: 'gmail',
    name: 'Gmail',
    icon: 'https://stuff.thingsofbrand.com/gmail.com/images/imge_idrA5FDGTH_1763454052978.svg',
    description:
      'Reports emailed from your own Gmail account to you. Connected by an owner or admin, it also sends WorkPulse’s emails (verification, password reset, invitations).',
    capabilities: ['delivery'],
    triggers: [],
    pickers: [],
    supportsTwoWay: false,
    verifiedLiveAt: null,
  },
}

export const ACTIONS = {
  linearUpdateStatus: { app: 'linear', key: 'Update_Issue_Status', version: 'v3', actionId: 'rowcz65p8jcd' },
  jiraFindByJql: { app: 'jira-software-cloud', key: 'Find_Issue_via_JQL', version: 'v1', actionId: 'rowu6c69h46o' },
  slackSendMessage: { app: 'slack', key: 'Send_Message', version: 'v107', actionId: 'row1jrbor' },
  gmailSendEmail: { app: 'gmail', key: 'Send_Email', version: 'v55', actionId: 'rowogelpy0h6' },
} as const

export const provider = (slug: string) => PROVIDERS[slug] ?? null
