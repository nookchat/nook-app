// A reload into an update says so from the first paint.
;(function () {
  try {
    var at = Number(sessionStorage.getItem('nook.updating.v1') || localStorage.getItem('nook.updating.v1'))
    if (at && Date.now() - at < 120000) document.querySelector('#boot .boot-say').textContent = 'Updating Nook'
  } catch (e) {}
})()
