var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var bufferEquals = require('buffer-equal')
var safe = require('safecb')
var once = require('once')
var Client = require('@tradle/talko/lib/messenger')
var OTR = require('@tradle/otr').OTR
var extend = require('xtend/mutable')
var debug = require('debug')('peer')
var utils = require('./utils')
var Relay = require('@tradle/dht-relay')
var ACKbuf = new Buffer('2Wwp1poHvcsgd6PrFbH4+9OIxUs72hNVxyCjzAxzVGA=', 'base64')
var ACK = ACKbuf.toString('base64')
var elistener = require('elistener')
var DEV = process.env.NODE_ENV === 'development'
var OTR_REGEX = /^\?OTR/

module.exports = Peer
// messenger level keep alive
Peer.KEEP_ALIVE_INTERVAL = 20000
// lowel level (utp) timeout
Peer.CONNECTION_TIMEOUT = 20000

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
  this._deliveryTrackers = []
  this.setMaxListeners(0)
  this._debug('new peer')
}

inherits(Peer, EventEmitter)
utils.destroyify(Peer)
elistener(Peer.prototype)

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

    s.filterMessages(function (msg, rinfo) {
      return rinfo.port === self.port &&
        rinfo.address === self.host
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

  client.setTimeout(Peer.CONNECTION_TIMEOUT)
  this.listenOnce(client, 'timeout', function () {
    self._debug('client timed out, destroying')
    self.destroy()
  })

  this.listenTo(client, 'data', function (msg) {
    if (self._destroying) return

    // hacky
    // alternatively filter via client.socket.filterMessages
    if (isOTRMsg(msg)) otr.receiveMsg(msg.toString())
  })

  var cleanup = once(function (event) {
    self._clientClosed = true
    // self._debug('client', event)
    // self.emit('clientclosed')
    if (!self._destroying) {
      return self.emit('disconnected')
    }

    self.destroy()
    // } else {
    //   self.stopListening(client)
    //   self.stopListening(otr)
    //   if (event === 'close') reconnect()
    //   else self.listenOnce(client, 'close', reconnect)
    // }

    // function reconnect () {
    //   self._debug('reconnecting...')
    //   delete self.client
    //   delete self.otr
    //   self.connect() // attempt reconnect
    // }
  })

  ;['close', 'end', 'finish'].forEach(function (event) {
    self.listenOnce(client, event, function () {
      self._debug('client', event)
      cleanup(event)
    })
  })

  var otr = this.otr = new OTR(extend({
    debug: DEV,
    instance_tag: this.instanceTag,
    priv: this.key,
    fragment_size: 200
  }, this.otrOptions || {}))

  // otr.ALLOW_V2 = false
  otr.REQUIRE_ENCRYPTION = true

  self.listenTo(otr, 'ui', onincoming)
  self.listenTo(otr, 'io', onoutgoing)
  self.listenTo(otr, 'error', onerror)
  self.listenTo(otr, 'warn', onwarn)
  self.listenTo(otr, 'status', onstatus)

  // otr.sendQueryMsg()
  // kick things off
  this._keepAlive()

  function onincoming (msg, encrypted, meta) {
    if (self._destroying || self._clientClosed) return
    self._debug('received msg')
    try {
      self._onmessage(utils.toBuffer(msg))
    } catch (err) {
      self._debug('received invalid msg', msg)
    }
  }

  function onoutgoing (msg, meta) {
    if (self._destroying || self._clientClosed) return

    self._debug('sending msg')
    self._deliveryTrackers.push(null) // placeholder
    client.send(new Buffer(msg), self._ondelivered)
    self._keepAlive() // reset keep alive
  }

  function onwarn (warning) {
    self._debug('warn', warning)
    self.emit('warn', warning)
  }

  function onerror (err, severity) {
    if (severity === 'error') {
      self._debug('error', err)
      // self.emit('error', err)
    }
  }

  function onstatus (status) {
    self._debug('otr status', status)
    if (status === OTR.CONST.STATUS_END_OTR) {
      return self.destroy()
    } else {
      self.emit('otrstatus', status)

      if (status !== OTR.CONST.STATUS_AKE_SUCCESS) return
    }

    self._debug('AKE successful')
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
  if (bufferEquals(msg, ACKbuf)) {
    this._debug('got ACK from', this.address)
    return
  }

  this.emit('data', msg)
}

Peer.prototype._keepAlive = function () {
  var self = this

  if (this._destroyed) return

  if (!this._kaTimeoutId) {
    // first time
    keepAlive()
  } else {
    clearTimeout(this._kaTimeoutId)
    loop()
  }

  function keepAlive () {
    // console.log('sending ACK')
    self.send(ACK)
    loop()
  }

  function loop () {
    // we end up encrypting ACK every time, wasteful
    self._kaTimeoutId = setTimeout(keepAlive, Peer.KEEP_ALIVE_INTERVAL)
  }
}

Peer.prototype.send = function (msg, cb) {
  var self = this
  if (this._destroying) {
    this._debug('destroyed, not sending message')
    return
  }

  if (Buffer.isBuffer(msg)) msg = utils.fromBuffer(msg)

  this.otr.sendMsg(msg, function () {
    // we just sent the last piece of this message
    // replace the placeholder we pushed
    // yes, this is ugly
    self._deliveryTrackers[self._deliveryTrackers.length - 1] = cb
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
    self.stopListening(self.otr)
    if (self._clientClosed) {
      onClientClosed()
    } else {
      // self.once('clientclosed', onClientClosed)
      self.listenOnce(self.client, 'close', onClientClosed)
      self.client.end()
    }
  })

  function onClientClosed () {
    self._debug('closed Client')
    self.stopListening(self.client)
    delete self._sockets
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

function isOTRMsg (msg) {
  return OTR_REGEX.test(msg)
}
