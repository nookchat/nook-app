// The saved theme goes on before the first paint, so the page never flashes the wrong one.
;(function () {
  var root = document.documentElement
  try {
    var saved = localStorage.getItem('nook.theme.v1')
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved
  } catch (e) {}
  var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  document.querySelector('meta[name="theme-color"]').content = dark ? '#100C0B' : '#FDF6F3'
  // The desktop app showed the same screen while the page came, so it does not come in again.
  if (window.nookDesktop && window.nookDesktop.splash) root.classList.add('boot-held')
})()
