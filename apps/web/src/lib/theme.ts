// Theme preference: dark (the KONVO default), light, or follow the system. index.html applies it before first paint;
// this module changes it and lets components (the toaster, the switcher) follow along.
import { useSyncExternalStore } from 'react'

export type ThemePref = 'dark' | 'light' | 'system'
const KEY = 'konvo-theme'
const EVENT = 'konvo-theme'
const mq = () => window.matchMedia('(prefers-color-scheme: dark)')

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'system' ? v : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(pref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && mq().matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1B2430' : '#EEF1F5')
  window.dispatchEvent(new Event(EVENT))
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  applyTheme(pref)
}

function subscribe(cb: () => void) {
  const onSystem = () => getThemePref() === 'system' && applyTheme('system')
  const m = mq()
  m.addEventListener('change', onSystem)
  window.addEventListener(EVENT, cb)
  return () => {
    m.removeEventListener('change', onSystem)
    window.removeEventListener(EVENT, cb)
  }
}

/** The theme on screen right now, and the stored preference. */
export function useTheme() {
  const resolved = useSyncExternalStore(subscribe, () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'))
  const pref = useSyncExternalStore(subscribe, getThemePref)
  return { resolved, pref, setPref: setThemePref } as const
}
