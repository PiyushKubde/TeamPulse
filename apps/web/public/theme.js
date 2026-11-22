/* global window, document */
// Applies the saved theme before first paint, so the page never flashes the wrong theme. Light is the KONVO default.
;(function () {
  var pref = 'light'
  try {
    pref = localStorage.getItem('konvo-theme') || 'light'
  } catch {
    // storage blocked: keep the default
  }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#0F1E23' : '#F2F7F8')
})()
