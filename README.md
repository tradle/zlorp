# zlorp

_This module is used by [Tradle](https://github.com/tradle)_

## What is Zlorp

Zlorp is a P2P comm module, meant more as infrastructure for peer to peer applications than a chat client.

Find peers on the internet via the BitTorrent DHT, knowing only their public keys (or public key fingerprint), and send structured data to each other with OTR messaging.

_inspired by [bluntly](https://github.com/danoctavian/bluntly)_

## [Discovery schemes](./Discovery-Schemes.md)

## Usage

### Basic

```js
var DSA = require('otr').DSA
var Zlorp = require('zlorp')
var myKey = DSA.parsePrivate('...my private DSA key...')

// DSA key fingerprints, e.g. myKey's fingerprint is myKey.fingerprint()
var billFingerprint = 'c7164fc272efc11ab218175ae9c9112333fb473f' 
var tedFingerprint = '6127a5b679f880a4680479ecff9e770ffe4172ae' 

var me = new Zlorp({
  dht: './dht.json', // where to back up the dht
  key: myKey,
  port: 12345
})

// names are optional
me.contact({
  identifier: billFingerprint, 
  name: 'Bill S. Preston Esquire'
})

me.contact({
  identifier: tedFingerprint, 
  name: 'Ted Theodore Logan'
})

me.send('excellent!', tedFingerprint)
me.send('party on, dude!', billFingerprint)
```

### Strangers

Because of the way discovery in the BitTorrent DHT works, you may learn information about another party in pieces, especially if you're being approached by strangers. Below is an example of how to handle the two stages of being approached by a stranger, with two events triggered by your zlorp instance:

#### 'knock'

You know their ip:port (addr), but not their DSA key public key or fingerprint, or even their DSA fingerprint's infoHash

```js
b.on('knock', function(addr) {
  // we don't know who it is (their infoHash), just their address
  // if you don't want to talk to them, ignore this event
  // if you do:
  b.connect(addr)
})
```

#### 'hello'

You now know everything you can know about the other party without access to their medical records: their ip:port and their DSA public key. You can still bail and not get into their tinted-windowed car.

```js
b.on('hello', function(pubKey, addr) {
  // OTR with this party has passed the AKE successfully
  // you now know their pubKey
  // if you don't want to talk to them 
  //   you can issue b.removePeerWith('pubKey', pubKey)
})
```

#### Ignore Strangers

```js
zlorp.ignoreStrangers()
```

### Playing coy

You can go into a sort of "away" mode. All this really means is that you stop screaming "HEY! LOOK AT ME!" into the DHT

Keep in mind that "presence" information sticks around in the DHT for a while, so it may take time before your unavailability asserts itself

```js
zlorp.unavailable()
```

### Remote example

```bash
node example/remote.js [username] [port]
```

example/remote.js has a couple of keys for Bill and Ted, the most excellent friends, so you can try connecting to someone on another computer. Yes, you can be Ted since you asked nicely.

You run:

```bash
node example/remote.js ted 12345
```

They run:

```bash
node example/remote.js ted 12345
```

When you're connected, you'll feel it
