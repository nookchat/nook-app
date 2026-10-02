// On the old home site, cathode.video: hands what Nook kept in this browser to the new one,
// nookchat.app, sealed for the key in the address, which the page there just made and keeps
// to itself. See boot-move.js. With no account here, it says "none".
;(function () {
  var port = location.port ? ':' + location.port : ''
  var home = location.protocol + '//www.nookchat.app' + port + '/'
  /**
   * What goes back rides in the address. Firefox takes about a megabyte there and Chrome two, so
   * it stays far under: past this, the pictures and the GIF stars stay behind (the servers keep
   * them in your sealed settings), and past it still, only what makes the account goes.
   */
  var MOST_CHARS = 200000
  var LEAVE_OUT = ['nook.cover.v1', 'nook.avatar.v1', 'nook.gifstars.v1']
  var ACCOUNT = ['nook.identity.v1', 'nook.name.v1', 'nook.servers.v1', 'nook.own.v1', 'nook.server.v1', 'nook.clusters.v1', 'nook.theme.v1']

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
  var back = function (reply) {
    location.replace(home + '#moved=' + reply)
  }

  var asked = /^#to=([A-Za-z0-9_-]{87})$/.exec(location.hash)
  history.replaceState(null, '', location.pathname)
  if (!asked) return location.replace(home)

  var kept = {}
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var name = localStorage.key(i)
      if (name && name.indexOf('nook.') === 0) kept[name] = localStorage.getItem(name)
    }
  } catch (e) {
    return back('none')
  }
  var name = kept['nook.name.v1'] || ''
  if (!/^[0-9a-f]{64}$/.test(kept['nook.identity.v1'] || '') || !name || name === kept['nook.name.auto.v1']) return back('none')
  var text = JSON.stringify(kept)
  for (var j = 0; j < LEAVE_OUT.length && text.length > MOST_CHARS; j++) {
    delete kept[LEAVE_OUT[j]]
    text = JSON.stringify(kept)
  }
  if (text.length > MOST_CHARS) {
    var least = {}
    for (var k = 0; k < ACCOUNT.length; k++) if (typeof kept[ACCOUNT[k]] === 'string') least[ACCOUNT[k]] = kept[ACCOUNT[k]]
    text = JSON.stringify(least)
    if (text.length > MOST_CHARS) return back('none')
  }

  var subtle = crypto.subtle
  var curve = { name: 'ECDH', namedCurve: 'P-256' }
  var mine = null
  Promise.all([subtle.importKey('raw', unb64u(asked[1]), curve, false, []), subtle.generateKey(curve, true, ['deriveBits'])])
    .then(function (keys) {
      mine = keys[1]
      return subtle.deriveBits({ name: 'ECDH', public: keys[0] }, mine.privateKey, 256)
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
        ['encrypt'],
      )
    })
    .then(function (key) {
      var iv = crypto.getRandomValues(new Uint8Array(12))
      return Promise.all([
        subtle.exportKey('raw', mine.publicKey),
        iv,
        subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(text)),
      ])
    })
    .then(function (sealed) {
      back(b64u(new Uint8Array(sealed[0])) + '.' + b64u(sealed[1]) + '.' + b64u(new Uint8Array(sealed[2])))
    })
    .catch(function () {
      back('none')
    })
})()
