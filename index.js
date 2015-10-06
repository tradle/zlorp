require('sock-plex')

var levelup = require('levelup')
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var extend = require('xtend')
var os = require('os')
var debug = require('debug')('zlorp')
var typeforce = require('typeforce')
var utils = require('./lib/utils')
var Peer = require('./lib/peer')
var DHT = require('bittorrent-dht')
var otr = require('otr')
var elistener = require('elistener')
var Relay = require('dht-relay')
Node.DHT = DHT
Node.OTR = otr.OTR
Node.DSA = otr.DSA
Node.LOOKUP_INTERVAL = 30000
Node.ANNOUNCE_INTERVAL = 3000000
Node.KEEP_ALIVE_INTERVAL = 60000
var externalIp = require('bittorrent-dht/lib/public-address')
var DHT_KEY = 'dht'
var INSTANCE_TAG_KEY = 'instance_tag'
var DB_PATH = 'zlorp-db'
var LOCAL_HOSTS = { 4: [], 6: [] }
// var BOOTSTRAP_NODES = ['tradle.io:25778']
var interfaces = os.networkInterfaces()
for (var i in interfaces) {
  for (var j = 0; j < interfaces[i].length; j++) {
    var face = interfaces[i][j]
    if (face.family === 'IPv4') LOCAL_HOSTS[4].push(face.address)
    if (face.family === 'IPv6') LOCAL_HOSTS[6].push(face.address)
  }
}

function Node (options) {
  var self = this

  options = options || {}

  typeforce({
    key: 'Object'
  }, options)

  this._otrOptions = options.otr || {}
  this._ipv = options.ipv || 4
  this.localIPs = LOCAL_HOSTS[this._ipv]
  this._announceInterval = options.announceInterval
  this._lookupInterval = options.lookupInterval
  this.name = options.name
  this.key = options.key
  this.port = options.port
  this.fingerprint = this.key.fingerprint()
  this.infoHash = utils.infoHash(this.fingerprint)
  this.rInfoHash = utils.rInfoHash(this.fingerprint)
  this.relay = options.relay

  if (options.externalIp) onExternalIp(null, options.externalIp)
  else externalIp(onExternalIp)

  if (options.levelup) {
    this._db = options.levelup
  } else if (options.leveldown) {
    this._db = levelup(DB_PATH + '-' + this.fingerprint + '.db', {
      db: options.leveldown,
      valueEncoding: 'json'
    })
  }

  this.socket = options.relay ?
    Relay.createClient(options.relay) :
    dgram.createSocket('udp4')

  this.socket.filterMessages(function (msg) {
    return !/^d1:.?d2:id20:/.test(msg)
  })

  this.socket.setMaxListeners(0)

  this._loadDHT(options.dht)
  this._loadInstanceTag()
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

  function onExternalIp (err, ip) {
    if (err) self._debug('unable to get own public ip')

    self.ip = ip
    if (ip && self.localIPs.indexOf(ip) === -1) {
      self.localIPs.push(ip)
    }

    self._checkReady()
  }
}

inherits(Node, EventEmitter)
utils.destroyify(Node)
elistener(Node.prototype)

Node.prototype._loadInstanceTag = function () {
  var self = this

  if (this._db) {
    this._db.get(INSTANCE_TAG_KEY, function (err, tag) {
      if (err) self._debug('no instance tag found in storage')

      self.instanceTag = tag
      finish()
    })
  } else {
    finish()
  }

  function finish () {
    if (!self.instanceTag) {
      self.instanceTag = Node.OTR.makeInstanceTag()
      if (self._db) {
        self._db.put(INSTANCE_TAG_KEY, self.instanceTag)
      }
    }

    self._checkReady()
  }
}

