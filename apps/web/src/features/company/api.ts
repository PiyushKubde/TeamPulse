// Types and query hooks for the company-transparency views (GET /company/*, /kpis).
import { useQuery } from '@tanstack/react-query'
import type { Role } from '@workpulse/shared'
import { api } from '@/lib/api'

export type Health = 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK' | 'NO_DATA'

export interface CompanyPerson {
  userId: string
  name: string
  title: string | null
  role: Role
  reportsToId: string | null
  teamIds: string[]
  score: number | null
  dimensions: Record<string, number | null>
  goalProgress: number | null
  goalCount: number
  kpiAttainment: number | null
  kpiCount: number
  overall: number | null
  health: Health
  isMe: boolean
  depth: number
  directReports: number
  subtreeSize: number
  rollupOverall: number | null
}

export interface CompanyTeam {
  id: string
  name: string
  parentId: string | null
  managerId: string | null
  memberIds: string[]
  people: number
  score: number | null
  goalProgress: number | null
  kpiAttainment: number | null
  overall: number | null
  health: Health
}

export interface CompanyOverview {
  days: number
  transparency: 'OPEN' | 'PRIVATE'
  me: string
  summary: { people: number; overall: number | null; health: Health; onTrack: number; atRisk: number; offTrack: number }
  people: CompanyPerson[]
  teams: CompanyTeam[]
}

export interface KpiReading {
  id: string
  value: number
  note: string | null
  at: string
}

export interface Kpi {
  id: string
  name: string
  unit: string | null
  direction: 'HIGHER' | 'LOWER'
  baseline: number
  target: number
  current: number
  cadence: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'
  ownerId: string
  ownerName: string | null
  teamId: string | null
  goalId: string | null
  attainment: number
  readings: KpiReading[]
  canEdit: boolean
}

export interface KeyResultLite {
  id: string
  title: string
  unit: string | null
  start: number
  target: number
  current: number
}

export interface GoalLite {
  id: string
  title: string
  period: string
  status: string
  progress: number
  dueDate: string
  parentId: string | null
  team: { id: string; name: string } | null
  keyResults: KeyResultLite[]
}

export interface CascadeGoal extends GoalLite {
  ownerId: string
  ownerName: string
  ownerTitle: string | null
}

export interface DimensionDetail {
  value: number | null
  weight: number
  inputs: Record<string, number | string>
  missing: string | null
}

export interface PersonBrief {
  userId: string
  name: string
  title: string | null
  role: Role
  overall: number | null
  health: Health
  score: number | null
  goalProgress: number | null
  kpiAttainment: number | null
}

export interface PersonDetail {
  person: CompanyPerson & { dimensionDetail: Record<string, DimensionDetail> | null }
  chain: { userId: string; name: string; title: string | null }[]
  reports: PersonBrief[]
  peers: PersonBrief[]
  goals: GoalLite[]
  kpis: Kpi[]
  canAddKpi: boolean
}

export const useCompanyOverview = (days: number) =>
  useQuery({ queryKey: ['company', 'overview', days], queryFn: () => api<CompanyOverview>('/company/overview', { query: { days } }), staleTime: 30_000 })

export const usePersonDetail = (userId: string | null, days: number) =>
  useQuery({
    queryKey: ['company', 'person', userId, days],
    queryFn: () => api<PersonDetail>(`/company/people/${userId}`, { query: { days } }),
    enabled: !!userId,
  })

export const useCascade = () =>
  useQuery({ queryKey: ['company', 'cascade'], queryFn: () => api<{ goals: CascadeGoal[]; kpis: Kpi[] }>('/company/cascade'), staleTime: 30_000 })

export const useKpis = (ownerId?: string) =>
  useQuery({ queryKey: ['kpis', ownerId ?? 'all'], queryFn: () => api<{ kpis: Kpi[] }>('/kpis', { query: { ownerId } }), staleTime: 30_000 })

export const HEALTH_LABEL: Record<Health, string> = { ON_TRACK: 'On track', AT_RISK: 'At risk', OFF_TRACK: 'Off track', NO_DATA: 'No data yet' }
export const HEALTH_TONE = { ON_TRACK: 'green', AT_RISK: 'amber', OFF_TRACK: 'red', NO_DATA: 'neutral' } as const
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`)
