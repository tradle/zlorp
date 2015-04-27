
var upnp = require('nat-upnp')
var request = require('request')
var myIp
var callbacks = []
var running

module.exports = function externalIp(cb) {
  if (myIp) {
    return process.nextTick(function() {
      cb(null, myIp)
    })
  }

  callbacks.push(cb)
  if (running) return

  running = true

  cb = function(err, ip) {
    if (ip) myIp = ip

    while (callbacks.length) {
      callbacks.shift()(err, ip)
    }

    running = false
  }

  tryUpnp(function(err, ip) {
    if (ip) return cb(null, ip)
    else tryIpify(cb)
  })
}

function tryUpnp(cb) {
  if (!(upnp && upnp.createClient)) return cb(new Error('can\'t do upnp'))

  return new upnp.createClient().externalIp(cb)
}

function tryIpify(cb) {
  request('http://api.ipify.org?format=json', function(err, resp, body) {
    if (err) return cb(err)

    try {
      var ip = JSON.parse(body).ip
      cb(null, ip)
    } catch(err) {
      cb(err)
    }
  })
}
