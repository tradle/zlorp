# Discovery schemes

Scenario: A wants to talk to B
Goal: learn each other's ip:port
Notation: a & b represent A and B's pubKey infoHashes respectively

##Bluntly (same as implemented in Zlorp)

A | B
-----
announce a | announce b
lookup b, learn B's ip:port | lookup rb (rendezvous hash)
announce rb | find A as peer to rb, learn A's ip:port

Pros:
- maintains online presence info, allows Invisible mode
- faster to connect

Cons:
- network must maintain "presence" announces, 1 per person per refresh rate
     
##Klekl

A | B
-----
announce b | lookup b
lookup a | find A as peer to b, get A's ip:port
... | announce a
find B as peer to a, get B's ip:port | ...

Pros:
- does not flood network with presence info

Cons:
- does not maintain online presence info, thus does not allow Invisible mode
- slower to connect as requires to wait for announce-back to propagate
- Does not work! Step 3, side B is impossible as B doesn't know A's infoHash, only A's ip:port

##Blenkl

_hybrid_

A | B
-----
announce a | announce b
lookup b, learn B's ip:port | lookup b
announce b | find A as peer to b, learn A's ip:port

Pros:
- no rendezvous hash with arbitrary construction (rendezvous hash is your own hash)
- works, unlike Klekl

Cons:
- an announce of an infoHash is ambiguous, you could be announcing your own or someone else's. You also need to know your own IP address, otherwise you'll get yourself as a peer. On the other hand, then you get to talk to yourself, probably way more interesting than talking to B.
