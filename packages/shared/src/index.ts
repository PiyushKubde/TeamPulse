import { z } from 'zod'

// ───────────── Enums (mirror prisma/schema.prisma) ─────────────

export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'MENTOR', 'MEMBER'] as const
export const TASK_STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const
export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
export const IMPACT_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export const GOAL_PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'MILESTONE'] as const
export const GOAL_STATUSES = ['ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'ACHIEVED', 'MISSED', 'CANCELLED'] as const
export const PROJECT_STATUSES = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const
export const EVIDENCE_KINDS = [
  'COMMIT',
  'PULL_REQUEST',
  'RELEASE',
  'ISSUE_LINK',
  'DOCUMENT',
  'REPORT',
  'DEPLOYMENT',
  'SCREENSHOT',
  'FILE',
  'APPROVAL',
  'URL',
] as const
export const VERIFICATION_STATUSES = ['RECEIVED', 'VERIFIED', 'REJECTED'] as const
export const BLOCKER_KINDS = ['INTERNAL', 'EXTERNAL', 'DEPENDENCY'] as const
export const FEEDBACK_KINDS = ['MANAGER', 'MENTOR', 'SELF', 'PEER'] as const
export const SYNC_MODES = ['IMPORT_ONLY', 'ONE_WAY', 'TWO_WAY'] as const
export const PROVIDERS = ['linear', 'github', 'jira-software-cloud', 'slack', 'gmail'] as const

export type Role = (typeof ROLES)[number]
export type TaskStatus = (typeof TASK_STATUSES)[number]
export type Priority = (typeof PRIORITIES)[number]
export type ImpactLevel = (typeof IMPACT_LEVELS)[number]
export type GoalPeriod = (typeof GOAL_PERIODS)[number]
export type GoalStatus = (typeof GOAL_STATUSES)[number]
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]
export type SyncMode = (typeof SYNC_MODES)[number]
export type Provider = (typeof PROVIDERS)[number]

export const OPEN_STATUSES: readonly TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']

// ───────────── Primitives ─────────────

const id = z.string().uuid()
const isoDate = z.coerce.date()
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const text = (max: number) => z.string().trim().max(max)
const name = z.string().trim().min(1, 'Required').max(200)

// ───────────── Auth & org ─────────────

export const passwordSchema = z
  .string()
  .min(10, 'At least 10 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Include a letter')
  .regex(/\d/, 'Include a number')

export const registerSchema = z.object({
  name,
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
})
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
})
export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() })
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema })
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) })

export const createOrgSchema = z.object({ name })
export const updateOrgSchema = z.object({
  name: name.optional(),
  settings: z
    .object({
      retentionDays: z.number().int().min(30).max(3650).optional(),
      requireReportApproval: z.boolean().optional(),
    })
    .optional(),
})
export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES).exclude(['OWNER']),
  teamId: id.optional(),
})
export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: name.optional(),
  password: passwordSchema.optional(),
})
export const updateMemberSchema = z.object({
  role: z.enum(ROLES).optional(),
  title: text(100).nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
})
export const teamSchema = z.object({ name, managerId: id.nullable().optional() })
export const teamMembersSchema = z.object({ userIds: z.array(id).max(500) })
export const mentorSchema = z.object({ mentorId: id, menteeId: id })

// ───────────── Projects, goals ─────────────

export const projectSchema = z.object({
  name,
  description: text(5000).nullable().optional(),
  teamId: id.nullable().optional(),
  ownerId: id.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  startDate: isoDate.nullable().optional(),
  targetDate: isoDate.nullable().optional(),
})
export const projectUpdateSchema = projectSchema.partial()

export const keyResultSchema = z.object({
  title: name,
  unit: text(30).nullable().optional(),
  start: z.number().finite().default(0),
  target: z.number().finite(),
  current: z.number().finite().default(0),
})
export const goalSchema = z
  .object({
    title: name,
    description: text(5000).nullable().optional(),
    period: z.enum(GOAL_PERIODS),
    expectedOutcome: text(2000).nullable().optional(),
    ownerId: id.optional(),
    teamId: id.nullable().optional(),
    parentId: id.nullable().optional(),
    startDate: isoDate,
    dueDate: isoDate,
    progress: z.number().int().min(0).max(100).optional(),
    keyResults: z.array(keyResultSchema).max(10).optional(),
  })
  .refine((g) => g.dueDate >= g.startDate, { message: 'Due date must be after the start date', path: ['dueDate'] })
