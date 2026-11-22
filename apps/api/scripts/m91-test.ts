// REAL M91 check for the on-call channel: the connection test (raises nothing), then one LOW alert.
// Run: npm run m91:test -w @workpulse/api
import { channelAlert, channelInfo, channelConfigured, platformConfigured } from '../src/lib/m91.js'
import { env } from '../src/config/env.js'

async function main() {
  if (!channelConfigured()) return console.log('M91_SEND_LINK is not set in .env')
  const info = await channelInfo()
  console.log(`connection test: channel "${info.channel.name}" (raises nothing)`)
  const r = await channelAlert({
    title: 'WorkPulse on-call test: alerting is connected',
    description: 'A one-off test from WorkPulse. From now on this channel rings when WorkPulse’s database, worker, sync, email or AI break.',
    severity: 'LOW',
    customId: `workpulse-test-${Date.now()}`,
    isAutoClose: true,
    responseOptions: [
      { label: 'I’ll handle it', effect: 'SHARED' },
      { label: 'Seen', effect: 'PERSONAL' },
    ],
  })
  console.log(`test alert: delivered=${r.delivered}${r.deduplicated ? ' (deduplicated)' : ''} id=${r._id}`)
  if (r.delivered === 0) console.log('Nobody was reached: someone must be in the channel with M91 installed and the invitation accepted.')
  console.log(`personal alerts (API key): ${platformConfigured() ? 'configured' : 'NOT configured: add M91_API_KEY to .env'}`)
  void env
}
main().catch((e) => {
  console.error('M91 test failed:', e?.code ?? '', e?.message ?? e)
  process.exit(1)
})
