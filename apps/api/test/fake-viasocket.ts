// A deterministic stand-in for the viasocket-apps client, covering only the methods KONVO calls.
// MOCKED: results from tests using it say nothing about the real viaSocket service.
type Conn = { id: string; service_id: string; isExpired?: boolean; connection_label?: string }

class FakeUser {
  constructor(
    private f: FakeViasocket,
    readonly id: string,
  ) {}
  token = async () => `embed-token-for-${this.id}`
  serviceIdFor = async (slug: string) => `svc-${slug}`
  listConnections = async () => this.f.connections.get(this.id) ?? []
  listOptions = async (_app: string, _event: string, p: { fieldKey: string }) => ({
    options: [{ label: `Option for ${p.fieldKey}`, value: 'opt-1' }],
    hasMore: false,
    paginate: null,
    offset: null,
  })
  subscribe = async (app: string, trigger: string, p: { authId: string; inputData: Record<string, unknown>; code?: string }) => {
    if (this.f.failSubscribe) throw Object.assign(new Error(this.f.failSubscribe), { status: 429 })
    const scriptId = `scri-${app}-${trigger}-${this.f.subscriptions.length}`
    this.f.subscriptions.push({ user: this.id, app, trigger, ...p, scriptId })
    return { scriptId, hookUrl: 'https://hook', title: trigger, authId: p.authId, inputData: p.inputData, meta: {} }
  }
  updateSubscription = async (scriptId: string, p: { code?: string }) => {
    const sub = this.f.subscriptions.find((x) => x.scriptId === scriptId)
    if (sub && p.code) sub.code = p.code
    return { scriptId, hookUrl: '', title: '', authId: '', inputData: {}, meta: {} }
  }
  deleteFlow = async (scriptId: string) => {
    this.f.deleted.push(scriptId)
    return { id: scriptId, status: 'deleted' }
  }
  revokeConnection = async (authId: string) => {
    this.f.revoked.push(authId)
  }
  findEnabled = async () => null
  enable = async (app: string) => ({ scriptId: `enabled-${app}-${this.id}`, webhookUrl: '', serviceId: `svc-${app}`, authId: '' })
  ai = {
    send: async (p: { message: string; prompt?: string; jsonSchema?: { name: string } }) => {
      this.f.aiCalls.push({ user: this.id, name: p.jsonSchema?.name ?? '', message: p.message })
      const next = this.f.aiQueue.shift()
      if (!next) throw new Error('No fake AI answer queued')
      return { threadId: 't', messageId: 'm', content: typeof next === 'function' ? next(p.message) : next, finishReason: 'completed' }
    },
  }
}

export class FakeViasocket {
  connections = new Map<string, Conn[]>()
  subscriptions: { user: string; app: string; trigger: string; authId: string; inputData: Record<string, unknown>; code?: string; scriptId: string }[] = []
  deleted: string[] = []
  revoked: string[] = []
  aiCalls: { user: string; name: string; message: string }[] = []
  aiQueue: (Record<string, unknown> | ((msg: string) => Record<string, unknown>))[] = []
  runCodeResult: unknown = null
  failSubscribe: string | null = null
  reset() {
    this.connections.clear()
    this.subscriptions = []
    this.deleted = []
    this.revoked = []
    this.aiCalls = []
    this.aiQueue = []
    this.failSubscribe = null
  }
  user(id: string) {
    return new FakeUser(this, id)
  }
  addConnection(userId: string, slug: string, authId: string, extra: Partial<Conn> = {}) {
    this.connections.set(userId, [...(this.connections.get(userId) ?? []), { id: authId, service_id: `svc-${slug}`, ...extra }])
  }
  runCode = async () => this.runCodeResult
  runAction = async () => ({})
}

export const fakeViasocket = new FakeViasocket()
