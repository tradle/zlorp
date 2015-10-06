require('sock-plex')

var MULTIPLEX = process.env.MULTIPLEX
if (MULTIPLEX) {
  console.warn('overloading dht port for chat')
}

var fs = require('fs')
var path = require('path')
var bufferEquals = require('buffer-equal')
var rimraf = require('rimraf')
var leveldown = require('memdown')
var test = require('tape')
var DSA = require('otr').DSA
var Zlorp = require('../')
var DHT = require('bittorrent-dht')
var Relay = require('dht-relay/relay')
var ChainedObj = require('chained-obj')
var buffers = require('./strings')
  .map(Buffer)

var basePort = 20000
var names = ['bill', 'ted']// , 'rufus', 'missy']//, 'abe lincoln', 'genghis khan', 'beethoven', 'socrates']
Zlorp.LOOKUP_INTERVAL = Zlorp.ANNOUNCE_INTERVAL = 1000
var dsaKeys = require('./dsaKeys')
  .map(function (key) {
    return DSA.parsePrivate(key)
  })

cleanup()

test('basic', function (t) {
  t.timeoutAfter(5000)

  makeConnectedNodes(2, function (nodes) {
    var a = nodes[0]
    var b = nodes[1]
    b.contact({
      name: a.name,
      fingerprint: a.fingerprint
    })

    var sending = []
    var togo = buffers.length
    buffers.forEach(function (msg) {
      sending.push(msg)
      b.send(msg, a.fingerprint)
    })

    a.on('data', function (d) {
      t.deepEqual(d.toString(), sending.shift().toString())
      if (--togo === 0) {
        destroyNodes(nodes, t.end)
      }
    })
  })
})

test('long message', function (t) {
  t.timeoutAfter(5000)

  makeConnectedNodes(2, function (nodes) {
    var a = nodes[0]
    var b = nodes[1]
    b.contact({
      name: a.name,
      fingerprint: a.fingerprint
    })

    var data = { hey: 'ho' }
    var logoPath = path.resolve('./test/logo.png')
    ChainedObj
      .Builder()
      .data(data)
      .attach({
        path: logoPath,
        name: 'logo'
      })
      .build(function (err, build) {
        if (err) throw err

        b.send(build.form, a.fingerprint)
      })

    a.on('data', function (d) {
      ChainedObj.Parser.parse(d, function (err, parsed) {
        if (err) throw err

        t.deepEqual(parsed.data, data)
        fs.readFile(logoPath, function (err, logo1) {
          if (err) throw err

          fs.readFile(parsed.attachments[0].path, function (err, logo2) {
            if (err) throw err

            t.ok(bufferEquals(logo1, logo2))
            destroyNodes(nodes, t.end)
          })
        })
      })
    })
  })
})

test('relay', function (t) {
  t.timeoutAfter(5000)
  var relayAddr = {
    port: basePort++,
    address: '127.0.0.1'
  }

  var relay = Relay.createServer(relayAddr.port)
  makeConnectedDHTs(2, function (dhts) {
    var nodes = dhts.map(function (dht, i) {
      return new Zlorp({
        name: names[i],
        port: MULTIPLEX ? dht.address().port : basePort++,
        dht: dht,
        key: dsaKeys[i],
        leveldown: leveldown,
        relay: relayAddr
      })
    })

    talk(nodes)
  })

  function talk (nodes) {
    var a = nodes[0]
    var b = nodes[1]
    b.contact({
      name: a.name,
      fingerprint: a.fingerprint
    })

    var msg = new Buffer('hey')
    b.send(msg, a.fingerprint)
    a.on('data', function (d) {
      t.deepEqual(d, msg)
      relay.close()
      destroyNodes(nodes, t.end)
      // setInterval(function () {
      //   console.log(process._getActiveHandles())
      // }, 4000).unref()
    })
  }
})

test('pesistent instance tags', function (t) {
  t.timeoutAfter(30000)

  makeConnectedNodes(2, function (nodes) {
    var a = nodes[0]
    var b = nodes[1]
    var aTag
    var bTag
    b.contact({
      name: a.name,
      fingerprint: a.fingerprint
    })

    b.send(new Buffer('hey'), a.fingerprint)

    a.on('data', function (data) {
      if (aTag) {
        t.equal(theirTag(a, b), aTag)
        t.equal(theirTag(b, a), bTag)
        destroyNodes(nodes, t.end)
        return
      }

      aTag = theirTag(a, b)
      bTag = theirTag(b, a)
      var dht = new DHT({ bootstrap: b._dht.toArray() })
      var port = b._dht.address().port
      dht.listen(port)
      var opts = {
        name: b.name,
        port: port,
        dht: dht,
        key: b.key,
        leveldown: leveldown
      }

      destroyNodes(b, function () {
        b = nodes[1] = new Zlorp(opts)
        b.send(new Buffer('ho'), a.fingerprint)
      })
    })
  })
})

