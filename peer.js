
var rudp = require('rudp')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var debug = require('debug')('peer')
var crypto = require('./crypto')
var INTERVAL = 10000

function Peer(options) {
  EventEmitter.call(this)
  this.pub = options.pub
  this.priv = options.priv

  var myPub = this.priv.getPublic(true, 'hex')
  this.myInfoHash = crypto.toInfoHash(myPub)
  this.peerInfoHash = crypto.toInfoHash(this.pub)
  // this.me = {
  //   forward: crypto.toInfoHash(myPub),
  //   reverse: crypto.toRendezvousInfoHash(myPub)
  // }

  // this.peer = {
  //   forward: crypto.toInfoHash(this.pub),
  //   reverse: crypto.toRendezvousInfoHash(this.pub)
  // }

  this.socket = options.socket
  this.port = this.socket.address().port
  this.dht = options.dht

  if (this.dht.ready) this._watchDHT()
  else this.dht.once('ready', this._watchDHT.bind(this))

  this._queue = []
}

inherits(Peer, EventEmitter)

Peer.prototype._watchDHT = function() {
  var self = this
  var me = this.me

  ;(function announce() {
    self._announcer = setTimeout(function() {
      // debug('announcing', me.forward)
      debug('announcing', self.myInfoHash)
      self.dht.announce(self.myInfoHash, self.port, announce)
      // self.dht.announce(me.forward, self.port, announce)
      // self.dht.announce(peer.reverse, self.port)
    }, INTERVAL)
  })()

  ;(function lookup() {
    self._monitor = setTimeout(function() {
      // debug('looking for peers for', me.reverse)
      // self.dht.lookup(me.reverse, lookup)
      debug('looking up', self.myInfoHash, self.peerInfoHash)
      self.dht.lookup(self.myInfoHash, lookup)
      self.dht.lookup(self.peerInfoHash)
    }, INTERVAL)
  })()

  this.dht.on('announce', function(addr, infoHash, from) {
    if (infoHash === self.peerInfoHash) {
      debug('got peer\'s announce', addr)
      connect(addr)
    }
  })

  // this.dht.on('peer:' + me.reverse, connect)
  this.dht.on('peer:' + this.myInfoHash, connect)

  this.ready = true
  this.emit('ready')

  function connect(addr) {
    debug('connecting to', addr)
    addr = addr.split(':')
    self.connect(addr[0], addr[1])
  }
}

Peer.prototype.connect = function(host, port) {
  var self = this

  if (this.client) return

  if (!this.ready) return this.once('ready', this.connect.bind(this, host, port))

  this._connected = true
  this.client = new rudp.Client(this.socket, host, port)
  this.client.on('data', function(msg) {
    try {
      msg = self.decrypt(msg)
      self.emit('data', msg)
    } catch (err) {
      self.emit('warn', 'Unable to decrypt message', msg)
    }
  })

  if (this._queue.length) {
    this._queue.forEach(this.send, this)
  }
}

Peer.prototype.send = function(msg) {
  if (!this._connected) return this._queue.push(msg)

  msg = this.encrypt(msg)
  this.client.send(msg)
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
