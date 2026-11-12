# A Server's host key is trusted on first use and forgotten only by an operator

Status: accepted. Builds on [ADR-0005](0005-domain-exceptions.md) and [ADR-0070](0070-a-compose-stack-in-a-cloud-account-runs-on-its-own-stack-vm-made-by-opentofu-and-reached-through-the-clouds-tunnel.md). Issue #1405.

Every SSH connection Cloudgate made to a Server used `ssh2` with no `hostVerifier`, which accepts any host key. Whoever could sit between the backend and a Server saw every command, the variables in its environment (registry and storage credentials, a Service's secrets), and could answer as the Server. The private key never left, but nothing it signed was worth anything once the far end was not checked.

## Decision

- **Trust on first use, as OpenSSH's `known_hosts` does it.** A Server has a nullable `host_key_fingerprint`. A connect to a Server with none records the fingerprint it presents and goes on. A connect to a Server with one goes on only if they match; otherwise it is refused before authentication, so no command runs and no credential is sent.
- **The fingerprint is OpenSSH's own form**, `SHA256:` and the unpadded base64 of the SHA-256 of the raw host key, so an operator can compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the Server. It is not a secret and the Server's API answers it as is ([ADR-0019](0019-a-response-replaces-a-secret-with-its-presence.md) does not apply: there is nothing to replace with a presence).
- **A refusal is a 409 with `code: SERVER_HOST_KEY_CHANGED`** (ADR-0005), naming the Server and both fingerprints, and saying what to do if the Server was reinstalled. It is not a transport failure: the Server answered, and it was the wrong one, so it never reads as "could not be reached".
- **Forgetting a host key is an operator's deliberate act.** `POST /servers/:id/forget-host-key` clears the column, and the next connect records again. It is `server: ['create']`, as every other change to the Server row is, and org-scoped by the Server's own lookup. Changing a Server's address or port clears it too: that is the operator saying it is a different machine. Nothing else clears it, and nothing accepts a new key automatically.
- **One place decides.** `backend/src/remote/host-key.ts` makes the check; the connection provider attaches it to every `ServerConnection` (the field is required, so nothing produces a connection without saying how its key is checked); each SSH client builds its config with `sshConnectConfig` and reads a refusal with `sshFailure`. No client holds logic about keys.
- **The first-use write is conditional** (`… where host_key_fingerprint is null`) and re-reads afterwards. Two first connects that see the same key both succeed; if they see different keys, the one that loses the race is refused. A first-use write that fails refuses the connection rather than connecting unrecorded.

## Consequences

- **Two connections are not checked here, on purpose.** A Stack VM is reached only through its cloud's tunnel to one instance id (ADR-0070), which is what authenticates the endpoint, and it has no Server row to record on. The platform host's own terminal dials from the backend's container to the Docker host it runs on and has no Server row either. Both take `unverifiedHostKey()` with the reason at the call site. If either ever dials across a network that is not already authenticated, it needs a stored fingerprint of its own.
- **A dockerode request refused for its host key reports `ssh2`'s own words** (`Host denied (verification failed)`), because dockerode gives no hook to swap the error. It is refused all the same; the other clients and every console path report the 409.
- **Every existing Server records its key on its first connect after the upgrade.** That first connect is as trusting as before; every one after it is not. An operator who wants to be sure compares the fingerprint the Access tab shows with `ssh-keygen -lf` on the Server.
- **A Server reinstalled with new host keys stops connecting** until an operator presses Forget host key. That is the point, and the refusal says so.
