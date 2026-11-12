# Linking a database

A Service reaches a `postgres`, a `mysql` or a `redis` by **linking** its Outputs to its own variables in the Project config (ADR-0031). Each value reaches the Service at its deploy and is never saved on it:

```yaml
version: 1
services:
  pg-1:
    kind: postgres
  redis:
    kind: redis
  web:
    kind: web
    source:
      github: acme/shop
    env:
      - DATABASE_URL: pg-1.url
      - DATABASE_CA: pg-1.ca
      - REDIS_URL: redis.url
      - REDIS_CA: redis.ca
```

A `postgres` hands out `url`, `host`, `port`, `user`, `password`, `database` and `ca`; a `mysql` hands out the same list; a `redis` hands out `url`, `host`, `port`, `password` and `ca`. Every Output is a secret.

A `mysql`'s `url` is `mysql://<user>:<password>@<host>:3306/<database>` on every target, with no TLS parameter in it, since each MySQL driver spells that its own way. On a Server its host is the `mysql`'s Service name on the shared network. Its `ca`, like a `postgres`'s, exists only where the target reports a CA bundle, so a Server hands out none.

On AWS a `mysql` is an RDS for MySQL instance, made by a `postgres` on RDS's rules: its host is the instance's endpoint inside the Environment network, port 3306, and its `ca` is RDS's bundle for the region, as a `postgres` there gets. RDS's default parameter group leaves TLS offered but not required, so a client that does not ask for it still connects; pass `ca` and turn TLS on in your driver to have it checked. No `version` runs RDS's default 8.4 minor; `"8.0"` (paid Extended Support on RDS) and any 9.x refuse the plan by name, as does `user: root`, which only a Server takes.

On Google Cloud a `mysql` is a Cloud SQL for MySQL instance, made by a `postgres` on Cloud SQL's rules: Private Service Connect only, no public address. Its `host` is the instance's private DNS name, port 3306, and its `ca` is the instance's own CA.

- **TLS is offered, not required**. A client that does not ask for it still connects, so the `url` above works as it is.
- **To check the certificate, pass `ca`.**
  - With mysql2, pass `ssl: { ca, verifyIdentity: true }`. `ssl: { ca }` alone checks the CA but not the name: it connects even at the bare IP.
  - With the `mysql` client, use `--ssl-mode=VERIFY_IDENTITY --ssl-ca=<the ca, as a file>`, at `host` exactly as given.
- **An existing Cloud SQL for MySQL** is reached as an existing Cloud SQL postgres is: its `host` is its own `<id>.<hash>.<region>.sql.goog.` name, and **it ends in a dot on purpose**. The `mysql` client with `VERIFY_IDENTITY` compares it with the certificate letter for letter, so it fails without the dot. mysql2 ignores the dot either way.
- **Versions:** no `version` runs MySQL 8.4 (`MYSQL_8_4`). `"9.7"` and `"8.0"` refuse the plan by name, as on RDS, and so does a pinned `"8.4.<n>"`, since Cloud SQL has no pinned 8.4 minor. `user: root` refuses too; Cloudgate gives Cloud SQL's own `root` a password of its own.
- **Point-in-time recovery** is on from create. Turning it on or off later restarts the instance once, about 20 s offline, and the plan says so.

```js
import mysql from "mysql2/promise";

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  ssl: { ca: process.env.DATABASE_CA, verifyIdentity: true },
});
```

---

## `ca`: the certificate to trust

On a cloud a postgres and a redis take only TLS connections. Their `url` asks for TLS (`?sslmode=require` on a postgres, the `rediss://` scheme on a redis), and `ca` is the certificate authority your app must trust to check who it is talking to. A `mysql` on RDS or Cloud SQL offers TLS without requiring it, and hands out the same `ca`:

| Deploy target | `ca` |
|---|---|
| AWS (RDS for PostgreSQL or MySQL, ElastiCache) | AWS's public bundle (RDS's for the region) |
| Google Cloud (Cloud SQL for PostgreSQL or MySQL, Memorystore) | the instance's own CA, which Google makes with it |
| A Server | **no `ca`**: a variable linked to it is a plan refusal |

On Google Cloud no public bundle signs the instance, so an app that checks the certificate against the system's trusted roots fails. Pass `ca` to the client.

### node-postgres

```js
import pg from "pg";

const pool = new pg.Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  ssl: { ca: process.env.DATABASE_CA },
});
```

Link each of those variables to its Output (`DATABASE_HOST: pg-1.host`, and so on). Build the pool from the parts rather than from `url`: node-postgres reads `ssl` from the URL's `sslmode` over the `ssl` you pass, so `connectionString` with `ssl: { ca }` drops the `ca`.

### Redis (ioredis)

```js
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL, {
  tls: { ca: process.env.REDIS_CA },
});
```

The `rediss://` URL turns TLS on and carries the password where there is one; `tls: { ca }` is what the client trusts.

### Google Cloud: a redis on Memorystore has no password

A `redis` on Memorystore is made with no password ([ADR-0042](adr/0042-a-redis-on-memorystore-has-no-password-it-is-reached-only-from-its-environments-private-network-over-tls.md)). Its `url` is `rediss://<host>:6379`, with no user or password in it, and its `password` Output has no value: a variable linked to it is left unset, not set empty, and every plan that keeps such a link says so in a note. The code above works unchanged.

What keeps others out is the network. Only the Environment's own private network reaches the instance, and only over TLS. That network is peered with nothing, so nothing outside the Environment can connect.

**Any Service in the same Environment can connect to it**, though, whether it links to the `redis` or not. No password stops it. If a Service must not reach your cache, put it in another Environment.

Cloudgate cannot use Memorystore's token auth: Google offers no permission a custom role can hold to read the token.

### Google Cloud: `servername`

**No `servername` is needed on either**, and the host name check stays on. The live walk checked both from a `web` on Cloud Run:

- **Cloud SQL**: `host` is the instance's private DNS name, `<id>.<region>.sql-psc.goog`. Google records it in the Environment network for the private link, and the instance's certificate carries it. node-postgres with `ssl: { ca }` verifies the certificate and the name as they are.
- **Memorystore**: `host` is the instance's private address, an IP on the private link's subnet. Its certificate carries that IP (and the reader's) as IP names. ioredis with `tls: { ca }` alone verifies it.
  - Do not set `servername` to the IP. Node warns that a TLS server name may not be an IP (RFC 6066) and ignores it.
- **An existing Cloud SQL** works the same way: `host` is the instance's own `<id>.<hash>.<region>.sql.goog.` name, which Cloudgate records in the Environment network for the private address it makes, and the certificate carries it. No `servername` is needed.
  - **The host ends in a dot on purpose. Do not remove it.** Google writes the name that way, and so does the certificate. `psql` and other libpq clients with `sslmode=verify-full` compare the two letter for letter, so they fail without the dot. node-postgres ignores the dot either way.

With node-postgres, `?sslmode=require` in a `url` given as `connectionString` replaces the `ssl: { ca }` you pass. The connection then checks the certificate against the system's roots and fails with `unable to verify the first certificate`. The walk saw exactly that. Build the pool from the parts, as above, or take `sslmode` off the URL first.
