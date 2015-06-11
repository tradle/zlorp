require('sock-jack')
var fs = require('fs')
var path = require('path')
var rimraf = require('rimraf')
var leveldown = require('leveldown')
var test = require('tape')
var DSA = require('otr').DSA
var Zlorp = require('../')
var DHT = require('bittorrent-dht')
var basePort = 20000
var names = ['bill', 'ted']// , 'rufus', 'missy']//, 'abe lincoln', 'genghis khan', 'beethoven', 'socrates']
Zlorp.LOOKUP_INTERVAL = Zlorp.ANNOUNCE_INTERVAL = 100
var dsaKeys = require('./dsaKeys')
  .map(function (key) {
    return DSA.parsePrivate(key)
  })

cleanup()

test('pesistent instance tags', function (t) {
  // t.timeoutAfter(30000)

  makeConnectedNodes(2, function (nodes) {
    var a = nodes[0]
    var b = nodes[1]
    var aTag
    var bTag
    b.contact(a)
    b.send('hey', a.fingerprint)

    a.on('data', function () {
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
        b.send('ho', a.fingerprint)
      })
    })
  })
})

test('destroy', function (t) {
  t.timeoutAfter(5000)
  var node = new Zlorp({
    leveldown: leveldown,
    dht: new DHT({ bootstrap: false }),
    key: dsaKeys[0]
  })

  node.on('ready', function () {
    node.destroy(function () {
      t.pass('successfully self-destructed')
      t.end()
    })
  })
})

test('connect', function (t) {
  var n = Math.min(names.length, dsaKeys.length)

  t.plan(n - 1)
  makeConnectedNodes(n, function (nodes) {
    var MSG = 'excellent!'
    var togo = n - 1
    nodes.forEach(function (a, i) {
      a.available()
      a.once('data', function (msg) {
        msg = msg.toString('binary')
        t.equals(msg, MSG, 'connected, sent/received encrypted data')
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

  var MSG = 'excellent!'
  var togo = n - 1
  var sender = nodes[0]
  nodes.forEach(function (a, i) {
    a.available()
    a.once('data', function (msg) {
      msg = msg.toString('binary')
      t.equals(msg, MSG, 'connected, sent/received encrypted data')
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
        port: dht.address().port,
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
  var togo = nodes.length
  nodes.forEach(function (node) {
    node.destroy(finish)
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
