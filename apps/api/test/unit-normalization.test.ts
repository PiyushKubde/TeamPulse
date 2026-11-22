import { describe, expect, it } from 'vitest'
import { mapPriority, mapStatus } from '../src/integrations/normalization/status-mapping.js'
import * as linear from '../src/integrations/providers/linear.js'
import * as jira from '../src/integrations/providers/jira.js'
import * as github from '../src/integrations/providers/github.js'

const none = new Map<string, string>()

describe('status mapping', () => {
  it('maps known names and provider categories', () => {
    expect(mapStatus('linear', 'In Progress', 'started', none)).toEqual({ value: 'IN_PROGRESS', source: 'NAME' })
    expect(mapStatus('linear', 'Code Review', 'started', none).value).toBe('IN_REVIEW')
    expect(mapStatus('linear', 'Shipped 🚀', 'completed', none)).toEqual({ value: 'COMPLETED', source: 'CATEGORY' })
    expect(mapStatus('jira-software-cloud', 'Selected for Development', 'new', none).value).toBe('TODO')
    expect(mapStatus('jira-software-cloud', "Won't Do", 'done', none).value).toBe('CANCELLED')
    expect(mapStatus('github', null, 'not_planned', none).value).toBe('CANCELLED')
  })
  it('org-approved mappings win over defaults', () => {
    expect(mapStatus('linear', 'QA Ready', null, new Map([['qa ready', 'IN_REVIEW']]))).toEqual({ value: 'IN_REVIEW', source: 'ORG' })
    expect(mapStatus('linear', 'Done', 'completed', new Map([['done', 'IN_REVIEW']])).value).toBe('IN_REVIEW')
  })
  it('unknown values fall back to TODO and are flagged', () => {
    expect(mapStatus('linear', 'Mystery', null, none)).toEqual({ value: 'TODO', source: 'FALLBACK' })
  })
})

describe('priority mapping', () => {
  it('maps Linear numbers and Jira names', () => {
    expect(mapPriority('1', none).value).toBe('CRITICAL')
    expect(mapPriority('2', none).value).toBe('HIGH')
    expect(mapPriority('4', none).value).toBe('LOW')
    expect(mapPriority('0', none)).toEqual({ value: 'MEDIUM', source: 'NAME' })
    expect(mapPriority('Highest', none).value).toBe('CRITICAL')
    expect(mapPriority('Major', none).value).toBe('HIGH')
    expect(mapPriority('Trivial', none).value).toBe('LOW')
  })
  it('flags unknown priorities', () => {
    expect(mapPriority('Whenever', none)).toEqual({ value: 'MEDIUM', source: 'FALLBACK' })
  })
})

const linearIssue = {
  id: 'lin_123',
  identifier: 'ENG-42',
  title: 'Implement authentication',
  state: { name: 'In Progress', type: 'started' },
  priority: 2,
  assignee: { id: 'u1', name: 'Alex', email: 'Alex@Example.com' },
  url: 'https://linear.app/example/issue/ENG-42',
  updatedAt: '2026-11-01T10:00:00.000Z',
  dueDate: '2026-11-20',
  labels: [{ name: 'auth' }],
}

