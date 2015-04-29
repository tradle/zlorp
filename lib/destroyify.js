
var EventEmitter = require('events').EventEmitter
var noop = function() {}

module.exports = function(obj) {
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
