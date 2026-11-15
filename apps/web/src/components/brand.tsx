// The KONVO identity in one place: wording and the logo mark (a geometric K on a periwinkle tile).
export const BRAND = {
  name: 'KONVO',
  category: 'AI Work Intelligence Platform',
  tagline: 'From conversations to contribution.',
  hero: 'Work moves forward. Every contribution counts.',
} as const

const K_PATH = 'M9.07 7.5H12.87V12.2L17.57 7.5H22.94L14.44 16L22.94 24.5H17.57L12.87 19.8V24.5H9.07Z'

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false" className="shrink-0">
      <rect width="32" height="32" rx="5" fill="var(--logo-bg)" />
      <path d={K_PATH} fill="var(--logo-fg)" />
    </svg>
  )
}

/** Mark plus wordmark, for headers. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-ink">
      <LogoMark size={size} />
      <span className="text-[15px] font-semibold tracking-[0.08em]">{BRAND.name}</span>
    </span>
  )
}
