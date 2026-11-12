# An Application's port change moves the Domains that pointed at the old port

An Application's port (the config's `web.port`) and each Domain's port are separate settings: a Domain on a Server routes to its own port, so changing the Application's port left every Domain on the old one, answering 502 until each was edited (#1339). We now move them with it. When an Application on a Server or the platform host changes its port, every Domain of that Application whose port equalled the old port is moved to the new one, and its routing is rewritten in the same request. A Domain on any other port is left alone and named in the answer, so the change never silently leaves a Domain behind.

This does not make a Domain's port the config's (ADR-0029): it stays Cloudgate's setting, and the change only does what a person would have done by hand, the way an Apply already creates a `web`'s Domain on its port. A Domain deliberately on another port is never touched, because nothing says which port should replace it, the same reason an Uptime check is never retargeted.

The port, the moved Domains and their routing are written as one change: the routing file is written before the database transaction commits, so a routing write that fails, a Server out of reach included, refuses the whole edit. This departs from the coding standard's rule that a side effect goes after the commit and does not hold a transaction open, and we accept the cost: the transaction stays open across a routing write that may wait on SSH. One gap remains: if the file is written and the commit then fails, the routing is ahead of the database until the next write of that Application's routing.

## Considered Options

- **Only warn, listing the Domains still on the old port.** Rejected: a Domain that pointed at the old port is broken by the change, so the warning would always be followed by the same edit.
- **Move every Domain of the Application.** Rejected: an Application can serve Domains on several ports, and the ones on another port were chosen.
