// `npm run dev`: API + worker + web. When PUBLIC_API_URL is not set and ngrok is installed, opens a tunnel to the API
// so viaSocket can deliver live events (Slack messages, Linear/Jira/GitHub changes) to this machine. The worker
// re-points existing subscriptions to the new address on start-up.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')
const env = { ...process.env }
const children = []
const stop = () => children.forEach((c) => c.kill('SIGTERM'))
process.on('SIGINT', () => (stop(), process.exit(0)))
process.on('SIGTERM', () => (stop(), process.exit(0)))

async function tunnel() {
  if (env.PUBLIC_API_URL) return console.log(`[dev] live events → ${env.PUBLIC_API_URL}`)
  if (spawnSync('ngrok', ['version'], { stdio: 'ignore' }).status !== 0) {
    return console.log('[dev] PUBLIC_API_URL is not set and ngrok is not installed: live events (Slack → tasks, Linear/Jira/GitHub sync) are off.')
  }
  const ngrok = spawn('ngrok', ['http', String(env.PORT ?? 4000), '--log=stdout', '--log-level=warn'], { stdio: ['ignore', 'ignore', 'inherit'] })
  children.push(ngrok)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const { tunnels } = await (await fetch('http://127.0.0.1:4040/api/tunnels')).json()
      const url = tunnels?.find((t) => t.public_url?.startsWith('https://'))?.public_url
      if (url) {
        env.PUBLIC_API_URL = url
        return console.log(`[dev] ngrok tunnel: live events → ${url}`)
      }
    } catch {
      // ngrok's local API is not up yet
    }
  }
  console.log('[dev] ngrok did not report a tunnel (is it signed in? run `ngrok config add-authtoken …`). Live events are off.')
}

await tunnel()
const run = spawn(
  'npx',
  [
    'concurrently',
    '-k',
    '-n',
    'api,worker,web',
    '-c',
    'blue,magenta,green',
    'npm run dev -w @workpulse/api',
    'npm run worker:dev -w @workpulse/api',
    'npm run dev -w @workpulse/web',
  ],
  { stdio: 'inherit', env },
)
children.push(run)
run.on('exit', (code) => (stop(), process.exit(code ?? 0)))
