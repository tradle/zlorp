var EventEmitter = require('events').EventEmitter
var crypto = require('crypto')
var StringDecoder = require('string_decoder').StringDecoder
var msgEncoding = 'utf8'
var noop = function () {}

var utils = module.exports = {
  infoHash: function (key) {
    return crypto.createHash('sha1').update(key).digest('hex')
  },

  /**
   * rendezvous infoHash, as in danoctavian/bluntly
   */
  rInfoHash: function (key) {
    return utils.infoHash(key.split('').reverse().join(''))
  },

  toBuffer: function (str) {
    return new Buffer(str, msgEncoding)
  },

  fromBuffer: function (buf) {
    return buf.toString(msgEncoding)
  },

  isValidUTF8: function (msg) {
    if (typeof msg === 'string') msg = new Buffer(msg, 'utf8')

    var decoder = new StringDecoder('utf8')
    decoder.write(msg)
    return !decoder.end().length
  },

  // encodeMessage: function (msg) {
  //   var encoded = new Buffer(msg, msgEncoding).toString(msgEncoding)
  //   // maybe it's already encoded
  //   if (encoded === msg) return msg

  //   return new Buffer(msg, unencoded).toString(msgEncoding)
  // },

  destroyify: function (obj) {
    obj.prototype.isDestroyed = function () {
      return this._destroyed
    }

    obj.prototype.destroy = function selfDestruct (cb) {
      var self = this

      cb = cb || noop
      if (this._destroyed) {
        process.nextTick(cb)
        return this
      }

      if (this._destroying) {
        this._destroyCallbacks.push(cb)
        return this
      }

      this._destroying = true
      this._destroyCallbacks = [cb]
      this._destroy(function () {
        if (self instanceof EventEmitter) self.emit('destroy')

        self._destroyCallbacks.forEach(function (cb) {
          cb()
        })
      })

      return this
    }
  }
}
