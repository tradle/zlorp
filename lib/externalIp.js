
var upnp = require('nat-upnp')
var get = require('simple-get')
var thunky = require('thunky')
var myIp
var callbacks = []
var running

module.exports = thunky(function externalIp(cb) {
  tryUpnp(function(err, ip) {
    if (ip) return cb(null, ip)
    else tryIpify(cb)
  })
})

function tryUpnp(cb) {
  if (!(upnp && upnp.createClient)) return cb(new Error('can\'t do upnp'))

  var client = upnp.createClient()
  try {
    client.externalIp(function(err, ip) {
      client.close()
      cb(err, ip)
    })
  } catch (err) {
    cb(err, ip)
  }
}

function tryIpify(cb) {
  get.concat('http://api.ipify.org?format=json', function(err, body, resp) {
    if (err) return cb(err)

    try {
      var ip = JSON.parse(body).ip
      cb(null, ip)
    } catch (err) {
      cb(err)
    }
  })
}
