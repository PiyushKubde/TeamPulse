import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { lazy, type ReactNode } from 'react'
import { useAuth } from '@/lib/auth'
import { Spinner } from '@/components/ui'
import { AppShell } from '@/components/layout/AppShell'
import { LandingPage } from '@/features/landing/LandingPage'
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  LoginPage,
  OnboardingPage,
  PhoneStep,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from '@/features/auth/AuthPages'

// Each area loads on demand, so the first page does not download every chart and form.
const MyAnalytics = lazy(() => import('@/features/dashboard/DashboardPages').then((m) => ({ default: m.MyAnalytics })))
const MyDashboard = lazy(() => import('@/features/dashboard/DashboardPages').then((m) => ({ default: m.MyDashboard })))
const PlannerPage = lazy(() => import('@/features/planner/PlannerPage').then((m) => ({ default: m.PlannerPage })))
const TasksPage = lazy(() => import('@/features/tasks/TasksPage').then((m) => ({ default: m.TasksPage })))
const GoalsPage = lazy(() => import('@/features/goals/GoalsPage').then((m) => ({ default: m.GoalsPage })))
const ProjectDetail = lazy(() => import('@/features/projects/ProjectsPage').then((m) => ({ default: m.ProjectDetail })))
const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage').then((m) => ({ default: m.ProjectsPage })))
const MemberPerformance = lazy(() => import('@/features/team/TeamPages').then((m) => ({ default: m.MemberPerformance })))
const MemberProfile = lazy(() => import('@/features/team/TeamPages').then((m) => ({ default: m.MemberProfile })))
const TeamAnalytics = lazy(() => import('@/features/team/TeamPages').then((m) => ({ default: m.TeamAnalytics })))
const TeamOverview = lazy(() => import('@/features/team/TeamPages').then((m) => ({ default: m.TeamOverview })))
const ReviewsPage = lazy(() => import('@/features/reviews/ReviewsPage').then((m) => ({ default: m.ReviewsPage })))
const IntegrationsPage = lazy(() => import('@/features/integrations/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })))
const AutomationCenter = lazy(() => import('@/features/integrations/AutomationPages').then((m) => ({ default: m.AutomationCenter })))
const SyncHistory = lazy(() => import('@/features/integrations/AutomationPages').then((m) => ({ default: m.SyncHistory })))
const AssistantPage = lazy(() => import('@/features/ai/AssistantPage').then((m) => ({ default: m.AssistantPage })))
const ReportView = lazy(() => import('@/features/reports/ReportsPage').then((m) => ({ default: m.ReportView })))
const ReportsPage = lazy(() => import('@/features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })))
const AlertsPage = lazy(() => import('@/features/alerts/AlertsPage').then((m) => ({ default: m.AlertsPage })))
const CompanyPage = lazy(() => import('@/features/company/CompanyPage').then((m) => ({ default: m.CompanyPage })))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })))

function RequireAuth({ children, needsOrg = true }: { children: ReactNode; needsOrg?: boolean }) {
  const { me, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Spinner />
  // Signed out on the home page: the public KONVO landing page. Anywhere else: sign in first, then come back.
  if (!me && location.pathname === '/') return <LandingPage />
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  // Everyone gives a mobile number before anything else (Google sign-ups and older accounts arrive without one).
  if (me.phoneAlerts && !me.phoneAlerts.hasPhone) return <PhoneStep />
  if (needsOrg && !me.activeOrgId) return <Navigate to="/onboarding" replace />
  return <>{children}</>
}

function ManagerOnly({ children }: { children: ReactNode }) {
  const { isManager } = useAuth()
  return isManager ? <>{children}</> : <Navigate to="/" replace />
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth()
  if (loading) return <Spinner />
  return me ? <Navigate to="/" replace /> : <>{children}</>
}

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <RegisterPage />
          </GuestOnly>
        }
      />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route
        path="/onboarding"
        element={
          <RequireAuth needsOrg={false}>
            <OnboardingPage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<MyDashboard />} />
        <Route path="planner" element={<PlannerPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="goals" element={<GoalsPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="analytics" element={<MyAnalytics />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="reports/:id" element={<ReportView />} />
        <Route
          path="team"
          element={
            <ManagerOnly>
              <TeamOverview />
            </ManagerOnly>
          }
        />
        <Route
          path="team/analytics"
          element={
            <ManagerOnly>
              <TeamAnalytics />
            </ManagerOnly>
          }
        />
        <Route
          path="team/members"
          element={
            <ManagerOnly>
              <MemberPerformance />
            </ManagerOnly>
          }
        />
        <Route path="team/members/:userId" element={<MemberProfile />} />
        <Route path="company" element={<CompanyPage />} />
        <Route path="reviews" element={<ReviewsPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="automations" element={<AutomationCenter />} />
        <Route path="sync-history" element={<SyncHistory />} />
        <Route path="assistant" element={<AssistantPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <div className="py-20 text-center">
              <p className="text-lg font-semibold">Page not found</p>
              <a href="/" className="text-sm text-primary hover:underline">
                Go to your dashboard
              </a>
            </div>
          }
        />
      </Route>
    </Routes>
  )
}