describe('Linear adapter', () => {
  it('normalizes the spec example (bare and webhook envelope)', () => {
    const n = linear.normalizeIssue(linearIssue)
    expect(n).toMatchObject({
      provider: 'linear',
      externalId: 'lin_123',
      externalKey: 'ENG-42',
      title: 'Implement authentication',
      rawStatus: 'In Progress',
      rawPriority: '2',
      sourceUrl: 'https://linear.app/example/issue/ENG-42',
      deleted: false,
      labels: ['auth'],
    })
    expect(n.externalUpdatedAt?.toISOString()).toBe('2026-11-01T10:00:00.000Z')
    const wrapped = linear.normalizeIssue({ action: 'update', type: 'Issue', data: linearIssue })
    expect(wrapped.externalId).toBe('lin_123')
    expect(linear.normalizeIssue({ action: 'remove', type: 'Issue', data: linearIssue }).deleted).toBe(true)
  })
  it('accepts GraphQL-shaped labels', () => {
    expect(linear.normalizeIssue({ ...linearIssue, labels: { nodes: [{ name: 'x' }] } }).labels).toEqual(['x'])
  })
  it('rejects records without id or title', () => {
    expect(() => linear.normalizeIssue({ title: 'no id' })).toThrow()
    expect(() => linear.normalizeIssue({ id: 'x', title: '' })).toThrow()
    expect(() => linear.normalizeIssue({ ...linearIssue, updatedAt: 'not a date' })).toThrow()
  })
  it('builds idempotency keys from id + updatedAt', () => {
    expect(linear.idempotencyKey('task', linearIssue, 'fb')).toBe('lin_123:2026-11-01T10:00:00.000Z')
    expect(linear.idempotencyKey('task', { junk: true }, 'fb')).toBe('fb')
  })
  it('normalizes comments', () => {
    expect(linear.normalizeComment({ id: 'c1', body: 'Looks good', issueId: 'lin_123', user: { name: 'Sam' } })).toMatchObject({
      externalId: 'c1',
      issueExternalId: 'lin_123',
      author: 'Sam',
    })
    expect(() => linear.normalizeComment({ id: 'c1', body: 'x' })).toThrow('comment without issue id')
  })
})

describe('Jira adapter', () => {
  const issue = {
    id: 10001,
    key: 'PROJ-7',
    self: 'https://acme.atlassian.net/rest/api/3/issue/10001',
    fields: {
      summary: 'Fix checkout',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      priority: { name: 'High' },
      assignee: { accountId: 'a1', emailAddress: 'sam@example.com', displayName: 'Sam' },
      duedate: '2026-11-30',
      updated: '2026-11-02T08:00:00.000+0000',
      labels: ['payments'],
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Card form fails' }] }] },
    },
  }
  it('normalizes webhook envelope and ADF descriptions', () => {
    const n = jira.normalizeIssue({ webhookEvent: 'jira:issue_updated', issue })
    expect(n).toMatchObject({
      externalId: '10001',
      externalKey: 'PROJ-7',
      title: 'Fix checkout',
      rawPriority: 'High',
      rawStatusCategory: 'indeterminate',
      sourceUrl: 'https://acme.atlassian.net/browse/PROJ-7',
      description: 'Card form fails',
    })
    expect(jira.normalizeIssue({ webhookEvent: 'jira:issue_deleted', issue }).deleted).toBe(true)
  })
  it('normalizes JQL search results (backfill)', () => {
    const r = jira.normalize('task', { issues: [issue, { ...issue, id: '2', key: 'PROJ-8' }] })
    expect(r.type).toBe('task')
    expect(r.items).toHaveLength(2)
  })
})

describe('GitHub adapter', () => {
  it('turns a merged PR into evidence keyed by state', () => {
    const r = github.normalize('evidence_pr', {
      action: 'closed',
      repository: { full_name: 'acme/web' },
      pull_request: {
        id: 9,
        number: 12,
        title: 'ENG-42 add login',
        merged: true,
        state: 'closed',
        html_url: 'https://github.com/acme/web/pull/12',
        head: { ref: 'eng-42-login' },
      },
    })
    expect(r.type).toBe('evidence')
    expect(r.items[0]).toMatchObject({ kind: 'PULL_REQUEST', externalId: 'pr:acme/web#12:merged', url: 'https://github.com/acme/web/pull/12' })
  })
  it('handles polled commit lists', () => {
    const r = github.normalize(
      'evidence_commit',
      { list: [{ sha: 'abcdef1234', commit: { message: 'PROJ-7 fix\n\nbody', author: { name: 'Sam', date: '2026-11-02T00:00:00Z' } } }] },
      'acme/web',
    )
    expect(r.items[0]).toMatchObject({ kind: 'COMMIT', externalId: 'commit:abcdef1234', title: 'Commit abcdef1: PROJ-7 fix' })
  })
  it('imports issues but skips pull requests delivered as issues', () => {
    const r = github.normalize(
      'task_github_issue',
      [
        { id: 1, number: 3, title: 'Bug', state: 'open' },
        { id: 2, number: 4, title: 'PR', state: 'open', pull_request: {} },
      ],
      'acme/web',
    )
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ externalKey: 'acme/web#3' })
  })
})