test('destroy', function (t) {
  t.timeoutAfter(5000)
  var dht = new DHT({ bootstrap: false })
  var node = new Zlorp({
    leveldown: leveldown,
    dht: dht,
    key: dsaKeys[0]
  })

  node.on('ready', function () {
    node.destroy(function () {
      t.pass('successfully self-destructed')
      dht.destroy(function () {
        t.end()
      })
    })
  })
})

test('connect', function (t) {
  var n = Math.min(names.length, dsaKeys.length)

  t.plan(n - 1)
  makeConnectedNodes(n, function (nodes) {
    var MSG = new Buffer('excellent!')
    var togo = n - 1
    nodes.forEach(function (a, i) {
      a.available()
      a.once('data', function (msg) {
        t.deepEquals(msg, MSG, 'connected, sent/received encrypted data')
        if (--togo > 0) return

        destroyNodes(nodes)
      })

      nodes.forEach(function (b, j) {
        if (i !== j) {
          a.contact({
            name: b.name,
            fingerprint: b.fingerprint
          })
        }
      })
    })

    var sender = nodes[0]
    nodes.forEach(function (other) {
      if (other === sender) return

      sender.send(MSG, other.fingerprint)
    })
  })
})

test('connect knowing ip:port', function (t) {
  t.timeoutAfter(20000)
  var n = Math.min(names.length, dsaKeys.length)

  t.plan(n - 1)
  var nodes = []
  for (var i = 0; i < n; i++) {
    nodes.push(new Zlorp({
      name: names[i],
      port: basePort++,
      dht: new DHT({ bootstrap: false }),
      key: dsaKeys[i]
    }))
  }

  var MSG = new Buffer('excellent!')
  var togo = n - 1
  var sender = nodes[0]
  nodes.forEach(function (a, i) {
    a.available()
    a.once('data', function (msg) {
      t.deepEquals(msg, MSG, 'connected, sent/received encrypted data')
      if (--togo > 0) return

      // console.log('destroying')
      destroyNodes(nodes)
    })

    nodes.forEach(function (b, j) {
      if (i === j) return

      a.contact({
        name: b.name,
        fingerprint: b.fingerprint,
        address: '127.0.0.1:' + b.port
      })
    })
  })

  nodes.forEach(function (other) {
    if (other === sender) return

    sender.send(MSG, other.fingerprint)
  })
})

test('detect interest from strangers', function (t) {
  t.timeoutAfter(10000)
  t.plan(1)
  makeConnectedNodes(2, function (nodes) {
    var a = nodes[0]
    var b = nodes[1]
    a.contact({ fingerprint: b.fingerprint, name: b.name })

    b.on('knock', function (addr) {
      b.connect(addr)
    })

    b.once('connect', function (info) {
      t.equal(info.fingerprint, a.fingerprint)
      destroyNodes(nodes)
    })
  })
})

test('track delivery', function (t) {
  t.plan(6)
  t.timeoutAfter(10000)

  makeConnectedNodes(2, function (nodes) {
    var a = nodes[0]
    var b = nodes[1]
    b.contact({
      name: a.name,
      fingerprint: a.fingerprint
    })

    var sent = 0
    var words = 'is there anybody out there'.split(/\s/).map(Buffer)
    words.forEach(function (word, i) {
      b.send(word, a.fingerprint, function () {
        t.equal(sent++, i)
        if (i + 1 === words.length) {
          destroyNodes(nodes, t.pass)
        }
      })
    })
  })
})

test('cleanup', function (t) {
  cleanup()
  t.end()
})

function cleanup () {
  fs.readdirSync('./').forEach(function (file) {
    if (/zlorp-db/.test(file)) {
      rimraf.sync(path.resolve('./' + file))
    }
  })
}

function makeConnectedDHTs (n, cb) {
  var dhts = []
  for (var i = 0; i < n; i++) {
    var dht = new DHT({ bootstrap: false })
    dht.listen(basePort++, finish)
    dhts.push(dht)
  }

  function finish () {
    if (--n === 0) {
      makeFriends(dhts)
      cb(dhts)
    }
  }

  return dhts
}

function makeConnectedNodes (n, cb) {
  makeConnectedDHTs(n, function (dhts) {
    var nodes = dhts.map(function (dht, i) {
      return new Zlorp({
        name: names[i],
        port: MULTIPLEX ? dht.address().port : basePort++,
        dht: dht,
        key: dsaKeys[i],
        leveldown: leveldown
      })
    })

    cb(nodes)
  })
}

function destroyNodes (nodes, cb) {
  nodes = [].concat(nodes)
  var togo = nodes.length * 2
  nodes.forEach(function (node) {
    node.destroy(finish)
    node._dht.destroy(finish)
  })

  function finish () {
    if (--togo === 0 && cb) cb()
  }
}

function makeFriends (dhts) {
  var n = dhts.length

  for (var i = 0; i < n; i++) {
    var next = dhts[(i + 1) % n]
    dhts[i].addNode('127.0.0.1:' + next.address().port, next.nodeId)
  }
}

function theirTag (a, b) {
  return b.peers[a.fingerprint].otr.their_instance_tag
}
