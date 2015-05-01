
var EventEmitter = require('events').EventEmitter
var crypto = require('crypto')
var noop = function() {}

var utils = module.exports = {
  infoHash: function(key) {
    return crypto.createHash('sha1').update(key).digest('hex')
  },

  /**
   * rendezvous infoHash, as in danoctavian/bluntly
   */
  rInfoHash: function(key) {
    return utils.infoHash(key.split('').reverse().join(''))
  },

  toBuffer: function(str) {
    return new Buffer(str, 'binary')
  },

  fromBuffer: function(buf) {
    return buf.toString('binary')
  },

  destroyify: function(obj) {
    obj.prototype.isDestroyed = function() {
      return this._destroyed
    }

    obj.prototype.destroy = function selfDestruct(cb) {
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
      this._destroy(function() {
        if (self instanceof EventEmitter) self.emit('destroy')

        self._destroyCallbacks.forEach(function(cb) {
          cb()
        })
      })

      return this
    }
  }
}
