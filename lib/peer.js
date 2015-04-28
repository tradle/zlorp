
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var rudp = require('rudp')
var otrlib = require('otr')
var OTR = otrlib.OTR
var DSA = otrlib.DSA
var bufferEquals = require('buffer-equal')
var extend = require('extend')
var debug = require('debug')('peer')
var crypto = require('./crypto')
var ACK = new Buffer('__________________________________________________')
var LOOKUP_ANNOUNCE_INTERVAL = 10000
var KEEP_ALIVE_INTERVAL = 10000
var DEFAULT_OTR_SETTINGS = {
  fragment_size: 140,
  send_interval: 200
}

var required = ['socket', 'dht']
var optional = ['myIp', 'name']

/**
 * A connection with whoever can prove ownership of a pubKey
 * @param {[type]} options [description]
 */
function Peer(options) {
  EventEmitter.call(this)

  required.forEach(function(prop) {
    assert(prop in options, 'Missing required property: ' + prop)
  })

  extend(this, options)

  this._useDSA = !!this.keys.dsa.priv
  this.myInfoHash = crypto.toInfoHash(this.identifiers.self)
  this.peerInfoHash = crypto.toInfoHash(this.identifiers.peer)
  this.port = this.socket.address().port

  if (this.dht.ready) this._watchDHT()
  else this.dht.once('ready', this._watchDHT.bind(this))

  this.queue = []
  this.clients = {}
  this.otrs = {}
  this.connected = {}
  this.blacklist = {}
}

inherits(Peer, EventEmitter)

Peer.prototype._watchDHT = function() {
  var self = this

  this.dht.on('announce', function(addr, infoHash, from) {
    if (infoHash === self.peerInfoHash) {
      self._debug('got peer\'s announce', addr)
      connect(addr)
    }
  })

  this.dht.on('peer:' + this.myInfoHash, connect)

  this.ready = true
  this.emit('ready')
  lookupAndAnnounce()

  function connect(addr) {
    self.connect(addr)
  }

  function lookupAndAnnounce() {
    self.dht.announce(self.peerInfoHash, self.port)
    self.dht.lookup(self.myInfoHash, loop)
  }

  function loop() {
    self._announcer = setTimeout(lookupAndAnnounce, LOOKUP_ANNOUNCE_INTERVAL)
  }
}

Peer.prototype._debug = function() {
  var args = [].slice.call(arguments)
  var me = this.name || this.pub.slice(0, 5)
  args.unshift(me)
  debug.apply(null, args)
}

Peer.prototype.connect = function(addr) {
  var self = this

  if (this.clients[addr] || this.blacklist[addr]) return

  if (!this.ready) return this.once('ready', this.connect.bind(this, addr))

  var hp = addr.split(':')
  var host = hp[0]
  var port = Number(hp[1])

  if (this.myIp === host) return

  this._debug('connecting to', addr)

  var client = this.clients[addr] = new rudp.Client(this.socket, host, port)
  if (this._useDSA) {
    this._hookupOTRPeer(addr, client)
  }
  else {
    this._hookupECPeer(addr, client)
  }

  this._keepAlive(addr)
  this.queue.forEach(this.send, this)
}

Peer.prototype._hookupOTRPeer = function(addr) {
  var self = this
  var client = this.clients[addr]
  var otr = this.otrs[addr] = new OTR(extend({
    priv: this.keys.dsa.priv,
  }, DEFAULT_OTR_SETTINGS))

  otr.REQUIRE_ENCRYPTION = true
  otr.on('ui', function(msg, encrypted, meta) {
    debugger;
    self.emit('data', msg, meta)
  })

  otr.on('io', function(msg, meta) {
    debugger;
    client.send(new Buffer(msg)) //, meta)
  })

  otr.on('error', function(err, severity) {
    if (severity === 'error') {
      self.blacklist[addr] = true
      delete self.clients[addr]
      delete self.otrs[addr]
    }
  })

  client.on('data', function(msg) {
    debugger;
    otr.receiveMsg(msg.toString())
  })
}

Peer.prototype._handleOTR = function(addr, msg) {
  this.otr.receiveMsg(msg)
}

Peer.prototype._hookupECPeer = function(addr, client) {
  var self = this

  client.on('data', function(msg) {
    try {
      msg = self.decrypt(msg)
    } catch (err) {
      self._debug('Unable to decrypt message, blacklisting')
      self.blacklist[addr] = true
      delete self.clients[addr]
      return self.emit('warn', 'Unable to decrypt message, blacklisting ' + addr, msg)
    }

    if (!self.connected[addr]) {
      self._debug('connected to', self.pub, 'at', addr)
      self.connected[addr] = true
    }

    if (bufferEquals(msg, ACK)) {
      self._debug('got ACK from', self.name || self.pub, 'at', addr)
      return
    }

    self.emit('data', msg)
  })
}

Peer.prototype._keepAlive = function(addr) {
  if (this._useDSA) return

  if (!this.clients[addr]) return

  // we end up encrypting ACK every time, wasteful
  this.send(ACK, addr)
  setTimeout(this._keepAlive.bind(this), KEEP_ALIVE_INTERVAL)
}

Peer.prototype.send = function(msg, addr) {
  if (this._useDSA) this._sendDSA(msg, addr)
  else this._sendEC(msg, addr)
}

Peer.prototype._sendDSA = function(msg, addrs) {
  this.queue.push(msg)

  // normalize to array
  addrs = addrs ? [].concat.apply([], [addrs]) : Object.keys(this.otrs)
  addrs.forEach(function(addr) {
    this.otrs[addr].sendMsg(msg)
  }, this)
}

Peer.prototype._sendEC = function(msg, addrs) {
  if (msg !== ACK) this.queue.push(msg)

  addrs = addrs ? [].concat.apply([], [addrs]) : Object.keys(this.clients)
  if (!addrs.length) return

  msg = this.encrypt(msg)
  addrs.forEach(function(addr) {
    this.clients[addr].send(msg)
  }, this)
}

;['encrypt', 'decrypt'].forEach(function(method) {
  Peer.prototype[method] = function(msg) {
    return crypto[method](msg, this.identifiers.peer, this.keys.ec.priv)
  }
})

Peer.prototype.destroy = function() {
  // this.client.close() // don't close client, because that will close the socket
  delete this.clients
  delete this.queue
  clearInterval(this._monitor)
  clearInterval(this._announcer)
}

module.exports = Peer