Node.prototype._loadDHT = function (dht) {
  var self = this

  if (this._dht) throw new Error('already hooked up to DHT')

  if (dht && (!dht instanceof DHT)) throw new Error('dht must be a DHT instance')

  if (dht || !this._db) {
    this._dht = dht
    this._dontKillDHT = true
    configure()
  } else if (this._db) {
    this._db.get(DHT_KEY, function (err, result) {
      if (!err && result && result.length) {
        self._dht = new DHT({ bootstrap: result })
      }

      configure()
    })
  }

  function configure () {
    if (!self._dht) self._dht = new DHT()

    try {
      self._dht.listen(self.port)
    } catch (err) {}

    self._dht.setMaxListeners(500)
    self._dht.socket.filterMessages(function (msg, rinfo) {
      return /^d1:.?d2:id20:/.test(msg)
    })

    self.listenTo(self._dht, 'node', function (addr) {
      self._dht._sendPing(addr)
    })

    self.listenOnce(self._dht, 'ready', self._checkReady.bind(self))
    self.listenTo(self._dht, 'peer', function (addr, infoHash, from) {
      self._dht.emit('peer:' + infoHash, addr, from)
    })

    self._keepAlive()

    checkPort()
  }

  function checkPort () {
    if (!self._dht.listening) {
      return self.listenOnce(self._dht, 'listening', checkPort)
    }

    if (self.port && self._dhtPort() !== self.port) {
      // throw new Error("node must share DHT's port")
      var warning = 'using a different port may not fully take advantage of UDP hole punching'
      self.emit('warn', warning)
      console.warn(warning)
    } else {
      self.port = self._dhtPort()
    }

    onPort()
  }

  function onPort () {
    self._checkReady()
  }
}

Node.prototype._dhtPort = function () {
  if (!this.__dhtPort) {
    this.__dhtPort = this._dht.address().port
  }

  return this.__dhtPort
}

Node.prototype._addrIsSelf = function (addr) {
  return this.address === addr || LOCAL_HOSTS[4].some(function (host) {
    return host + ':' + this.port === addr
  }, this)
}

Node.prototype._checkReady = function () {
  var self = this
  var ready = (this._dht && this._dht.ready) &&
    'ip' in this &&
    'instanceTag' in this

  if (!ready) return

  this.address = this.ip && (this.ip + ':' + this.port)

  this.listenTo(this._dht, 'announce', connect)
  this.listenTo(this._dht, 'peer', connect)

  this.ready = true
  this.emit('ready')
  this._lookupForever(this.rInfoHash)

  function connect (addr, infoHash) {
    if (self._destroying ||
        self._addrIsSelf(addr) ||
        self.getPeerWith('address', addr)) {
      return
    }

    if (infoHash === self.rInfoHash) {
      if (self._available) {
        self.connect(addr)
      } else {
        self.emit('knock', addr)
      }
    }

    if (self.getUnresolvedBy('infoHash', infoHash) ||
      self.getUnresolvedBy('rInfoHash', infoHash)) {
      self.connect(addr)
    }
  }
}

Node.prototype._debug = function () {
  var args = [].slice.call(arguments)
  var me = (this.name || '') + ' ' + (this.address || '') + ' ' + (this.infoHash)
  args.unshift(me)
  debug.apply(null, args)
}

Node.prototype.blacklist = function (addr) {
  this.blacklist[addr] = true
}

Node.prototype.connect = function (addr, expectedFingerprint) {
  var self = this
  var hostPort = addr.split(':')
  if (hostPort.length !== 2) throw new Error('invalid address provided')

  if (!this.ready) return this.once('ready', this.connect.bind(this, addr, expectedFingerprint))

  if (this.localIPs.indexOf(hostPort[0]) !== -1) {
    // most external known ip
    // addr = this.localIPs[this.localIPs.length - 1] + ':' + hostPort[1]
    // most local known ip
    addr = this.localIPs[0] + ':' + hostPort[1]
  }

  if (this.address === addr) throw new Error('cannot connect to self')

  if (this.blacklist[addr] || this.getPeerWith('address', addr)) return

  var peer = this.scouts[addr] = new Peer({
    otrOptions: this._otrOptions,
    instanceTag: this.instanceTag,
    key: this.key,
    address: addr,
    localPort: this.port,
    myIp: this.ip
    // ,
    // socket: this.socket
  })

  peer.once('resolved', function (addr, pubKey) {
    var fingerprint = pubKey.fingerprint()
    if (expectedFingerprint && fingerprint !== expectedFingerprint) {
      self._debug('peer at ' + addr + ' doesn\'t have expected fingerprint, destroying them')
      peer.destroy()
      return
    }

    if (self.peers[fingerprint]) {
      self._debug('already connected to peer with fingerprint: ' + fingerprint)
      return
    }

    debug('resolved', fingerprint, 'to', addr)
    var infoHash = utils.infoHash(fingerprint)
    var rInfoHash = utils.rInfoHash(fingerprint)
    self._stopAnnouncing(rInfoHash)
    self._stopLookingUp(infoHash)
    if (self._ignoreStrangers) return peer.destroy()

    delete self.scouts[addr]
    self.peers[fingerprint] = peer
    var queue = self.queue[fingerprint]
    if (queue) {
      queue.forEach(function (args) {
        peer.send.apply(peer, args)
      })

      delete self.queue[fingerprint]
    }

    self.emit('connect', {
      fingerprint: fingerprint,
      address: addr,
      pubKey: pubKey
    })
  })

  peer.once('error', function (err) {
    debug('experienced otr error with peer', err)
    // self.blacklist[addr] = true
    peer.destroy(function () {
      if (self._destroying) return

      self.connect(addr, expectedFingerprint)
    })
  })

  peer.once('destroy', function () {
    self.removePeerWith('fingerprint', peer.fingerprint)
  })

  peer.on('data', function (data) {
    self.emit('data', data, peer.fingerprint)
  })

  peer.connect()
}

