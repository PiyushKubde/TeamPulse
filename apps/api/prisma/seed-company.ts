// DEVELOPMENT / DEMO SEED ONLY: adds "Helios Corp (demo, ~150 people)" to the local database (see src/demo/helios.ts).
// Refuses to run in production; a live app gets the demo through DEMO_SEED=helios and its own DEMO_PASSWORD instead.
// Every account uses the password below.
//   npm run db:seed:company -w @workpulse/api            (add  -- --reset  to replace an earlier copy)
import { prisma } from '../src/lib/prisma.js'
import { seedHelios } from '../src/demo/helios.js'

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.')
  process.exit(1)
}

const PASSWORD = 'Password123'

seedHelios({ password: PASSWORD, reset: process.argv.includes('--reset') })
  .then((created) => created && console.log(`Password for every demo account: ${PASSWORD}`))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
