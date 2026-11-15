/* global window, document */
// Applies the saved theme before first paint, so the page never flashes the wrong theme. Dark is the KONVO default.
;(function () {
  var pref = 'dark'
  try {
    pref = localStorage.getItem('konvo-theme') || 'dark'
  } catch {
    // storage blocked: keep the default
  }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#1B2430' : '#EEF1F5')
})()
