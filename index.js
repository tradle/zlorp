
var fs = require('fs')
var dgram = require('dgram')
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var extend = require('extend')
var os = require('os')
var rudp = require('rudp')
var debug = require('debug')('zlorp')
var typeforce = require('typeforce')
var utils = require('./lib/utils')
var Peer = require('./lib/peer')
var DHT = require('./lib/dht')
Node.DHT = DHT // export DHT to allow override
var externalIp = require('./lib/externalIp')
var DEFAULT_INTERVAL = 10000
var LOOKUP_INTERVAL = DEFAULT_INTERVAL
var ANNOUNCE_INTERVAL = DEFAULT_INTERVAL
var KEEP_ALIVE_INTERVAL = DEFAULT_INTERVAL
var LOCAL_HOSTS = { 4: [], 6: [] }
var interfaces = os.networkInterfaces()
for (var i in interfaces) {
  for (var j = 0; j < interfaces[i].length; j++) {
    var face = interfaces[i][j]
    if (face.family === 'IPv4') LOCAL_HOSTS[4].push(face.address)
    if (face.family === 'IPv6') LOCAL_HOSTS[6].push(face.address)
  }
}

function Node(options) {
  var self = this

  options = options || {}

  typeforce({
    port: 'Number',
    key: 'Object'
  }, options)

  this.name = options.name
  this.key = options.key
  this.port = options.port
  this.fingerprint = this.key.fingerprint()
  this.infoHash = utils.infoHash(this.fingerprint)
  this.rInfoHash = utils.rInfoHash(this.fingerprint)

  if (options.externalIp) onExternalIp(null, options.externalIp)
  else externalIp(onExternalIp)

  this._loadDHT(options.dht)
  this.socket = dgram.createSocket('udp4')
  this.socket.bind(this.port, function() {
    self._socketReady = true
    self._checkReady()
  })

  this.unresolved = {}
  this.peers = {}
  this.scouts = {}
  this.blacklist = {}
  this.queue = {}

  this._lookupTimeouts = {}
  this._announceTimeouts = {}
  if (options.available !== false) {
    this.once('ready', this.available.bind(this))
  }

  function onExternalIp(err, ip) {
    self._ipDone = true
    if (ip) {
      self.ip = ip
      self.address = self.ip + ':' + self.port
    }

    self._checkReady()
  }
}

inherits(Node, EventEmitter)
utils.destroyify(Node)

Node.prototype._loadDHT = function(dht) {
  if (this._dht) throw new Error('already hooked up to DHT')

  if (dht) {
    if (typeof dht === 'string') {
      this._dhtPath = dht
      if (fs.existsSync(dht)) {
        this._dht = new Node.DHT({
          bootstrap: require(dht)
        })
      }
    }
    else {
      this._dht = dht
    }
  }

  if (!this._dht) this._dht = new Node.DHT()

  this._dht.setMaxListeners(500)
  this._dht.once('ready', this._checkReady.bind(this))
}

Node.prototype._addrIsSelf = function(addr) {
  return this.address === addr || LOCAL_HOSTS[4].some(function(host) {
    return host + ':' + this.port === addr
  }, this)
}

Node.prototype._checkReady = function() {
  var self = this

  if (!(this._socketReady && this._dht.ready && this._ipDone)) return

  this._dht.on('announce', connect)
  this._dht.on('peer', connect)

  this.ready = true
  this.emit('ready')
  this._lookupForever(this.rInfoHash)

  function connect(addr, infoHash) {
    if (self._addrIsSelf(addr) || self.getPeerWith('address', addr)) return

    if (infoHash === self.rInfoHash) {
      if (self._available) {
        self.connect(addr)
      }
      else {
        self.emit('knock', addr)
      }
    }

    if (self.getUnresolvedBy('infoHash', infoHash) ||
       self.getUnresolvedBy('rInfoHash', infoHash)) {
      self.connect(addr)
    }
  }
}

Node.prototype._debug = function() {
  var args = [].slice.call(arguments)
  var me = (this.name || '') + ' ' + (this.address || '') + ' ' + (this.infoHash)
  args.unshift(me)
  debug.apply(null, args)
}

Node.prototype.blacklist = function(addr) {
  this.blacklist[addr] = true
}

Node.prototype.connect = function(addr) {
  var self = this

  if (this.address === addr) throw new Error('cannot connect to self')

  var hostPort = addr.split(':')
  if (hostPort.length !== 2) throw new Error('invalid address provided')

  if (!this.ready) return this.once('ready', this.connect.bind(this, addr))

  if (this.blacklist[addr] || this.getPeerWith('address', addr)) return

  var peer = this.scouts[addr] = new Peer({
    key: this.key,
    address: addr,
    myIp: this.ip,
    socket: this.socket
  })

  peer.once('resolved', function(addr, pubKey) {
    var fingerprint = pubKey.fingerprint()
    debug('resolved', fingerprint, 'to', addr)
    var infoHash = utils.infoHash(fingerprint)
    var rInfoHash = utils.rInfoHash(fingerprint)
    self._stopAnnouncing(rInfoHash)
    self._stopLookingUp(infoHash)
    if (self.unresolved[infoHash]) {
      delete self.scouts[addr]
      self.peers[fingerprint] = peer
      self.emit('connect', fingerprint, addr)
      var queue = self.queue[fingerprint]
      if (queue) {
        queue.forEach(peer.send, peer)
        delete self.queue[fingerprint]
      }
    }
    else {
      if (self._ignoreStrangers) peer.destroy()
      else self.emit('hello', pubKey, addr)
    }
  })

  peer.once('error', function(err) {
    debug('experienced error with peer, blacklisting', err)
    self.blacklist[addr] = true
    peer.destroy()
  })

  peer.once('destroy', function() {
    self.removePeerWith('fingerprint', peer.fingerprint)
  })

  peer.on('data', function(data) {
    self.emit('data', data, peer.fingerprint)
  })

  peer.connect()
}

