var EventEmitter = require('events').EventEmitter
var crypto = require('crypto')
var ENCODING = 'base64'
var DHT_MSG_REGEX = /^d1:.?d2:id20:/
var DHT_ERR_REGEX = /^d1:eli20/
var noop = function () {}

var utils = module.exports = {
  ENCODING: ENCODING,
  infoHash: function (key) {
    return crypto.createHash('sha1').update(key).digest('hex')
  },

  /**
   * rendezvous infoHash, as in danoctavian/bluntly
   */
  rInfoHash: function (key) {
    return utils.infoHash(key.split('').reverse().join(''))
  },

  validateMsgEncoding: function (msg) {
    return validate(msg, ENCODING)
  },

  toBuffer: function (str) {
    if (Buffer.isBuffer(str)) return str

    validate(str, ENCODING)
    return new Buffer(str, ENCODING)
  },

  fromBuffer: function (buf) {
    if (typeof buf === 'string') return buf

    return buf.toString(ENCODING)
  },

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
  },

  isDHTMessage: function (msg) {
    return DHT_MSG_REGEX.test(msg) || DHT_ERR_REGEX.test(msg)
  }
}

function validate (str, enc) {
  if (str !== new Buffer(str, enc).toString(enc)) {
    console.error(str)
    throw new Error('invalid base64 string')
  }
}