export const goalUpdateSchema = z.object({
  title: name.optional(),
  description: text(5000).nullable().optional(),
  expectedOutcome: text(2000).nullable().optional(),
  actualOutcome: text(2000).nullable().optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  dueDate: isoDate.optional(),
  note: text(2000).optional(),
})
export const keyResultUpdateSchema = z.object({ current: z.number().finite(), note: text(500).optional() })

// ───────────── Tasks ─────────────

export const taskCreateSchema = z.object({
  title: name,
  description: text(20000).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  category: text(60).nullable().optional(),
  labels: z.array(text(40).min(1)).max(20).optional(),
  projectId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  assigneeId: id.nullable().optional(),
  dueAt: isoDate.nullable().optional(),
  estimateMins: z.number().int().min(0).max(100000).nullable().optional(),
  impactLevel: z.enum(IMPACT_LEVELS).optional(),
  complexity: z.number().int().min(1).max(5).optional(),
  recurrenceRule: z.enum(['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY']).nullable().optional(),
  goalIds: z.array(id).max(10).optional(),
  dependsOnIds: z.array(id).max(20).optional(),
})
export const taskUpdateSchema = taskCreateSchema.partial().extend({
  actualMins: z.number().int().min(0).max(100000).optional(),
  sortOrder: z.number().finite().optional(),
  archived: z.boolean().optional(),
})
export const taskListQuerySchema = z.object({
  q: text(200).optional(),
  status: z.union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES))]).optional(),
  priority: z.union([z.enum(PRIORITIES), z.array(z.enum(PRIORITIES))]).optional(),
  projectId: id.optional(),
  assigneeId: z.union([id, z.literal('me'), z.literal('none')]).optional(),
  goalId: id.optional(),
  category: text(60).optional(),
  provider: z.union([z.enum(PROVIDERS), z.literal('native')]).optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  parentId: z.union([id, z.literal('none')]).optional(),
  archived: z.coerce.boolean().optional(),
  needsReview: z.coerce.boolean().optional(),
  sort: z.enum(['dueAt', 'priority', 'updatedAt', 'createdAt', 'sortOrder']).default('updatedAt'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
})
export const bulkTaskSchema = z.object({
  ids: z.array(id).min(1).max(200),
  action: z.enum(['status', 'priority', 'assign', 'archive', 'delete', 'project']),
  value: z.string().nullable().optional(),
})
export const commentSchema = z.object({ body: z.string().trim().min(1).max(10000) })
export const blockerSchema = z.object({ reason: z.string().trim().min(3).max(2000), kind: z.enum(BLOCKER_KINDS) })
export const resolveBlockerSchema = z.object({ resolution: text(2000).optional() })
export const templateSchema = z.object({
  name,
  fields: taskCreateSchema.omit({ goalIds: true, dependsOnIds: true, parentId: true }).partial(),
})
export const assessmentSchema = z.object({
  quality: z.number().int().min(1).max(5),
  impact: z.enum(IMPACT_LEVELS).nullable().optional(),
  note: text(2000).optional(),
})

// ───────────── Planner, sessions ─────────────

export const dailyPlanSchema = z.object({
  date: ymd,
  topOutcomes: z
    .array(z.object({ text: z.string().trim().min(1).max(300), taskId: id.nullable().optional(), done: z.boolean().default(false) }))
    .max(3)
    .optional(),
  plannedTaskIds: z.array(id).max(50).optional(),
  checkIn: text(2000).nullable().optional(),
  energy: z.number().int().min(1).max(5).nullable().optional(),
})
export const dailyReviewSchema = z.object({
  date: ymd,
  review: z.string().trim().min(1).max(5000),
  carryForward: z.array(z.object({ taskId: id, reason: z.string().trim().min(3).max(500) })).max(50),
})
export const startSessionSchema = z.object({ taskId: id.nullable().optional(), kind: z.enum(['FOCUS', 'MANUAL']).default('FOCUS') })
export const manualSessionSchema = z
  .object({ taskId: id.nullable().optional(), startedAt: isoDate, endedAt: isoDate, note: text(500).optional() })
  .refine((s) => s.endedAt > s.startedAt, { message: 'End must be after start', path: ['endedAt'] })

// ───────────── Evidence ─────────────

export const evidenceLinkSchema = z.object({
  taskId: id,
  kind: z.enum(EVIDENCE_KINDS),
  title: name,
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links'),
})
export const verifyEvidenceSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
  qualityScore: z.number().int().min(1).max(5).nullable().optional(),
  impactNote: text(2000).optional(),
  note: text(2000).optional(),
})
export const matchEvidenceSchema = z.object({ taskId: id.nullable() })