Node.prototype.ignoreStrangers = function () {
  this._ignoreStrangers = true
  return this
}

/**
 * Send a message to a peer
 * @param  {Buffer} msg - base64 string or Buffer
 * @param  {String} fingerprint - peer, or peer's pubKey or fingerprint
 */
Node.prototype.send = function (msg, fingerprint, cb) {
  var peer

  typeforce('Buffer', msg)
  typeforce('String', fingerprint)

  if (!this.ready) {
    return this.once('ready', this.send.bind(this, msg, fingerprint, cb))
  }

  msg = utils.fromBuffer(msg)
  if (msg.indexOf('\x00') !== -1) {
    throw new Error('message may not contain null bytes')
  }

  peer = this.getPeerWith('fingerprint', fingerprint)
  if (!peer) {
    this.contact({
      fingerprint: fingerprint
    })

    var q = this.queue[fingerprint] = this.queue[fingerprint] || []
    q.push([msg, cb])
    return
  }

  peer.send(msg, cb)
}

Node.prototype.getUnresolvedBy = function (property, value) {
  for (var key in this.unresolved) {
    if (this.unresolved[key][property] === value) return this.unresolved[key]
  }
}

Node.prototype.getPeerWith = function (property, value) {
  return search(this.peers) || search(this.scouts)

  function search (peers) {
    for (var key in peers) {
      if (peers[key][property] === value) return peers[key]
    }
  }
}

