# zlorp

_This module is used by [Tradle](https://github.com/tradle)_

## What is Zlorp

Zlorp is a P2P comm module, meant more as infrastructure for peer to peer applications than a chat client.

Find peers on the internet via the BitTorrent DHT, knowing only their public keys (or public key fingerprint), and send structured data to each other with OTR messaging.

_inspired by [bluntly](https://github.com/danoctavian/bluntly)_

## Usage

```js
var DSA = require('otr').DSA
var Zlorp = require('zlorp')
var myKey = DSA.parsePrivate('...my private DSA key...')

// DSA key fingerprints, e.g. myKey's fingerprint is myKey.fingerprint()
var billFingerprint = 'c7164fc272efc11ab218175ae9c9112333fb473f' 
var tedFingerprint = '6127a5b679f880a4680479ecff9e770ffe4172ae' 

var me = new Zlorp({
  dht: './dht.json', // where to back up the dht
  keys: {
    // optional (no OTR, just regular encrypt/decrypt)
    ec: require('elliptic').ec('ed25519').genKeyPair() 
    // recommended (OTR)
    dsa: myKey
  },
  port: 12345
})

// names are optional
var bill = me.addPeer({
  identifier: billFingerprint, 
  name: 'Bill S. Preston Esquire'
})

var ted = me.addPeer({
  identifier: tedFingerprint, 
  name: 'Ted Theodore Logan'
})

me.send('excellent!', bill)
// or bill.send('excellent!'), but then it looks like 
// bill is sending the message, which is wrongity wrong
me.send('party on, dude!', ted)
```
