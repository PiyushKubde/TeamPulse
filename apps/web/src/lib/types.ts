import type { ImpactLevel, Priority, Role, TaskStatus } from '@workpulse/shared'

export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean }
  activeOrgId: string | null
  role: Role | null
  organizations: { id: string; name: string; slug: string; role: Role }[]
  mailConfigured: boolean
  phoneAlerts: { available: boolean; hasPhone: boolean; state: 'pending' | 'accepted' | 'declined' | null }
}

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: Priority
  impactLevel: ImpactLevel
  complexity: number
  category: string | null
  labels: string[]
  dueAt: string | null
  startedAt: string | null
  completedAt: string | null
  estimateMins: number | null
  actualMins: number
  assigneeId: string | null
  creatorId: string
  parentId: string | null
  projectId: string | null
  origin: 'NATIVE' | 'EXTERNAL'
  needsReview: boolean
  recurrenceRule: string | null
  reopenCount: number
  createdAt: string
  updatedAt: string
  assignee: { id: string; name: string } | null
  project: { id: string; name: string } | null
  source: { provider: string; externalKey: string | null; sourceUrl: string | null; lastSyncedAt: string } | null
  goals: { id: string; title: string }[]
  openBlockers: number
  canEdit: boolean
  _count: { subtasks: number; comments: number; evidence: number }
}

export interface Member {
  id: string
  userId: string
  name: string
  email: string | null
  role: Role
  title: string | null
  status: 'ACTIVE' | 'SUSPENDED'
  teams: { id: string; name: string }[]
  managed: boolean
}

export interface Dimension {
  value: number | null
  weight: number
  inputs: Record<string, number | string>
  missing: string | null
}
export interface Score {
  score: number | null
  dimensions: Record<'impact' | 'quality' | 'alignment' | 'reliability' | 'evidence', Dimension>
  excludedWeight: number
  diagnostics: { estimateAccuracy: number | null; avgCycleHours: number | null; workInProgress: number; reopened: number }
  metrics: {
    completed: number
    highImpactCompleted: number
    impactPoints: number
    committed: number
    onTime: number
    excusedLate: number
    missed: number
    evidenceBacked: number
  }
  model?: { name: string; version: number }
}
export type { ImpactLevel, Priority, Role, TaskStatus }
