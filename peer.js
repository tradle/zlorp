
var rudp = require('rudp')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var crypto = require('./crypto')
var INTERVAL = 10000

function Peer(options) {
  EventEmitter.call(this)
  this.pub = options.pub
  this.priv = options.priv
  this.socket = options.socket
  this.port = this.socket.address().port
  this.dht = options.dht
  this.infoHash = crypto.toInfoHash(this.pub)
  this.rInfoHash = crypto.toRendezvousInfoHash(this.pub)

  if (this.dht.ready) this._watchDHT()
  else this.dht.once('ready', this._watchDHT.bind(this))

  this._queue = []
}

inherits(Peer, EventEmitter)

Peer.prototype._watchDHT = function() {
  var self = this

  this._announcer = setInterval(function() {
    self.dht.announce(self.infoHash, self.port)
  }, INTERVAL)

  this._monitor = setInterval(function() {
    self.dht.lookup(self.rInfoHash)
  }, INTERVAL)

  this.dht.on('peer:' + this.rInfoHash, function(addr, from) {
    addr = addr.split(':')
    self.connect(addr[0], addr[1])
  })

  this.ready = true
  this.emit('ready')
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
