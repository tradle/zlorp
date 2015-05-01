
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var rudp = require('rudp')
var otrlib = require('otr')
var OTR = otrlib.OTR
var bufferEquals = require('buffer-equal')
var extend = require('extend')
var debug = require('debug')('peer')
var crypto = require('./crypto')
var utils = require('./utils')
var ACK = utils.toBuffer('__________________________________________________')
var KEEP_ALIVE_INTERVAL = 10000
var DEFAULT_OTR_SETTINGS = {
  fragment_size: 140,
  send_interval: 200
}

var OTR_EVENTS = ['status', 'ui', 'io', 'error']

/**
 * A connection with whoever can prove ownership of a pubKey
 * @param {[type]} options [description]
 */
function Peer(options) {
  var self = this
  EventEmitter.call(this)

  extend(this, options)
  var addr = this.address
  var hp = addr.split(':')
  this.host = hp[0]
  this.port = Number(hp[1])
}

inherits(Peer, EventEmitter)
utils.destroyify(Peer)

Peer.prototype._debug = function() {
  var args = [].slice.call(arguments)
  var me = this.name() || this.address
  args.unshift(me)
  debug.apply(null, args)
}

Peer.prototype.name = function(val) {
  var current = this._name
  if (typeof val !== 'undefined') this._name = val

  return current
}

Peer.prototype.connect = function() {
  var self = this

  if (this.client) return

  this._debug('connecting to', this.address)

  var addr = this.address
  var client = this.client = new rudp.Client(this.socket, this.host, this.port)
  var otr = this.otr = new OTR({
    priv: this.key,
    fragment_size: 300,
    send_interval: 200
  })

  client.id = this.id
  otr.id = this.id

  otr.REQUIRE_ENCRYPTION = true
  otr.on('ui', onincoming)
  otr.on('io', onoutgoing)
  otr.on('error', onerror)
  otr.on('status', onstatus)

  client.on('data', function(msg) {
    otr.receiveMsg(utils.fromBuffer(msg))
  })

  this._keepAlive(addr)

  function onincoming(msg, encrypted, meta) {
    if (self._destroying) return
    self._debug('received', msg)
    self._onmessage(utils.toBuffer(msg))
  }

  function onoutgoing(msg, meta) {
    if (self._destroying) return
    self._debug('sending', msg)
    client.send(utils.toBuffer(msg)) //, meta)
  }

  function onerror(err, severity) {
    if (severity === 'error') {
      self.emit('error', err)
    }
  }

  function onstatus(status) {
    if (status === OTR.CONST.STATUS_END_OTR) {
      self.destroy()
    }
    else {
      self.emit('otrstatus', status)

      if (status !== OTR.CONST.STATUS_AKE_SUCCESS) return
    }

    self.pubKey = otr.their_priv_pk
    self.fingerprint = self.pubKey.fingerprint()
    self._resolved = true
    self.emit('resolved', addr, self.pubKey)
  }
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

Peer.prototype._onmessage = function(msg) {
  if (bufferEquals(msg, ACK)) {
    this._debug('got ACK from', this.address)
    return
  }

  this.emit('data', msg)
}

Peer.prototype._keepAlive = function() {
  var self = this

  if (this._destroyed || this._kaTimeoutId || !this.client) return

  // we end up encrypting ACK every time, wasteful
  // this._kaTimeoutId = setInterval(keepAlive, KEEP_ALIVE_INTERVAL)

  keepAlive()

  function keepAlive() {
    self.send(ACK, self.address)
  }
}

Peer.prototype.send = function(msg) {
  if (this._destroying) return

  if (Buffer.isBuffer(msg)) msg = utils.fromBuffer(msg)

  // normalize to array
  this.otr.sendMsg(msg)
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

Peer.prototype._destroy = function(cb) {
  var self = this

  clearTimeout(this._kaTimeoutId)

  var otr = this.otr
  OTR_EVENTS.forEach(otr.removeEvent, otr)
  otr.endOtr(function() {
    self._debug('ended OTR')
    self.client.close(function(err) {
      if (err) debugger

      self._debug('closed Client')
      delete self.client
      delete self.otr
      delete self.queue
      cb()
    })
  })
}

module.exports = Peer
