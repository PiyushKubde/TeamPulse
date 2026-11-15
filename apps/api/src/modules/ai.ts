import { Router } from 'express'
import { z } from 'zod'
import { aiAnalyzeSchema, aiChatSchema, aiCreateTaskSchema, aiDecomposeSchema, aiPlanDaySchema } from '@workpulse/shared'
import { prisma } from '../lib/prisma.js'
import { body, param } from '../lib/validate.js'
import { notFound } from '../lib/errors.js'
import { assertCanSeeUser } from '../lib/scope.js'
import { todayIn } from '../lib/dates.js'
import { ctxOf, userOf } from '../middleware/auth.js'
import { aiStatus } from '../ai/provider.js'
import { runAssistant } from '../ai/assistant.js'
import { analyzeWork, classifyTask, decomposeTask, draftTask, planDay, summarizeEvidence } from '../ai/features.js'
import { evidenceScope } from './evidence.js'

export const ai = Router()

ai.get('/ai/status', (_req, res) => res.json(aiStatus()))

ai.post('/ai/chat', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(
    req,
    aiChatSchema.extend({
      history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(6000) }))
        .max(20)
        .default([]),
    }),
  )
  res.json(await runAssistant(ctx, input.history, input.message, userOf(req).name))
})

/** Returns a draft only; the client shows it for the person to edit and confirm via POST /tasks. */
ai.post('/ai/create-task', async (req, res) => {
  const ctx = ctxOf(req)
  const { text } = body(req, aiCreateTaskSchema)
  const tz = (await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { timezone: true } })).timezone
  res.json({ draft: await draftTask(ctx, text, todayIn(tz)) })
})

ai.post('/ai/decompose', async (req, res) => {
  const ctx = ctxOf(req)
  res.json(await decomposeTask(ctx, body(req, aiDecomposeSchema).taskId))
})

ai.post('/ai/classify/:taskId', async (req, res) => {
  const ctx = ctxOf(req)
  res.json({ suggestion: await classifyTask(ctx, param(req, 'taskId')) })
})

ai.post('/ai/plan-day', async (req, res) => {
  const ctx = ctxOf(req)
  res.json(await planDay(ctx, body(req, aiPlanDaySchema).date))
})

ai.post('/ai/analyze-work', async (req, res) => {
  const ctx = ctxOf(req)
  const input = body(req, aiAnalyzeSchema)
  const userId = input.userId ?? ctx.userId
  assertCanSeeUser(ctx, userId)
  res.json(await analyzeWork(ctx, input.kind, userId))
})

ai.post('/ai/evidence-summary/:id', async (req, res) => {
  const ctx = ctxOf(req)
  const e = await prisma.evidence.findFirst({ where: { AND: [evidenceScope(ctx), { id: param(req, 'id') }] } })
  if (!e) throw notFound('Evidence')
  const summary = await summarizeEvidence(ctx.userId, { title: e.title, kind: e.kind, url: e.url, sourceMeta: e.sourceMeta })
  await prisma.evidence.update({ where: { id: e.id }, data: { aiSummary: summary } })
  res.json({ summary })
})
