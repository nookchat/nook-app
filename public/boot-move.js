// The home site moved from cathode.video to nookchat.app. A browser keeps each site's storage
// apart, so what Nook kept on the old site (the key that is you, your name, your servers, your
// settings) is not on the new one. The first time a browser opens the new site with no account,
// it goes to the old site's move.html and back, once, before the page starts: the old site
// seals what it kept for a key this page just made, and this page opens it.
//
// An old link or bookmark in a browser tab goes to the same place on the new site, which then
// fetches the account. The desktop app, the Android app and a home screen app stay where they are.
;(function () {
  var NEW_HOST = /^(www\.)?nookchat\.app$/
  var OLD_HOST = /^(www\.)?cathode\.video$/
  var STATE = 'nook.move.v1'
  var DONE = 'nook.moved.v1'
  /** How long the trip to the old site may take. */
  var TRIP_MS = 5 * 60 * 1000
  /** A trip that never came back is made again, this many times at most. */
  var MOST_TRIES = 3
  /** If the page is still here this long after it set off, the trip did not start, and the page starts as it is. */
  var LEAVE_WAIT_MS = 10000

  var port = location.port ? ':' + location.port : ''
  var site = function (host) {
    return location.protocol + '//' + host + port + '/'
  }
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  var android = !!(window.Capacitor || window.androidBridge)

  // The page waits for this before it starts, so it never starts on half of an account.
  var release = function () {}
  var hold = function () {
    window.nookMoving = new Promise(function (done) {
      release = done
    })
  }

  var b64u = function (bytes) {
    var text = ''
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  var unb64u = function (text) {
    var plain = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    var bytes = new Uint8Array(plain.length)
    for (var i = 0; i < plain.length; i++) bytes[i] = plain.charCodeAt(i)
    return bytes
  }

  /** The same test as nameChosen in src/store/identity.ts: a key, and a name the person picked. */
  var hasAccount = function () {
    var key = localStorage.getItem('nook.identity.v1') || ''
    var name = localStorage.getItem('nook.name.v1') || ''
    return /^[0-9a-f]{64}$/.test(key) && !!name && name !== localStorage.getItem('nook.name.auto.v1')
  }

  var host = location.host.replace(/:\d+$/, '')

  if (OLD_HOST.test(host)) {
    if (window.nookDesktop || android || standalone) return
    hold()
    location.replace(site('www.nookchat.app') + location.hash)
    return
  }
  if (!NEW_HOST.test(host) || android || standalone) return

  /** Back from the old site: open what it sealed, keep it, and start again with it. */
  var arrive = function (reply) {
    hold()
    var path = location.pathname + location.search
    history.replaceState(null, '', path)
    var saved = null
    try {
      saved = JSON.parse(sessionStorage.getItem(STATE) || 'null')
      sessionStorage.removeItem(STATE)
      localStorage.setItem(DONE, 'done')
    } catch (e) {}
    // Only an answer to this page's own trip, made a moment ago, is taken. Anything else is ignored.
    if (!saved || typeof saved.at !== 'number' || Date.now() - saved.at > TRIP_MS) return release()
    var goOn = function () {
      history.replaceState(null, '', path + (saved.hash || ''))
      release()
    }
    var parts = reply.split('.')
    if (reply === 'none' || parts.length !== 3 || hasAccount()) return goOn()
    var subtle = crypto.subtle
    Promise.all([
      subtle.importKey('jwk', saved.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
      subtle.importKey('raw', unb64u(parts[0]), { name: 'ECDH', namedCurve: 'P-256' }, false, []),
    ])
      .then(function (keys) {
        return subtle.deriveBits({ name: 'ECDH', public: keys[1] }, keys[0], 256)
      })
      .then(function (bits) {
        return subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
      })
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('nook move v1') },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt'],
        )
      })
      .then(function (key) {
        return subtle.decrypt({ name: 'AES-GCM', iv: unb64u(parts[1]) }, key, unb64u(parts[2]))
      })
      .then(function (plain) {
        var kept = JSON.parse(new TextDecoder().decode(plain))
        if (!kept || !/^[0-9a-f]{64}$/.test(kept['nook.identity.v1'] || '')) return goOn()
        // What a page here made before it had an account goes, so nothing of it mixes in.
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var old = localStorage.key(i)
          if (old && old.indexOf('nook.') === 0 && old !== DONE) localStorage.removeItem(old)
        }
        for (var name in kept) {
          if (name.indexOf('nook.') === 0 && typeof kept[name] === 'string') localStorage.setItem(name, kept[name])
        }
        localStorage.setItem(DONE, 'done')
        history.replaceState(null, '', path + (saved.hash || ''))
        location.reload()
      })
      .catch(goOn)
  }

  var hash = location.hash
  if (hash.indexOf('#moved=') === 0) return arrive(hash.slice(7))

  try {
    // Once per browser, ever: an account here, or a trip that came back, means there is nothing to fetch.
    // A trip that never came back, as on a network that failed, is made again, a few times at most.
    var tries = Number((/^tried:(\d+)$/.exec(localStorage.getItem(DONE) || '') || [])[1] || 0)
    if (hasAccount() || localStorage.getItem(DONE) === 'done' || tries >= MOST_TRIES || !window.crypto || !crypto.subtle) return
    localStorage.setItem(DONE, 'tried:' + (tries + 1))
  } catch (e) {
    return
  }
  hold()
  setTimeout(function () {
    release()
  }, LEAVE_WAIT_MS)
  crypto.subtle
    .generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    .then(function (pair) {
      return Promise.all([crypto.subtle.exportKey('raw', pair.publicKey), crypto.subtle.exportKey('jwk', pair.privateKey)])
    })
    .then(function (keys) {
      sessionStorage.setItem(STATE, JSON.stringify({ jwk: keys[1], hash: hash, at: Date.now() }))
      location.replace(site('www.cathode.video') + 'move.html#to=' + b64u(new Uint8Array(keys[0])))
    })
    .catch(function () {
      release()
    })
})()
