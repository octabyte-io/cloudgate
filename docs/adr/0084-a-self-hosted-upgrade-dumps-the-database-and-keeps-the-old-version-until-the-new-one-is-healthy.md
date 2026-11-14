# A Self-hosted upgrade dumps the database and keeps the old version until the new one is healthy

Status: accepted.

Migrations only go forward, and an upgrade that broke the backend at boot left nothing to go back to: the old version was deleted once both units restarted, whether or not they came up, and no backup was taken (the Hosted updater takes one to B2, ADR-0081). **A run that changes the version dumps the database to `/var/backups/cloudgate/` before the migrations, keeping the last three, and keeps `/opt/cloudgate.previous` until the new version answers its health check; on failure it prints how to restore both by hand.** An operator with a very large database can skip the dump. This amends ADR-0082's "the install does not keep the previous version once both units run the new one": it is kept until they run it healthily. Going back is still by hand, never automatic.

Chosen over a dump alone, which restores the data but leaves the operator to fetch the old version again, and over leaving backups to the docs, which nobody follows before an upgrade that looks routine.
