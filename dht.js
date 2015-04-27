
var DHT = require('bittorrent-dht')

module.exports = function(options) {
  var dht = new DHT(options)
  dht.on('peer', function(addr, infoHash, from) {
    dht.emit('peer:' + infoHash, addr, from)
  })

  return dht
}
