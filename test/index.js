require('sock-jack')
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

    b.once('hello', function (pubKey, addr) {
      t.equal(pubKey.fingerprint(), a.fingerprint)
      destroyNodes(nodes)
    })
  })
})

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
        key: dsaKeys[i]
      })
    })

    cb(nodes)
  })
}

function destroyNodes (nodes) {
  nodes.forEach(function (node) { node.destroy() })
}

function makeFriends (dhts) {
  var n = dhts.length

  for (var i = 0; i < n; i++) {
    var next = dhts[(i + 1) % n]
    dhts[i].addNode('127.0.0.1:' + next.address().port, next.nodeId)
  }
}
