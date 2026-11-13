// The KONVO identity in one place: wording and the logo mark. Views import from here; nothing else defines the logo.
// The mark is a geometric K: a vertical stem and two straight 45° arms that meet at its mid-height notch, drawn as one
// outline (no overlapping shapes, so no hairline seam at small sizes). Colours come from --logo-bg / --logo-fg, so the
// tile is matte black in the light theme and white in the dark theme.
export const BRAND = Object.freeze({
  name: 'KONVO',
  category: 'AI Work Intelligence Platform',
  tagline: 'From conversations to contribution.',
  hero: 'Work moves forward. Every contribution counts.',
  description: 'KONVO is an AI work intelligence platform: it turns conversations into tasks, makes ownership explicit, and shows the contributions behind the work, backed by evidence.'
})

export const K_PATH = 'M9.07 7.5H12.87V12.2L17.57 7.5H22.94L14.44 16L22.94 24.5H17.57L12.87 19.8V24.5H9.07Z'

/** The logo mark as an SVG string (decorative: the name next to it carries the label). */
export const logoMark = (size = 28) => `<svg class="mark" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="5" fill="var(--logo-bg)"/><path d="${K_PATH}" fill="var(--logo-fg)"/></svg>`

/** Mark plus wordmark, for headers. */
export const logoLockup = (size = 28) => `${logoMark(size)}<span class="wordmark">${BRAND.name}</span>`
