// var upnp = require('nat-upnp')
var get = require('simple-get')
var thunky = require('thunky')

module.exports = thunky(function externalIp (cb) {
  // tryUpnp(function (err, ip) {
  //   if (err || !ip) tryIpify(cb)
  //   else cb(null, ip)
  // })
  tryIpify(cb)
})

// function tryUpnp (cb) {
//   if (!(upnp && upnp.createClient)) return cb(new Error("can't do upnp"))

//   var client = upnp.createClient()
//   try {
//     client.externalIp(function (err, ip) {
//       client.close()
//       cb(err, ip)
//     })
//   } catch (err) {
//     cb(err)
//   }
// }

function tryIpify (cb) {
  get.concat('http://api.ipify.org?format=json', function (err, body, resp) {
    if (err) return cb(err)

    try {
      var ip = JSON.parse(body).ip
      cb(null, ip)
    } catch (err) {
      cb(err)
    }
  })
}
