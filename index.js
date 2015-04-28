
var fs = require('fs')
var dgram = require('dgram')
var assert = require('assert')
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
  var keys = options.keys
  this.port = options.port

  assert(typeof this.port === 'number', 'Missing required parameter: port')
  assert(keys.dsa || keys.ec, 'need a private key, EC or DSA')

  this.keys = {
    ec: {
      priv: keys.ec
    },
    dsa: {
      priv: keys.dsa
    }
  }

  this._useDSA = !!keys.dsa
  if (this._useDSA) {
    this.identifier = this.keys.dsa.fingerprint = keys.dsa.fingerprint()
  }
  else {
    this.identifier = this.keys.ec.pub = keys.ec.getPublic(true, 'hex')
  }

  externalIp(function(err, ip) {
    self._ipDone = true
    self.ip = ip
    self._checkReady()
  })

  this._loadDHT(options.dht)
  this._socket = dgram.createSocket('udp4')
  this._socket.bind(this.port)
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

/**
 * Send a message to a peer
 * @param  {String|Buffer} msg
 * @param  {String} to - peer's pubKey or fingerprint
 */
Node.prototype.send = function(msg, to) {
  if (!this.getPeer(to)) this.addPeer(to)

  this.getPeer(to).send(msg)
}

Node.prototype.getPeer = function(identifier) {
  return this._peers[identifier]
}

Node.prototype.removePeer = function(identifier) {
  var peer = this._peers[identifier]
  if (peer) {
    peer.destroy()
    delete this._peers[identifier]
    return true
  }
}

Node.prototype.addPeer = function(identifier, name) {
  var self = this

  if (!this.ready) return this.once('ready', this.addPeer.bind(this, identifier))

  if (this.getPeer(identifier)) return

  var peer = this._peers[identifier] = new Peer({
    identifiers: {
      self: this.identifier,
      peer: identifier
    },
    keys: this.keys,
    dht: this._dht,
    socket: this._socket,
    myIp: this.ip,
    name: name
  })

  peer.on('data', function(data) {
    self.emit('data', data, identifier)
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
