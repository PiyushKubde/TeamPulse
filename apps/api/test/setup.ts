import { afterAll, beforeEach } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { setViasocketForTests } from '../src/integrations/viasocket/client.js'
import { fakeViasocket } from './fake-viasocket.js'

// Every test starts from an empty database.
beforeEach(async () => {
  const tables = await prisma.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`)
  fakeViasocket.reset()
  setViasocketForTests(fakeViasocket as never)
})

afterAll(async () => {
  await prisma.$disconnect()
})
