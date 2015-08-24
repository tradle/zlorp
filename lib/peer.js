var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var safe = require('safecb')
var rudp = require('rudp')
var OTR = require('otr').OTR
var bufferEquals = require('buffer-equal')
var extend = require('extend')
var debug = require('debug')('peer')
var utils = require('./utils')
var ACK = utils.toBuffer('__________________________________________________')
var KEEP_ALIVE_INTERVAL = 10000
var OTR_EVENTS = ['status', 'ui', 'io', 'error']

module.exports = Peer

/**
 * A connection with whoever can prove ownership of a pubKey
 * @param {[type]} options [description]
 */
function Peer (options) {
  EventEmitter.call(this)
  bindFns(this)

  extend(this, options)
  var addr = this.address
  var hp = addr.split(':')
  this.host = hp[0]
  this.port = Number(hp[1])
  this.id = Peer.NUM_INSTANCES++
  this._deliveryTrackers = []
}

Peer.NUM_INSTANCES = 0
inherits(Peer, EventEmitter)
utils.destroyify(Peer)

Peer.prototype._debug = function () {
  var args = [].slice.call(arguments)
  var me = this.name() || this._dir()
  args.unshift(me)
  debug.apply(null, args)
}

Peer.prototype._dir = function () {
  var from
  try {
    from = this.socket.address().port
  } catch (err) {
  }

  return (from || '[unknown]') + ' -> ' + this.address
}

Peer.prototype.name = function (val) {
  var current = this._name
  if (typeof val !== 'undefined') this._name = val

  return current
}

Peer.prototype.connect = function () {
  var self = this

  if (this._destroying || this.client) return

  this._debug('connecting to', this.address)

  var addr = this.address
  var client = this.client = new rudp.Client(this.socket, this.host, this.port)
  var otr = this.otr = new OTR({
    instance_tag: this.instanceTag,
    priv: this.key,
    fragment_size: 300,
    send_interval: 200
  })

  client.id = this.id

  otr.REQUIRE_ENCRYPTION = true
  otr.on('ui', onincoming)
  otr.on('io', onoutgoing)
  otr.on('error', onerror)
  otr.on('warn', onwarn)
  otr.on('status', onstatus)

  client.on('data', function (msg) {
    if (self._destroying) return

    if (/^\?OTR/.test(msg)) otr.receiveMsg(utils.fromBuffer(msg))
  })

  client.once('close', function () {
    self.destroy()
  })

  this._keepAlive(addr)

  function onincoming (msg, encrypted, meta) {
    if (self._destroying) return
    self._debug('received', msg)
    self._onmessage(utils.toBuffer(msg))
  }

  function onoutgoing (msg, meta) {
    if (self._destroying) return

    self._debug('sending', msg, 'to', self.address)
    client.send(utils.toBuffer(msg), self._ondelivered)
    self._keepAlive() // reset keep alive
  }

  function onwarn (warning) {
    self._debug('warn', warning)
    self.emit('warn', warning)
  }

  function onerror (err, severity) {
    if (severity === 'error') {
      self._debug('error', err)
      self.emit('error', err)
    }
  }

  function onstatus (status) {
    if (status === OTR.CONST.STATUS_END_OTR) {
      return self.destroy()
    } else {
      self.emit('otrstatus', status)

      if (status !== OTR.CONST.STATUS_AKE_SUCCESS) return
    }

    self.pubKey = otr.their_priv_pk
    self.fingerprint = self.pubKey.fingerprint()
    self._resolved = true
    self.emit('resolved', addr, self.pubKey)
  }
}

Peer.prototype._ondelivered = function () {
  var cb = this._deliveryTrackers.shift()
  if (cb) cb()
}

// Peer.prototype._hookupECPeer = function(addr, client) {
//   var self = this

//   client.on('data', function(msg) {
//     try {
//       msg = self.decrypt(msg)
//     } catch (err) {
//       self._debug('Unable to decrypt message, blacklisting')
//       self.blacklist[addr] = true
//       delete self.clients[addr]
//       return self.emit('warn', 'Unable to decrypt message, blacklisting ' + addr, msg)
//     }

//     self._onmessage(msg, addr)
//   })
// }

Peer.prototype._onmessage = function (msg) {
  if (bufferEquals(msg, ACK)) {
    this._debug('got ACK from', this.address)
    return
  }

  this.emit('data', msg)
}

Peer.prototype._keepAlive = function () {
  var self = this

  clearTimeout(this._kaTimeoutId)
  if (this._destroyed || this._kaTimeoutId || !this.client) return

  if ('_kaTimeoutId' in this) loop()
  else keepAlive()

  function keepAlive () {
    self.send(ACK)
    loop()
  }

  function loop () {
    // we end up encrypting ACK every time, wasteful
    self._kaTimeoutId = setTimeout(keepAlive, KEEP_ALIVE_INTERVAL)
  }
}

Peer.prototype.send = function (msg, cb) {
  var self = this
  if (this._destroying) return

  if (Buffer.isBuffer(msg)) msg = utils.fromBuffer(msg)

  // normalize to array
  this.otr.sendMsg(msg, function () {
    self._deliveryTrackers.push(cb)
  })
}

// Peer.prototype._sendEC = function(msg, addrs) {
//   if (msg !== ACK) this.queue.push(msg)

//   addrs = addrs ? [].concat.apply([], [addrs]) : Object.keys(this.clients)
//   if (!addrs.length) return

//   msg = this.encrypt(msg)
//   addrs.forEach(function(addr) {
//     this.clients[addr].send(msg)
//   }, this)
// }

// ;['encrypt', 'decrypt'].forEach(function(method) {
//   Peer.prototype[method] = function(msg) {
//     return crypto[method](msg, this.identifiers.peer, this.keys.ec.priv)
//   }
// })

Peer.prototype._destroy = function (cb) {
  var self = this
  cb = safe(cb)

  this._debug('destroying')

  clearTimeout(this._kaTimeoutId)

  var otr = this.otr
  if (!otr) return cb()

  otr.endOtr(function () {
    self._debug('ended OTR')
    OTR_EVENTS.forEach(otr.removeAllListeners, otr)
    self.client.close(function (err) {
      if (err) self._debug('failed to close client')
      else self._debug('closed Client')

      self.client.removeAllListeners()
      delete self.client
      delete self.otr
      delete self.queue
      cb()
    })
  })
}

function bindFns (obj) {
  var proto = obj.constructor.prototype
  Object.keys(proto).forEach(function (p) {
    if (typeof proto[p] === 'function') {
      obj[p] = obj[p].bind(obj)
    }
  })
}
