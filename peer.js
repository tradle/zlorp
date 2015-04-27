
var rudp = require('rudp')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var bufferEquals = require('buffer-equal')
var debug = require('debug')('peer')
var crypto = require('./crypto')
var START_MSG = new Buffer('__________________________________________________')
var INTERVAL = 10000

function Peer(options) {
  EventEmitter.call(this)
  this.pub = options.pub
  this.priv = options.priv
  this.myIp = options.myIp

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

  this.queue = [START_MSG]
  this.clients = {}
  this.connected = {}
}

inherits(Peer, EventEmitter)

Peer.prototype._watchDHT = function() {
  var self = this
  var me = this.me

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
    self.connect(addr)
  }

  function lookupAndAnnounce() {
    debug('announcing', self.peerInfoHash)
    self.dht.announce(self.peerInfoHash, self.port)
    debug('looking up', self.myInfoHash)
    self.dht.lookup(self.myInfoHash, loop)
  }

  function loop() {
    self._announcer = setTimeout(lookupAndAnnounce, INTERVAL)
  }

  lookupAndAnnounce()
}

Peer.prototype.connect = function(addr) {
  var self = this

  if (this.clients[addr]) return

  if (!this.ready) return this.once('ready', this.connect.bind(this, addr))

  var hp = addr.split(':')
  var host = hp[0]
  var port = Number(hp[1])

  if (this.myIp === host) return

  debug('connecting to', addr)

  var client = this.clients[addr] = new rudp.Client(this.socket, host, port)
  client.on('data', function(msg) {
    try {
      msg = self.decrypt(msg)
    } catch (err) {
      return self.emit('warn', 'Unable to decrypt message', msg)
    }

    if (bufferEquals(msg, START_MSG)) {
      self.connected[addr] = true
      debug('connected to', self.pub, 'at', addr)
      return
    }
    else if (!self.connected[addr]) return

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
