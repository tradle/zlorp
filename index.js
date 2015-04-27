
var fs = require('fs')
var dgram = require('dgram')
var rudp = require('rudp')
var inherits = require('util').inherits
var crypto = require('crypto')
var myCrypto = require('./crypto')
var ec = myCrypto.ec
var Peer = require('./peer')
var DHT = require('./dht')
// var Identity = require('midentity').Identity
var EventEmitter = require('events').EventEmitter
var DHT_KEY_TYPE = 'encrypt'
var INTERVAL = 10000

function Node(options) {
  var self = this

  options = options || {}

  this._port = options.port
  this._priv = options.priv
  this._key = ec.keyFromPrivate(this._priv)
  this._pubKey = this._key.getPublic(true, 'hex')
  // this._me = options.identity
  // this._myPubKey = this._me.keys({
  //   type: 'ec',
  //   purpose: DHT_KEY_TYPE
  // })[0].pubKeyString()

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

  this._dht.on('ready', this.emit.bind(this, 'ready'))
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

Node.prototype.addPeer = function(pubKey) {
  var self = this

  if (this.getPeer(pubKey)) return

  this._peers[pubKey] = new Peer({
    priv: this._key,
    pub: pubKey,
    dht: this._dht,
    socket: this._socket
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
