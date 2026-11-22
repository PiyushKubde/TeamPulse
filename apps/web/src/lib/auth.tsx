import { createContext, useContext, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './api'
import type { Me } from './types'

interface AuthValue {
  me: Me | null
  loading: boolean
  refresh: () => Promise<unknown>
  isManager: boolean
  isAdmin: boolean
}
const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/auth/me')
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    staleTime: 60_000,
  })
  const me = q.data ?? null
  const role = me?.role
  return (
    <AuthContext.Provider
      value={{
        me,
        loading: q.isLoading,
        refresh: () => qc.invalidateQueries(),
        isAdmin: role === 'OWNER' || role === 'ADMIN',
        isManager: role === 'OWNER' || role === 'ADMIN' || role === 'MANAGER',
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
