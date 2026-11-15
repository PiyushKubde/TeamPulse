import * as linear from './linear.js'
import * as jira from './jira.js'
import * as github from './github.js'
import * as slack from './slack.js'
import type { Normalized } from '../normalization/types.js'

export interface Adapter {
  normalize: (kind: string, body: unknown, resource?: string) => Normalized
  idempotencyKey: (kind: string, body: unknown, fallback: string, resource?: string) => string
}

export const ADAPTERS: Record<string, Adapter> = { linear, 'jira-software-cloud': jira, github, slack }