Node.prototype.ignoreStrangers = function() {
  this._ignoreStrangers = true
  return this
}

/**
 * Send a message to a peer
 * @param  {String|Buffer} msg
 * @param  {String} fingerprint - peer, or peer's pubKey or fingerprint
 */
Node.prototype.send = function(msg, fingerprint) {
  var peer

  if (!this.ready) return this.once('ready', this.send.bind(this, msg, fingerprint))

  peer = this.getPeerWith('fingerprint', fingerprint)
  if (!peer) {
    this.contact({
      fingerprint: fingerprint
    })

    var q = this.queue[fingerprint] = this.queue[fingerprint] || []
    q.push(msg)
    return
  }

  peer.send(msg)
}

Node.prototype.getUnresolvedBy = function(property, value) {
  for (var key in this.unresolved) {
    if (this.unresolved[key][property] === value) return this.unresolved[key]
  }
}

Node.prototype.getPeerWith = function(property, value) {
  return search(this.peers) || search(this.scouts)

  function search(peers) {
    for (var key in peers) {
      if (peers[key][property] === value) return peers[key]
    }
  }
}

// TODO: resolve code duplication with getPeerWith
Node.prototype.removePeerWith = function(property, value) {
  return search(this.peers) || search(this.scouts)

  function search(peers) {
    var peer
    for (var key in peers) {
      peer = peers[key]
      if (peer[property] === value) {
        delete peers[key]
        peer.destroy()
      }
    }
  }
}

Node.prototype.getPeer = function(fingerprint) {
  return this.getPeerWith('fingerprint', fingerprint)
}

/**
 * add a peer
 * @param {Object} options
 * @param {String} options.fingerprint - peer's public key or fingerprint
 * @param {String} options.infoHash - peer's fingerprint infoHash
 * @param {String} options.name - optional, peer's name
 */
Node.prototype.contact = function(options) {
  var self = this

  assert(typeof options === 'object', 'Missing required property: options')
  assert(options.fingerprint || options.infoHash, 'Provide fingerprint or infoHash')

  if (!this.ready) return this.once('ready', this.contact.bind(this, options))

  var fingerprint = options.fingerprint
  var infoHash = options.infoHash || utils.infoHash(fingerprint)
  if (this.unresolved[infoHash]) return

  var rInfoHash = utils.rInfoHash(fingerprint)

  if (this.getPeerWith('infoHash', infoHash)) return

  var potential = this.unresolved[infoHash] = extend({
    fingerprint: fingerprint,
    infoHash: infoHash,
    rInfoHash: rInfoHash,
    otr: null
  }, options)

  this._lookupForever(infoHash)
  this._dht.once('peer:' + infoHash, function(addr) {
    self._stopLookingUp(infoHash)
    self._announceForever(rInfoHash)
  })
}

Node.prototype._announceForever = function(infoHash) {
  var self = this

  if (this._announceTimeouts[infoHash]) return

  announce()

  function announce() {
    self._dht.announce(infoHash, self.port, loop)
  }

  function loop() {
    clearTimeout(self._announceTimeouts[self.infoHash])
    self._announceTimeouts[self.infoHash] = setTimeout(announce, ANNOUNCE_INTERVAL)
  }
}

Node.prototype._lookupForever = function(infoHash) {
  var self = this

  if (this._lookupTimeouts[infoHash]) return

  lookup()

  function lookup() {
    self._dht.lookup(infoHash, self.port, loop)
  }

  function loop() {
    clearTimeout(self._lookupTimeouts[infoHash])
    self._lookupTimeouts[infoHash] = setTimeout(lookup, ANNOUNCE_INTERVAL)
  }
}

Node.prototype._stopAnnouncing = function(infoHash) {
  clearTimeout(this._announceTimeouts[infoHash])
  delete this._announceTimeouts[infoHash]
}

Node.prototype._stopLookingUp = function(infoHash) {
  clearTimeout(this._lookupTimeouts[infoHash])
  delete this._lookupTimeouts[infoHash]
}

Node.prototype.available = function() {
  this._available = true
  this._announceForever(this.infoHash)
  return this
}

Node.prototype.unavailable = function() {
  this._available = false
  this._stopAnnouncing(this.infoHash)
  return this
}

Node.prototype._destroy = function(cb) {
  var self = this
  var togo = 1

  for (var key in this._announceTimeouts) {
    clearTimeout(this._announceTimeouts[key])
  }

  for (var key in this._lookupTimeouts) {
    clearTimeout(this._lookupTimeouts[key])
  }

  if (this._dhtPath) {
    togo++
    self._debug('saving dht')
    fs.writeFile(this._dhtPath, JSON.stringify(this._dht.toArray()), finish)
  }

  this._dht.destroy(function() {
    self._dht.removeAllListeners()
    finish()
  })

  destroy(this.peers)
  destroy(this.scouts)

  function destroy(peers) {
    self._debug('destroying', Object.keys(peers).length, 'peers')
    for (var key in peers) {
      togo++
      peers[key].destroy(finish)
    }
  }

  function finish() {
    // self._debug('togo', togo)
    if (--togo === 0) {
      try {
        self.socket.close()
      } catch (err) {
        console.warn('attempting to close socket that\'s already closed')
      }

      cb()
    }
  }
}

module.exports = Node
