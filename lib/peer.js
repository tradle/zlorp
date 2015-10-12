var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var bufferEquals = require('buffer-equal')
var safe = require('safecb')
var Client = require('talko/lib/messenger')
var OTR = require('otr').OTR
var extend = require('xtend/mutable')
var debug = require('debug')('peer')
var utils = require('./utils')
var Relay = require('dht-relay')
// var ACKbuf = new Buffer('__________________________________________________')
// var ACK = ACKbuf.toString('base64')

var KEEP_ALIVE_INTERVAL = 100000
var OTR_EVENTS = ['status', 'ui', 'io', 'error']
var DEV = process.env.NODE_ENV === 'development'

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
  return (this.localPort || '[unknown]') + ' -> ' + this.address
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
  this._sockets = [0, 1].map(function () {
    var s = dgram.createSocket('udp4')
    if (self.relay) {
      s = Relay.createClient(s, self.relay)
    }

    s.filterMessages(function (msg) {
      return !/^d1:.?d2:id20:/.test(msg)
    })

    s.setMaxListeners(0)
    s.bind(self.localPort)
    return s
  })

  var client = this.client = new Client({
    clientSocket: this._sockets[0],
    serverSocket: this._sockets[1],
    port: this.port,
    host: this.host
  })

  var otr = this.otr = new OTR(extend({
    debug: DEV,
    instance_tag: this.instanceTag,
    priv: this.key,
    fragment_size: 200
  }, this.otrOptions || {}))

  otr.ALLOW_V2 = false
  otr.ALLOW_V2 = true
  otr.REQUIRE_ENCRYPTION = true

  otr.on('ui', onincoming)
  otr.on('io', onoutgoing)
  otr.on('error', onerror)
  otr.on('warn', onwarn)
  otr.on('status', onstatus)

  client.on('data', function (msg) {
    if (self._destroying) return

    // hacky
    // alternatively filter via client.socket.filterMessages
    if (/^\?OTR/.test(msg)) otr.receiveMsg(msg.toString())
  })

  var cleanup = safe(function (event) {
    self._clientClosed = true
    self._debug('client was closed')
    self.destroy()
  })

  ;['close', 'end', 'finish'].forEach(function (event) {
    client.once(event, cleanup)
  })

  // kick things off
  otr.sendQueryMsg()
  // this._keepAlive()

  function onincoming (msg, encrypted, meta) {
    if (self._destroying) return
    self._debug('received', msg)
    self._onmessage(utils.toBuffer(msg))
  }

  function onoutgoing (msg, meta) {
    if (self._destroying) return

    self._debug('sending', msg, 'to', self.address)
    client.send(new Buffer(msg), self._ondelivered)
    // self._keepAlive() // reset keep alive
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
  // if (bufferEquals(msg, ACKbuf)) {
  //   this._debug('got ACK from', this.address)
  //   return
  // }

  this.emit('data', msg)
}

// Peer.prototype._keepAlive = function () {
//   var self = this

//   clearTimeout(this._kaTimeoutId)
//   if (this._destroyed || this._kaTimeoutId || !this.client) return

//   if ('_kaTimeoutId' in this) loop()
//   else keepAlive()

//   function keepAlive () {
//     self.send(ACK)
//     loop()
//   }

//   function loop () {
//     // we end up encrypting ACK every time, wasteful
//     self._kaTimeoutId = setTimeout(keepAlive, KEEP_ALIVE_INTERVAL)
//   }
// }

Peer.prototype.send = function (msg, cb) {
  var self = this
  if (this._destroying) return

  if (Buffer.isBuffer(msg)) msg = utils.fromBuffer(msg)

  // normalize to array
  this.otr.sendMsg(msg, function () {
    // push placeholder even if no callback
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
    if (self._clientClosed) {
      onClientClosed()
    } else {
      self.client.end()
      self.client.once('close', onClientClosed)
    }
  })

  function onClientClosed () {
    self._debug('closed Client')
    self.client.removeAllListeners()
    delete self.client
    delete self.otr
    delete self.queue
    cb()
  }
}

function bindFns (obj) {
  var proto = obj.constructor.prototype
  Object.keys(proto).forEach(function (p) {
    if (typeof proto[p] === 'function') {
      obj[p] = obj[p].bind(obj)
    }
  })
}
