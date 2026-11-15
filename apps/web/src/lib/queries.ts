import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Member } from './types'

export const useMembers = () =>
  useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/members'), staleTime: 60_000, select: (d) => d.members })
export const useProjects = () =>
  useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: { id: string; name: string; status: string; progress: number; teamId: string | null; canEdit: boolean }[] }>('/projects'),
    staleTime: 30_000,
    select: (d) => d.projects,
  })
export const useGoalsList = () =>
  useQuery({
    queryKey: ['goals', 'active'],
    queryFn: () => api<{ goals: { id: string; title: string; period: string }[] }>('/goals', { query: { active: true } }),
    staleTime: 30_000,
    select: (d) => d.goals,
  })
export const useTeams = () =>
  useQuery({
    queryKey: ['teams'],
    queryFn: () =>
      api<{ teams: { id: string; name: string; manager: { id: string; name: string } | null; members: { id: string; name: string }[]; canManage: boolean }[] }>(
        '/teams',
      ),
    staleTime: 60_000,
    select: (d) => d.teams,
  })
export const useAiStatus = () =>
  useQuery({ queryKey: ['ai-status'], queryFn: () => api<{ configured: boolean; reason: string | null }>('/ai/status'), staleTime: 300_000 })
