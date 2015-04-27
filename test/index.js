#!/usr/bin/env node

// var test = require('tape')
var split = require('split')
var Node = require('../')
var privKeys = require('./priv')
var ec = require('../crypto').ec
var name = process.argv[2]
if (!privKeys[name]) throw new Error('no key found for ' + name)

var pubKeys = {}
for (var name in privKeys) {
  pubKeys[name] = ec.keyFromPrivate(privKeys[name]).getPublic(true, 'hex')
}

var node = new Node({
  dht: './dht.json',
  priv: privKeys[name]
})

var others = Object.keys(privKeys).filter(function(n) {
  return n !== name
})

node.once('ready', function() {
  others.forEach(function(name) {
    node.addPeer(pubKeys[name])
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