// ───────────── Feedback, corrections, scoring ─────────────

export const feedbackSchema = z.object({
  subjectUserId: id,
  kind: z.enum(FEEDBACK_KINDS),
  body: z.string().trim().min(3).max(10000),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  taskId: id.nullable().optional(),
  periodLabel: text(60).optional(),
})
export const feedbackAckSchema = z.object({ response: text(5000).optional() })
export const correctionSchema = z.object({
  targetType: z.enum(['TASK', 'SNAPSHOT', 'ASSESSMENT', 'FEEDBACK', 'EVIDENCE']),
  targetId: id,
  field: text(60).optional(),
  reason: z.string().trim().min(10).max(5000),
})
export const resolveCorrectionSchema = z.object({ status: z.enum(['ACCEPTED', 'REJECTED']), resolution: z.string().trim().min(3).max(5000) })

export const SCORE_DIMENSIONS = ['impact', 'quality', 'alignment', 'reliability', 'evidence'] as const
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number]
export const DEFAULT_WEIGHTS: Record<ScoreDimension, number> = { impact: 30, quality: 25, alignment: 20, reliability: 15, evidence: 10 }
export const weightsSchema = z
  .object({
    impact: z.number().int().min(0).max(100),
    quality: z.number().int().min(0).max(100),
    alignment: z.number().int().min(0).max(100),
    reliability: z.number().int().min(0).max(100),
    evidence: z.number().int().min(0).max(100),
  })
  .refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === 100, { message: 'Weights must add up to 100' })
export const scoringModelSchema = z.object({
  name,
  role: z.enum(ROLES).nullable().optional(),
  weights: weightsSchema,
})

// ───────────── Analytics / reports ─────────────

export const rangeQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  teamId: id.optional(),
  projectId: id.optional(),
  userId: id.optional(),
})
export const generateReportSchema = z.object({
  kind: z.enum(['DAILY', 'WEEKLY']),
  subject: z.string().regex(/^(user|team):[0-9a-f-]{36}$/),
  date: ymd.optional(),
})
export const deliverReportSchema = z.object({ channel: z.enum(['EMAIL', 'SLACK']) })

// ───────────── Integrations ─────────────

export const connectSchema = z.object({ provider: z.enum(PROVIDERS), authId: z.string().min(3).max(200) })
export const connectionSettingsSchema = z.object({
  syncMode: z.enum(SYNC_MODES).optional(),
  teamId: z.string().max(200).optional(),
  teamName: z.string().max(200).optional(),
  projectKey: z.string().max(200).optional(),
  projectName: z.string().max(200).optional(),
  repos: z
    .array(z.string().regex(/^[\w.-]+\/[\w.-]+$/))
    .max(20)
    .optional(),
  importIssues: z.boolean().optional(),
  delivery: z
    .object({
      messageto: z.enum(['channel', 'user']),
      channelId: z.string().max(100).optional(),
      userId: z.string().max(100).optional(),
      label: z.string().max(200).optional(),
    })
    .optional(),
  statusMap: z.partialRecord(z.enum(TASK_STATUSES), z.string().max(200)).optional(),
  userMap: z.record(z.string().max(200), z.string().uuid()).optional(),
})
export const optionsQuerySchema = z.object({
  fieldKey: z.string().max(100),
  search: z.string().max(200).optional(),
  paginate: z.string().max(500).optional(),
  existingFields: z.string().max(4000).optional(),
})
export const mappingDecisionSchema = z.object({ approve: z.boolean(), toValue: z.string().max(60).optional() })
export const resolveConflictSchema = z.object({ keep: z.enum(['internal', 'external']) })

// ───────────── AI ─────────────

export const aiChatSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  threadId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .optional(),
})
export const aiCreateTaskSchema = z.object({ text: z.string().trim().min(3).max(4000) })
export const aiPlanDaySchema = z.object({ date: ymd })
export const aiAnalyzeSchema = z.object({ kind: z.enum(['blockers', 'deadline_risk', 'weekly_summary']), userId: id.optional() })
export const aiDecomposeSchema = z.object({ taskId: id })

// ───────────── API envelope ─────────────

export interface ApiError {
  error: { code: string; message: string; details?: unknown }
}
export interface Paged<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}

/** Score scale used across the product: 0-100, null when there is no data. */
export const scoreBand = (score: number | null) => (score == null ? 'none' : score >= 75 ? 'strong' : score >= 55 ? 'steady' : 'attention')
