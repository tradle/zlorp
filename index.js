
var fs = require('fs')
var dgram = require('dgram')
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var rudp = require('rudp')
var crypto = require('./lib/crypto')
var destroyify = require('./lib/destroyify')
var ec = crypto.ec
var Peer = require('./lib/peer')
var DHT = require('./lib/dht')
var externalIp = require('./lib/externalIp')
var noop = function() {}
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

  this._keys = {
    ec: {
      priv: keys.ec
    },
    dsa: {
      priv: keys.dsa
    }
  }

  this._useDSA = !!keys.dsa
  if (this._useDSA) {
    this._identifier = this._keys.dsa.fingerprint = keys.dsa.fingerprint()
  }
  else {
    this._identifier = this._keys.ec.pub = keys.ec.getPublic(true, 'hex')
  }

  if (options.externalIp) onExternalIp(null, options.externalIp)
  else  externalIp(onExternalIp)

  this._loadDHT(options.dht)
  this._socket = dgram.createSocket('udp4')
  this._socket.bind(this.port, function() {
    self._socketReady = true
    self._checkReady()
  })

  this._peers = {}
  this._announcing = null

  function onExternalIp(err, ip) {
    self._ipDone = true
    self.ip = ip
    self._checkReady()
  }
}

inherits(Node, EventEmitter)
destroyify(Node)

Node.prototype.identifier = function() {
  return this._identifier
}

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
  if (!(this._socketReady && this._dht.ready && this._ipDone)) return

  this.ready = true
  this.emit('ready')
}

/**
 * Send a message to a peer
 * @param  {String|Buffer} msg
 * @param  {String|Peer} to - peer, or peer's pubKey or fingerprint
 */
Node.prototype.send = function(msg, to) {
  var peer
  if (to instanceof Peer) {
    peer = to
    if (!this._peers[peer.identifier()]) throw new Error('not tracking this peer')
  }

  peer = this.getPeer(to)
  if (!peer) {
    this.addPeer(to)
    peer = this.getPeer(to)
  }

  if (!this.ready) return this.once('ready', this.send.bind(this, msg, to))

  peer.send(msg)
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

/**
 * add a peer
 * @param {Object|String} options
 * @param {String} options.identifier - peer's public key or fingerprint
 */
Node.prototype.addPeer = function(options) {
  var self = this

  if (typeof options === 'string') options = { identifier: options }

  options = options || {}

  var identifier = options.identifier
  assert(identifier, 'Missing required property: identifier')

  if (!this.ready) return this.once('ready', this.addPeer.bind(this, options))

  if (this.getPeer(identifier)) return

  var peer = this._peers[identifier] = new Peer({
    identifiers: {
      self: this._identifier,
      peer: identifier
    },
    keys: this._keys,
    dht: this._dht,
    socket: this._socket,
    myIp: this.ip,
    name: options.name
  })

  peer.on('data', function(data) {
    self.emit('data', data, identifier)
  })

  peer.on('connect', this.emit.bind(this, 'connect'))
}

Node.prototype._destroy = function(cb) {
  var self = this

  var ids = Object.keys(this._peers)
  var togo = ids.length + 1
  ids.forEach(function(id) {
    this._peers[id].destroy(finish)
  }, this)

  this._dht.destroy(function() {
    self._dht.removeAllListeners()
    finish()
  })

  if (this._dhtPath) {
    togo++
    fs.writeFile(this._dhtPath, JSON.stringify(this._dht.toArray()), finish)
  }

  function finish() {
    if (--togo === 0) {
      try {
        self._socket.close()
      } catch (err) {
        // socket was already closed
      }

      cb()
    }
  }
}

module.exports = Node
