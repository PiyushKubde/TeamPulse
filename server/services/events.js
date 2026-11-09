// A tiny in-process event hub. Services emit after their transaction commits; listeners (alerts, automations)
// run on the next tick so a slow integration never delays or fails the user's request.
const listeners = []
const pending = new Set()

export function onEvent(fn) {
  listeners.push(fn)
  return () => listeners.splice(listeners.indexOf(fn), 1)
}

export function emit(event) {
  for (const fn of listeners) {
    const p = new Promise((resolve) => setImmediate(resolve))
      .then(() => fn(event))
      .catch((error) => console.error(`[events] ${event.type} listener failed:`, error?.message || error))
      .finally(() => pending.delete(p))
    pending.add(p)
  }
}

/** Resolves when every listener started so far has finished (tests and the scheduler use it). */
export async function settled() {
  while (pending.size) await Promise.all([...pending])
}
