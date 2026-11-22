import '@testing-library/jest-dom/vitest' // adds the matcher types
import * as matchers from '@testing-library/jest-dom/matchers'
import { afterEach, expect } from 'vitest'
import { cleanup } from '@testing-library/react'

// Register the matchers on this run's own `expect`. The side-effect import above can end up extending a different copy of
// vitest (depending on module caching), which made `toBeInTheDocument` fail intermittently with "Invalid Chai property".
expect.extend(matchers)

afterEach(() => cleanup())
// Recharts' ResponsiveContainer needs ResizeObserver in jsdom.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
