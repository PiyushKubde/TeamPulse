import { Router } from 'express'
import { requireOrg } from '../middleware/auth.js'
import '../jobs/processors.js'
import { tasks } from './tasks.js'
import { projects } from './projects.js'
import { goals } from './goals.js'
import { planner } from './planner.js'
import { evidence } from './evidence.js'
import { analytics } from './analytics.js'
import { people } from './people.js'
import { reports } from './reports.js'
import { ai } from './ai.js'
import { integrations } from './integrations.js'
import { company } from './company.js'

/** Every route here requires an active organization membership; scope is built per request. */
export const routes = Router()
routes.use(requireOrg)
routes.use(tasks, projects, goals, planner, evidence, analytics, people, reports, ai, integrations, company)
