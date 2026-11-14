# A re-run of the install recreates Traefik when its version is behind

Status: accepted.

The install started Traefik once and skipped it on every later run, so a Cloudgate version that moved `TRAEFIK_VERSION` wrote the new value into `/etc/default/cloudgate-backend` while the container kept the old image, and the console reported the drift. **A run whose `TRAEFIK_VERSION` differs from the running container's image recreates the container with the same name, network, binds and log cap, and prints that 80 and 443 drop for a few seconds.** A container already at its version is left alone. The product itself still never restarts Traefik on the operator's behalf: running the install is the operator choosing to change the box, which is why this happens there and nowhere else.

Chosen over an opt-in variable, which leaves most boxes on a router missing its security fixes, and over leaving it to a by-hand `docker rm -f`, which nobody does until something breaks.
