# A Compose stack is backed up as one moment: every volume in one run, and restored together

Status: accepted. Spec: Compose stack volume backups (issue #161).

A catalogue app runs as a Compose stack, and its data is spread over several named volumes, typically a database and a files volume, that only restore correctly as a pair. A volume backup covers one volume and one run, so two backups of one app are two runs with their own stops, and a restore of one volume next to an older copy of the other leaves an app whose files and database disagree.

## Decision

- **A Stack backup is one row and one run for the whole stack.** The run stops the stack once (when its switch is on), tars every named volume the stack's services mount in turn under the volume lock of each, uploads them under one timestamped folder, the **backup moment**, and starts the stack again. One run record covers it.
- **Keep newest N counts moments**, never single tarballs, so pruning never leaves half a moment.
- **A restore restores a moment, not a volume.** It removes the stack's containers itself (Remove containers on `docker-compose`, Stop on swarm `stack`), restores each volume of the moment, and starts the stack, recording each step.
- **One-volume backups stay** beside it on the same tab, for a volume that needs another schedule, and restore one volume as before.
- **Stopping is a switch**, on by default when a service runs a database image, because a tar of a database that is writing may not restore.

Rejected: one backup per volume with a button that makes one for each volume on the same schedule. It reuses what exists, but gives no shared moment to restore, prunes each volume separately, and leaves the pairing to the person restoring, which is the mistake this exists to prevent.
