
var assert = require('assert')
var crypto = require('crypto')
var CURVE = 'ed25519'
var ec = require('elliptic').ec(CURVE)
var CTR = 'aes-256-ctr';
var GCM = 'aes-256-gcm';

function encrypt(text, password) {
  assert(text && password, 'text and password are both required');

  var cipher = crypto.createCipher(CTR, password);
  return updateCipher(cipher, text);
}

function decrypt(text, password) {
  assert(text && password, 'text and password are both required');

  var decipher = crypto.createDecipher(CTR, password);
  return updateDecipher(decipher, text);
}

function updateCipher(cipher, data) {
  if (Buffer.isBuffer(data)) return Buffer.concat([cipher.update(data), cipher.final()]);
  else return cipher.update(data, 'utf8', 'base64') + cipher.final('base64');
}

function updateDecipher(decipher, data) {
  if (Buffer.isBuffer(data)) return Buffer.concat([decipher.update(data), decipher.final()]);
  else return decipher.update(data, 'base64', 'utf8') + decipher.final('utf8');
}

function normalizeMsg(msg) {
  if (!Buffer.isBuffer(msg)) {
    if (typeof msg !== 'string') msg = JSON.stringify(msg)

    msg = new Buffer(msg)
  }

  return msg
}

function toPubKey(pub) {
  pub = typeof pub === 'string' ? ec.keyFromPublic(pub, 'hex') : pub
  return pub.pub || pub
}

function toPrivKey(priv) {
  return typeof priv === 'string' ? ec.keyFromPrivate(priv, 'hex') : priv
}

function sharedKey(pub, priv) {
  pub = toPubKey(pub)
  priv = toPrivKey(priv)
  var key = priv.derive(pub)
  return crypto.createHash('sha256').update(key.toString()).digest()
}

function normalizeArgs(msg, pub, priv) {
  return [
    normalizeMsg(msg),
    sharedKey(pub, priv)
  ]
}

function toInfoHash(key) {
  return crypto.createHash('sha1').update(key).digest('hex')
}

function toRendezvousInfoHash(key) {
  return toInfoHash(key.split('').reverse().join(''))
}

module.exports = {
  ec: ec,
  decrypt: function decryptMsg(msg, pub, priv) {
    return decrypt.apply(null, normalizeArgs.apply(null, arguments))
  },
  encrypt: function encryptMsg(msg, pub, priv) {
    return encrypt.apply(null, normalizeArgs.apply(null, arguments))
  },
  infoHash: toInfoHash,
  rInfoHash: toRendezvousInfoHash
}
