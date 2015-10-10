#!/usr/bin/env node

// var test = require('tape')
var crypto = require('crypto')
var exitHook = require('exit-hook')
var split = require('split')
var Node = require('../')
Node.ANNOUNCE_INTERVAL = 5000
Node.LOOKUP_INTERVAL = 5000
var privKeys = require('./priv')
var leveldown = require('memdown')
var DHT = require('bittorrent-dht')
var dns = require('dns')
var DSA = require('otr').DSA
var myName = process.argv[2]
var tradleIp
if (!privKeys[myName]) throw new Error('no key found for ' + name)

var fingerprints = {}

for (var name in privKeys) {
  var key = privKeys[name] = DSA.parsePrivate(privKeys[name])
  fingerprints[name] = key.fingerprint()
}

dns.lookup('tradle.io', function (err, address) {
  if (err) throw err

  start(address)
})

function start (relayIP) {
  var node = new Node({
    key: privKeys[myName],
    port: process.argv[3] ? Number(process.argv[3]) : undefined,
    leveldown: leveldown,
    relay: {
      address: relayIP,
      port: 25778
    },
    dht: new DHT({
      nodeId: getNodeId(fingerprints[myName]),
      bootstrap: ['tradle.io:25778']
    })
  })

  var others = Object.keys(privKeys).filter(function (n) {
    return n !== myName
  })

  others.forEach(function (name) {
    var otherfinger = fingerprints[name]
    node.contact({
      fingerprint: otherfinger,
      name: name
    })

    node.on('connect', function (info) {
      if (info.fingerprint === otherfinger) {
        console.log('Tell ' + name + ' how you feel')
      }
    })
  })

  process.openStdin()
    .pipe(split())
    .on('data', function (line) {
      others.forEach(function (name) {
        node.send(toBuffer(line), fingerprints[name])
      })
    })

  node.on('data', function (data, from) {
    for (var name in fingerprints) {
      if (fingerprints[name] === from) {
        console.log(name + ': ' + data.toString())
      }
    }
  })

  exitHook(node.destroy.bind(node))
}

function toBuffer (str) {
  if (Buffer.isBuffer(str)) return str

  return new Buffer(str)
}

// process.on('exit', exitHandler.bind(null, { cleanup:true }))

// //catches ctrl+c event
// process.on('SIGINT', exitHandler.bind(null, { exit:true }))

// //catches uncaught exceptions
// process.on('uncaughtException', exitHandler.bind(null, { exit:true }))

// function exitHandler(options, err) {
//   if (err) console.log(err.stack)

//   node.destroy(exit)
//   var timeoutId = setTimeout(exit, 5000)

//   function exit() {
//     clearTimeout(timeoutId)
//     if (options.exit) process.exit()
//   }
// }

function getNodeId (fingerprint) {
  return crypto.createHash('sha256')
    .update(fingerprint)
    .digest()
    .slice(0, 20)
}
