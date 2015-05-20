#!/usr/bin/env node

// var test = require('tape')
var split = require('split')
var Node = require('../')
var privKeys = require('./priv')
var DSA = require('otr').DSA
var myName = process.argv[2]
if (!privKeys[myName]) throw new Error('no key found for ' + name)

var keyType
var fingerprints = {}

for (var name in privKeys) {
  var key = privKeys[name] = DSA.parsePrivate(privKeys[name])
  fingerprints[name] = key.fingerprint()
}

var node = new Node({
  key: privKeys[myName],
  port: process.argv[3] ? Number(process.argv[3]) : undefined
})

var others = Object.keys(privKeys).filter(function(n) {
  return n !== myName
})

others.forEach(function(name) {
  var otherfinger = fingerprints[name]
  node.contact({
    fingerprint: otherfinger,
    name: name
  })

  node.on('connect', function(fingerprint) {
    if (fingerprint === otherfinger) {
      console.log('Tell ' + name + ' how you feel')
    }
  })
})

process.openStdin()
  .pipe(split())
  .on('data', function(line) {
    others.forEach(function(name) {
      node.send(line, fingerprints[name])
    })
  })

node.on('data', function(data, from) {
  for (var name in fingerprints) {
    if (fingerprints[name] === from) {
      console.log(name + ': ' + data.toString())
    }
  }
})

process.on('exit', exitHandler.bind(null, { cleanup:true }));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit:true }));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit:true }));

function exitHandler(options, err) {
  if (err) console.log(err.stack);

  node.destroy(exit)
  var timeoutId = setTimeout(exit, 5000)

  function exit() {
    clearTimeout(timeoutId)
    if (options.exit) process.exit()
  }
}
