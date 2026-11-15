import { afterAll, beforeEach } from 'vitest'
import { prisma } from '../src/lib/prisma.js'
import { setViasocketForTests } from '../src/integrations/viasocket/client.js'
import { fakeViasocket } from './fake-viasocket.js'

// Every test starts from an empty database.
beforeEach(async () => {
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_prisma%' AND name NOT LIKE 'sqlite_%'",
  )
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
  for (const t of tables) await prisma.$executeRawUnsafe(`DELETE FROM "${t.name}"`)
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON')
  fakeViasocket.reset()
  setViasocketForTests(fakeViasocket as never)
})

afterAll(async () => {
  await prisma.$disconnect()
})
