
var dgram = require('dgram')
var test = require('tape')
var Zlorp = require('../')
var DHT = require('../lib/dht')
var DSA = require('otr').DSA
var noop = function() {}
var names = ['bill', 'ted']//, 'rufus', 'missy']//, 'abe lincoln', 'genghis khan', 'beethoven', 'socrates']
var dsaKeys = require('./dsaKeys')
  .map(function(key) {
    return DSA.parsePrivate(key)
  })

var basePort = Math.random() * 100000 | 0
var createSocket = dgram.createSocket
var socketId = 0
dgram.createSocket = function() {
  var s = createSocket.apply(this, arguments)
  s.SOCKET_ID = socketId++
  if (s.SOCKET_ID === 0 || s.SOCKET_ID === 5 || s.SOCKET_ID === 6) debugger
  return s
}

test('destroy', function(t) {
  var node = new Zlorp({
    port: basePort++,
    dht: new DHT({ bootstrap: false }),
    keys: {
      dsa: dsaKeys[0]
    }
  })

  node.on('ready', function() {
    node.destroy(function() {
      t.end()
    })
  })
})

test('connect', function(t) {
  var n = Math.min(names.length, dsaKeys.length)

  t.plan(n - 1)
  makeConnectedDHTs(n, function(dhts) {
    var nodes = dhts.map(function(key, i) {
      return new Zlorp({
        port: basePort++,
        dht: dhts[i],
        keys: {
          dsa: dsaKeys[i]
        }
      })
    })

    var MSG = 'blah!'
    var togo = n - 1
    nodes.forEach(function(a, i) {
      a.once('data', function(msg) {
        msg = msg.toString('binary')
        console.log(names[i], 'got message:', msg)
        t.equals(msg, MSG)
        if (--togo > 0) return

        nodes.forEach(function(node) { node.destroy() })
        var intervalId = setInterval(function() {
          var active = process._getActiveHandles()
          if (active.length === 1) clearInterval(intervalId)
          else console.log('ACTIVE', active.length, active)
        }, 2000)
      })

      nodes.forEach(function(b, j) {
        if (i !== j) a.addPeer({
          name: names[j],
          identifier: b.identifier()
        })
      })
    })

    var sender = nodes[0]
    nodes.forEach(function(other) {
      if (other === sender) return

      sender.send(MSG, other.identifier())
    })
  })
})

function makeConnectedDHTs(n, cb) {
  var dhts = []
  for (var i = 0; i < n; i++) {
    var dht = new DHT({ bootstrap: false })
    dht.listen(finish)
    dhts.push(dht)
  }

  function finish() {
    if (--n === 0) {
      makeFriends(dhts)
      cb(dhts)
    }
  }

  return dhts
}

function makeFriends(dhts) {
  var n = dhts.length

  for (var i = 0; i < n; i++) {
    var next = dhts[(i + 1) % n]
    dhts[i].addNode('127.0.0.1:' + next.address().port, next.nodeId)
  }
}
