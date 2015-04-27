
var fs = require('fs')
var dgram = require('dgram')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var rudp = require('rudp')
var crypto = require('./lib/crypto')
var ec = crypto.ec
var Peer = require('./lib/peer')
var DHT = require('./lib/dht')
var externalIp = require('./lib/externalIp')
// var Identity = require('midentity').Identity
var DHT_KEY_TYPE = 'encrypt'
var INTERVAL = 10000

function Node(options) {
  var self = this

  options = options || {}

  this._port = options.port
  this._priv = options.priv
  this._key = ec.keyFromPrivate(this._priv)
  this._pubKey = this._key.getPublic(true, 'hex')

  externalIp(function(err, ip) {
    self._ipDone = true
    self.ip = ip
    self._checkReady()
  })

  this._loadDHT(options.dht)
  this._socket = dgram.createSocket('udp4')
  this._socket.bind(this._port)
  this._peers = {}
  this._announcing = null
}

inherits(Node, EventEmitter)

Node.prototype._loadDHT = function(dht) {
  if (this._dht) throw new Error('already hooked up to DHT')

  if (dht) {
    if (typeof dht === 'string') {
      this._dhtPath = dht
      if (fs.existsSync(dht)) {
        this._dht = new DHT({
          bootstrap: require(dht)
        })
      }
    }
    else {
      this._dht = dht
    }
  }

  if (!this._dht) this._dht = new DHT()

  this._dht.setMaxListeners(500)
  this._dht.once('ready', this._checkReady.bind(this))
}

Node.prototype._checkReady = function() {
  if (!(this._dht.ready && this._ipDone)) return

  this.ready = true
  this.emit('ready')
}

Node.prototype.send = function(msg, toPubKey) {
  var self = this
  // var key = to.keys({ purpose: DHT_KEY_TYPE })[0].pubKeyString()
  this.addPeer(toPubKey)
  this.getPeer(toPubKey).send(msg)
}

Node.prototype.getPeer = function(pubKey) {
  return this._peers[pubKey]
}

Node.prototype.removePeer = function(pubKey) {
  var peer = this._peers[pubKey]
  if (peer) {
    peer.destroy()
    delete this._peers[pubKey]
    return true
  }
}

Node.prototype.addPeer = function(pubKey, name) {
  var self = this

  if (!this.ready) return this.once('ready', this.addPeer.bind(this, pubKey))

  if (this.getPeer(pubKey)) return

  var peer = this._peers[pubKey] = new Peer({
    myKey: this._key,
    pub: pubKey,
    dht: this._dht,
    socket: this._socket,
    myIp: this.ip,
    name: name
  })

  peer.on('data', function(data) {
    self.emit('data', data, pubKey)
  })
}

Node.prototype.destroy = function(cb) {
  var self = this
  if (this._destroyed) return process.nextTick(cb)

  this.once('destroy', cb)
  cb = this.emit.bind(this, 'destroy')
  if (this._destroying) return

  this._destroying = true

  for (var pubKey in this._peers) {
    this._peers[pubKey].destroy() // synchronous
  }

  this._dht.removeAllListeners()
  this._socket.close()

  if (this._dhtPath) {
    fs.writeFile(this._dhtPath, JSON.stringify(this._dht.toArray()), cb)
  }
  else {
    process.nextTick(cb)
  }

  return this
}

module.exports = Node
