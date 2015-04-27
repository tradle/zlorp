
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var rudp = require('rudp')
var bufferEquals = require('buffer-equal')
var extend = require('extend')
var debug = require('debug')('peer')
var crypto = require('./crypto')
var START_MSG = new Buffer('__________________________________________________')
var INTERVAL = 10000
var reqd = ['pub', 'myKey', 'socket', 'dht']
var optional = ['myIp', 'name']

/**
 * A connection with whoever can prove ownership of a pubKey
 * @param {[type]} options [description]
 */
function Peer(options) {
  EventEmitter.call(this)

  reqd.forEach(function(prop) {
    assert(prop in options, 'Missing required property: ' + prop)
  })

  extend(this, options)

  var myPub = this.myKey.getPublic(true, 'hex')
  this.myInfoHash = crypto.toInfoHash(myPub)
  this.peerInfoHash = crypto.toInfoHash(this.pub)
  this.port = this.socket.address().port

  if (this.dht.ready) this._watchDHT()
  else this.dht.once('ready', this._watchDHT.bind(this))

  this.queue = [START_MSG]
  this.clients = {}
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
    self._announcer = setTimeout(lookupAndAnnounce, INTERVAL)
  }
}

Peer.prototype._debug = function() {
  var args = [].slice.call(arguments)
  var me = this.name || this.pubKey.slice(0, 5)
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

    if (bufferEquals(msg, START_MSG)) {
      self._debug('got START_MSG from', self.pub, 'at', addr)
      return
    }

    self.emit('data', msg)
  })

  this.queue.forEach(this.send, this)
}

Peer.prototype.send = function(msg) {
  this.queue.push(msg)
  if (!Object.keys(this.clients).length) return

  msg = this.encrypt(msg)
  for (var addr in this.clients) {
    this.clients[addr].send(msg)
  }
}

Peer.prototype.encrypt = function(msg) {
  return crypto.encryptMessage(msg, this.pub, this.priv)
}

Peer.prototype.decrypt = function(msg) {
  return crypto.decryptMessage(msg, this.pub, this.priv)
}

Peer.prototype.destroy = function() {
  // this.client.close() // don't close client, because that will close the socket
  clearInterval(this._monitor)
  clearInterval(this._announcer)
}

module.exports = Peer
