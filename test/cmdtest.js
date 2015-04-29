#!/usr/bin/env node

// var test = require('tape')
var split = require('split')
var Node = require('../')
var privKeys = require('./priv')
var ec = require('../lib/crypto').ec
var DSA = require('otr').DSA
var myName = process.argv[2]
if (!privKeys[myName]) throw new Error('no key found for ' + name)

var keyType
var pubKeys = {}

for (var name in privKeys) {
  var keys = privKeys[name]
  if (keys.dsa) {
    keys.dsa = DSA.parsePrivate(keys.dsa)
    pubKeys[name] = keys.dsa.fingerprint()
  }
  else if (keys.ec) {
    keys.ec = ec.keyFromPrivate(keys.ec)
    pubKeys[name] = keys.ec.getPublic(true, 'hex')
  }
}

var node = new Node({
  dht: './dht.json',
  keys: privKeys[myName],
  port: process.argv[3] ? Number(process.argv[3]) : undefined
})

var others = Object.keys(privKeys).filter(function(n) {
  return n !== myName
})

node.once('ready', function() {
  others.forEach(function(name) {
    node.addPeer(pubKeys[name], name)
  })

  process.openStdin()
    .pipe(split())
    .on('data', function(line) {
      others.forEach(function(name) {
        node.send(line, pubKeys[name])
      })
    })

  node.on('data', function(data, from) {
    for (var name in pubKeys) {
      if (pubKeys[name] === from) {
        console.log(name + ': ' + data.toString())
      }
    }
  })
})

process.on('exit', exitHandler.bind(null,{cleanup:true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {exit:true}));

function exitHandler(options, err) {
  if (err) console.log(err.stack);

  node.destroy(function() {
    if (options.exit) process.exit(err ? 1 : 0)
  })
}