// TODO: resolve code duplication with getPeerWith
Node.prototype.removePeerWith = function (property, value) {
  return search(this.peers) || search(this.scouts)

  function search (peers) {
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

Node.prototype.getPeer = function (fingerprint) {
  return this.getPeerWith('fingerprint', fingerprint)
}

/**
 * add a peer
 * @param {Object} options
 * @param {String} options.fingerprint - peer's public key or fingerprint
 * @param {String} options.infoHash - peer's fingerprint infoHash
 * @param {String} options.address - peer's ip:port
 * @param {String} options.name - optional, peer's name
 */
Node.prototype.contact = function (options) {
  var self = this

  assert(typeof options === 'object', 'Missing required property: options')
  assert(options.fingerprint || options.infoHash, 'Provide fingerprint or infoHash')

  if (!this.ready) return this.once('ready', this.contact.bind(this, options))

  var fingerprint = options.fingerprint
  var infoHash = options.infoHash || utils.infoHash(fingerprint)
  if (this.unresolved[infoHash]) return

  var rInfoHash = utils.rInfoHash(fingerprint)

  if (this.getPeerWith('infoHash', infoHash)) return

  this.unresolved[infoHash] = extend({
    fingerprint: fingerprint,
    infoHash: infoHash,
    rInfoHash: rInfoHash
  }, options)

  this._lookupForever(infoHash)
  this.listenOnce(this._dht, 'peer:' + infoHash, function (addr) {
    self._stopLookingUp(infoHash)
    self._announceForever(rInfoHash)
  })

  if (options.address) {
    this.connect(options.address, fingerprint)
  }

  this._reemitExistingPeers()
  this._relookup()
// this._reannounce()
}

Node.prototype._relookup = function () {
  for (var infoHash in this._lookupTimeouts) {
    this._lookupForever(infoHash)
  }
}

Node.prototype._reannounce = function () {
  for (var infoHash in this._announceTimeouts) {
    this._announceForever(infoHash)
  }
}

Node.prototype._reemitExistingPeers = function () {
  // re-emit existing peers
  var peers = this._dht.peers
  for (var infoHash in peers) {
    var addrs = peers[infoHash].index
    for (var addr in addrs) {
      this._dht.emit('peer', addr, infoHash)
    }
  }
}

Node.prototype._announceForever = function (infoHash) {
  var self = this

  if (!this.ready) return this.once('ready', this._lookupForever.bind(this, infoHash))

  var interval = this._announceInterval || Node.ANNOUNCE_INTERVAL
  clearTimeout(this._announceTimeouts[infoHash])

  announce()

  function announce () {
    // self._dht.announce(infoHash, self.port, loop)
    if (self._destroying) return

    if (self.port === self._dhtPort()) {
      // use implied_port option by not specifying port
      self._dht.announce(infoHash, loop)
    } else {
      self._dht.announce(infoHash, self.port, loop)
    }
  }

  function loop () {
    clearTimeout(self._announceTimeouts[self.infoHash])
    self._announceTimeouts[self.infoHash] = setTimeout(announce, interval)
  }
}

Node.prototype._lookupForever = function (infoHash) {
  var self = this

  if (!this.ready) return this.once('ready', this._lookupForever.bind(this, infoHash))

  var interval = this._lookupInterval || Node.LOOKUP_INTERVAL
  clearTimeout(this._lookupTimeouts[infoHash])

  lookup()

  function lookup () {
    if (self._destroying) return
    if (!self._dht.ready) self.listenOnce(self._dht, 'ready', lookup)
    else {
      self._dht.lookup(infoHash, loop)
    }
  }

  function loop () {
    clearTimeout(self._lookupTimeouts[infoHash])
    self._lookupTimeouts[infoHash] = setTimeout(lookup, interval)
  }
}

Node.prototype._stopAnnouncing = function (infoHash) {
  clearTimeout(this._announceTimeouts[infoHash])
  delete this._announceTimeouts[infoHash]
}

Node.prototype._stopLookingUp = function (infoHash) {
  clearTimeout(this._lookupTimeouts[infoHash])
  delete this._lookupTimeouts[infoHash]
}

Node.prototype.available = function () {
  this._available = true
  this._announceForever(this.infoHash)
  return this
}

Node.prototype.unavailable = function () {
  this._available = false
  this._stopAnnouncing(this.infoHash)
  return this
}

Node.prototype._keepAlive = function () {
  if ('_pingNodesInterval' in this) return

  var dht = this._dht
  this._pingNodesInterval = setInterval(function () {
    dht.toArray().forEach(function (n) {
      dht._sendPing(n.addr)
    })
  }, Node.KEEP_ALIVE_INTERVAL)
}

Node.prototype._destroy = function (cb) {
  var self = this
  var togo = 0

  clearInterval(this._pingNodesInterval)

  for (var atKey in this._announceTimeouts) {
    clearTimeout(this._announceTimeouts[atKey])
  }

  for (var ltKey in this._lookupTimeouts) {
    clearTimeout(this._lookupTimeouts[ltKey])
  }

  if (this._dht) {
    if (this._db) {
      togo++
      this._debug('saving dht')
      this._db.put(DHT_KEY, this._dht.toArray(), function () {
        self._db.close(finish)
      })
    }

    if (!this._dontKillDHT) {
      togo++
      this._dht.destroy(function () {
        self._dht.removeAllListeners()
        finish()
      })
    }
  }

  togo += Object.keys(this.peers).length
  togo += Object.keys(this.scouts).length
  destroy(this.peers)
  destroy(this.scouts)

  function destroy (peers) {
    self._debug('destroying', Object.keys(peers).length, 'peers')
    for (var key in peers) {
      peers[key].destroy(finish)
    }
  }

  function finish () {
    if (--togo === 0) {
      self._debug('destroyed')
      cb()
    }
  }
}

module.exports = Node
