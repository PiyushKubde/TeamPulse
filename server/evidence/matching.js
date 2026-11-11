// Evidence → task matching. Deterministic and cheap, so it runs on every ingested event (no AI per event):
//   explicit_ref  the event names the task (TP-<first 8 characters of the task id>)        confidence 0.95
//   resource_ref  the event's URL is one of the task's links / evidence links              confidence 0.90
//                 the event is in a repository linked from the task, by the task's owner  confidence 0.70
//   text_time     words shared with the task, by the task's owner, inside the task window  confidence 0.40–0.70
// AI-assisted matching happens only inside an on-demand analysis (method 'ai', always needs confirmation).
//
// Rules: a match is never confirmed automatically. Only suggestions at or above IN_ANALYSIS (0.85) — or links a person
// confirmed — are used in an analysis. A match never moves work between people: contributor_id is whoever the
// evidence is attributed to; if that is not the task's owner the link is "shared" and stays distinguishable.
// A decision a person made (confirmed / rejected) is never overwritten.
import { json, now, uuid } from '../db.js'

export const IN_ANALYSIS = 0.85
export const taskRef = (taskId) => `TP-${String(taskId).slice(0, 8).toUpperCase()}`
const REF_RE = /\bTP-([0-9a-f]{8})\b/gi
const STOP = new Set('the a an and or of to in on for with by at from is are was were be this that it as we i you our your task fix add update new into via vs not no yes done work pr issue commit please re fw fwd'.split(' '))
const words = (t) => new Set(String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)))
const DAY = 86400000

function taskUrls(db, task) {
  const urls = new Set(json(task.links, []).map((l) => String(l.url || '').replace(/\/+$/, '')))
  for (const r of db.prepare(`SELECT url FROM evidence WHERE task_id = ? AND kind = 'link'`).all(task.id)) if (r.url) urls.add(String(r.url).replace(/\/+$/, ''))
  return urls
}
function inWindow(task, at) {
  const t = Date.parse(at)
  const start = Date.parse(task.assigned_at || task.created_at) - 3 * DAY
  const end = (task.completed_at ? Date.parse(task.completed_at) : Date.now()) + 3 * DAY
  return t >= start && t <= end
}

/** Proposed matches for one evidence row: [{ task, method, confidence, explanation }], best first, at most 3. */
export function proposeMatches(db, ev) {
  const contributor = ev.actor_user_id
  const text = `${ev.title || ''}\n${ev.content || ''}\n${json(ev.metadata_json, {}).headRef || ''}`
  const out = new Map()
  const add = (task, method, confidence, explanation) => {
    const prev = out.get(task.id)
    if (!prev || prev.confidence < confidence) out.set(task.id, { task, method, confidence, explanation })
  }
  // 1. Explicit references, e.g. "TP-1A2B3C4D" in a commit message, PR title, branch, email subject or message.
  for (const m of text.matchAll(REF_RE)) {
    const task = db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND id LIKE ? AND status != 'CANCELLED'`).get(ev.org_id, `${m[1].toLowerCase()}%`)
    if (task) add(task, 'explicit_ref', 0.95, `The ${ev.app} event mentions ${taskRef(task.id)}.`)
  }
  if (!contributor) return [...out.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 3)
  // Candidate tasks for the remaining methods: the contributor's own tasks around the time of the event.
  const tasks = db.prepare(`SELECT * FROM tasks WHERE org_id = ? AND assignee_id = ? AND status != 'CANCELLED' ORDER BY created_at DESC LIMIT 200`).all(ev.org_id, contributor)
    .filter((t) => inWindow(t, ev.occurred_at))
  const url = ev.source_url ? String(ev.source_url).replace(/\/+$/, '') : null
  const ew = words(`${ev.title} ${ev.content || ''}`.slice(0, 2000))
  for (const task of tasks) {
    const urls = taskUrls(db, task)
    if (url && urls.has(url)) { add(task, 'resource_ref', 0.9, 'The task links to this exact item.'); continue }
    if (ev.app === 'github' && ev.resource_ref && [...urls].some((u) => u.toLowerCase().startsWith(`https://github.com/${String(ev.resource_ref).toLowerCase()}`))) {
      add(task, 'resource_ref', 0.7, `The task links to the repository ${ev.resource_ref}, and this is ${ev.kind.replace('_', ' ')} by the task's owner during the task.`)
      continue
    }
    const tw = words(`${task.title} ${task.description || ''} ${task.expected_outcome || ''}`)
    const shared = [...ew].filter((w) => tw.has(w))
    const overlap = shared.length / Math.max(1, Math.min(ew.size, tw.size))
    if (shared.length >= 2 && overlap >= 0.34) add(task, 'text_time', Math.min(0.7, 0.3 + overlap * 0.5), `Shares the words “${shared.slice(0, 5).join('”, “')}” with the task, by its owner while the task was open.`)
  }
  return [...out.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 3)
}

/** Stores proposals as suggestions. Never touches a link a person confirmed or rejected. Returns how many were written. */
export function storeMatches(db, ev) {
  if (ev.status !== 'active' || ev.attribution === 'disputed') return 0
  let n = 0
  for (const p of proposeMatches(db, ev)) {
    const existing = db.prepare('SELECT * FROM evidence_task_links WHERE evidence_id = ? AND task_id = ?').get(ev.id, p.task.id)
    if (existing && existing.status !== 'suggested') continue
    const contributor = ev.actor_user_id || null
    const share = contributor && contributor !== p.task.assignee_id ? 'shared' : 'individual'
    const ts = now()
    if (existing) {
      if (existing.confidence >= p.confidence && existing.method === p.method) continue
      db.prepare('UPDATE evidence_task_links SET method = ?, confidence = ?, explanation = ?, contributor_id = ?, share = ?, updated_at = ? WHERE id = ?').run(p.method, p.confidence, p.explanation, contributor, share, ts, existing.id)
    } else {
      db.prepare(`INSERT INTO evidence_task_links (id, org_id, evidence_id, task_id, contributor_id, method, confidence, explanation, status, share, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?, ?)`)
        .run(uuid(), ev.org_id, ev.id, p.task.id, contributor, p.method, p.confidence, p.explanation, share, ts, ts)
    }
    n++
  }
  return n
}

/** Links of a task an analysis may use: confirmed ones, and suggestions at or above IN_ANALYSIS. Active evidence only. */
export function usableLinks(db, taskId) {
  return db.prepare(`SELECT e.*, l.id AS link_id, l.status AS link_status, l.method AS link_method, l.confidence, l.explanation, l.share, l.contributor_id FROM evidence_task_links l JOIN external_evidence e ON e.id = l.evidence_id
                     WHERE l.task_id = ? AND e.status = 'active' AND e.attribution != 'disputed' AND (l.status = 'confirmed' OR (l.status = 'suggested' AND l.confidence >= ?)) ORDER BY e.occurred_at`).all(taskId, IN_ANALYSIS)
}
