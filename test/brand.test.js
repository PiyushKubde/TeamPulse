// The KONVO rename, on the parts that are not just screen text: the sent-by marker (new name for what we send, both names
// recognised when we read, so mail and Slack posts sent before the rename are never ingested as new requests), outgoing
// message text, email templates, M91 defaults, and the identifiers that must NOT change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARKER, LEGACY_MARKER, isOwnMessage } from '../server/integrations/actions.js'
import { parseEvent } from '../server/automations/intake.js'
import { slack, gmail } from '../server/evidence/collectors.js'
import { EMAILS } from '../server/auth/mailer.js'
import { createM91Transport } from '../server/integrations/m91.js'
import { loadConfig } from '../server/config.js'
import { checkPasswordPolicy } from '../server/auth/password.js'
import { startApp, seedOrg } from './helpers.js'

test('the marker: KONVO is what we send, TeamPulse is still recognised as ours', () => {
  assert.equal(MARKER, 'Sent by KONVO'); assert.equal(LEGACY_MARKER, 'Sent by TeamPulse')
  for (const own of [MARKER, LEGACY_MARKER, `Hi\n\n${MARKER}`, `_${LEGACY_MARKER}_`, `*Weekly*\nbody\n_${MARKER}_`]) assert.equal(isOwnMessage(own), true, own)
  for (const other of ['', null, undefined, 'Sent by Eve', 'sent by konvo', 'Please look at KONVO', 'Sent by KONV']) assert.equal(isOwnMessage(other), false, String(other))
})

test('intake: our own Slack and Gmail messages are ignored under either name; real ones are not', () => {
  const slackEv = (text, extra = {}) => ({ text, ts: '1762500000.000100', channel: 'C1', user: 'U0EVE00001', ...extra })
  for (const text of [`Weekly report\n_${MARKER}_`, `Weekly report\n_${LEGACY_MARKER}_`]) assert.equal(parseEvent('slack', slackEv(text)).ignore, 'sent by KONVO', text)
  assert.equal(parseEvent('slack', slackEv('Please fix the export')).ignore, null)
  assert.equal(parseEvent('slack', slackEv('please fix it', { bot_id: 'B1' })).ignore, 'posted by a bot', 'the other ignore reasons are unchanged')
  const mail = (o) => ({ id: 'm1', subject: 'Hi', snippet: 'body', ...o })
  for (const o of [{ snippet: `body\n\n${MARKER}` }, { snippet: `body\n\n${LEGACY_MARKER}` }, { from: 'KONVO <no-reply@example.com>' }, { from: 'TeamPulse <no-reply@example.com>' }]) assert.equal(parseEvent('gmail', mail(o)).ignore, 'sent by KONVO', JSON.stringify(o))
  assert.equal(parseEvent('gmail', mail({ from: 'Customer <c@example.com>' })).ignore, null)
})

test('evidence collectors: our own Slack and Gmail messages are never collected as work evidence, under either name', () => {
  for (const text of [`Weekly report\n_${MARKER}_`, `Weekly report\n_${LEGACY_MARKER}_`]) assert.deepEqual(slack.normalize('messages', { type: 'message', text, ts: '1762500000.000100', channel: 'C1', user: 'U1' }), { ignore: 'sent by KONVO' }, text)
  assert.ok(Array.isArray(slack.normalize('messages', { type: 'message', text: 'Root cause found', ts: '1762500000.000100', channel: 'C1', user: 'U1' })), 'ordinary messages still collected')
  for (const body of [`Summary\n\n${MARKER}`, `Summary\n\n${LEGACY_MARKER}`]) assert.deepEqual(gmail.normalize('received', { id: 'g1', rawId: 'g1', subject: 'Weekly', bodyPlain: body, From: 'a@b.co' }), { ignore: 'sent by KONVO' }, body)
  assert.ok(Array.isArray(gmail.normalize('received', { id: 'g2', rawId: 'g2', subject: 'Question', bodyPlain: 'Can you look?', From: 'a@b.co' })))
})

test('emails say KONVO, in a matte black-and-white layout', () => {
  for (const [k, mail] of Object.entries({ verify: EMAILS.verify('Eve', 'https://app.example/x'), reset: EMAILS.reset('Eve', 'https://app.example/x'), linkPassword: EMAILS.linkPassword('Eve', 'https://app.example/x'), alreadyRegistered: EMAILS.alreadyRegistered('Eve', 'https://app.example/x') })) {
    const all = `${mail.subject}\n${mail.text}\n${mail.html}`
    assert.match(mail.subject, /KONVO/, k); assert.doesNotMatch(all, /TeamPulse/i, `${k}: no former name`)
    assert.match(mail.text, /— KONVO$/, `${k}: signature`); assert.match(mail.html, /Inter/, `${k}: Inter first`)
    assert.doesNotMatch(mail.html, /#4338ca|indigo|gradient|box-shadow/i, `${k}: no colour, gradient or glow`); assert.match(mail.html, /background:#111111/, `${k}: black button`)
  }
})

test('M91: default labels, fallback titles and status messages say KONVO', async () => {
  const calls = []
  const f = async (url, init) => { calls.push({ url, body: init?.body ? JSON.parse(init.body) : null }); return { ok: true, status: 201, json: async () => ({ success: true, data: { _id: 'a1', delivered: 1 } }) } }
  const t = createM91Transport({ apiKey: 'm91sk_abcdefgh12345' }, f)
  await t.send({ title: '', recipient: { phone: '919876543210' }, idempotencyKey: 'k1' })
  assert.equal(calls[0].body.title, 'KONVO alert', 'fallback title')
  await t.send({ title: 'Hi', recipient: { phone: '919876543210' }, idempotencyKey: 'k2' })
  assert.equal(calls[1].body.title, 'KONVO: Hi', 'short titles get the product prefix')
  await assert.rejects(t.send({ title: 'A real title', recipient: { name: 'Eve' } }), (e) => e.code === 'NO_PHONE' && /no phone number in KONVO/.test(e.message) && !/TeamPulse/.test(e.message))
  const ch = createM91Transport({ sendLink: 'https://m91-api.msg91.com/s/abcdefgh12', callbackUrl: 'https://x.example/api/webhooks/m91?token=t' }, f)
  assert.match(ch.status().message, /Answers come back to KONVO/); assert.doesNotMatch(JSON.stringify([ch.status(), t.status()]), /TeamPulse/)
})

test('defaults and identifiers: sender name is KONVO; common passwords include both names; the CSRF header and storage names are untouched', async () => {
  const keep = process.env.MAIL_FROM_NAME
  delete process.env.MAIL_FROM_NAME
  try { assert.equal(loadConfig().mail.fromName, 'KONVO') } finally { if (keep !== undefined) process.env.MAIL_FROM_NAME = keep }
  for (const pw of ['Konvo1234567', 'Teampulse123']) assert.throws(() => checkPasswordPolicy(pw, { email: 'x@y.co', name: 'X' }), /too common/, pw)
  const t = await startApp()
  try {
    const s = seedOrg(t.db)
    // The CSRF contract is unchanged: the header value is still "TeamPulse" (helpers send it), and without it writes are refused.
    assert.equal((await t.call('/api/tasks', { method: 'POST', as: s.manager, body: { title: 'x' }, headers: { 'X-Requested-With': 'KONVO' } })).status, 403)
    const csv = await t.call('/api/reports/status.csv', { as: s.manager })
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /^attachment; filename="konvo-status-\d{4}-\d{2}-\d{2}\.csv"$/)
    const health = await t.call('/api/health')
    assert.equal(health.status, 200)
  } finally { await t.close() }
})
