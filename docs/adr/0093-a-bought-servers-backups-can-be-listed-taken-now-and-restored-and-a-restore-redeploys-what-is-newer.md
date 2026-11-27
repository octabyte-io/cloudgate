# A Bought Server's backups can be listed, taken now and restored, and a restore redeploys what is newer

Status: accepted. Amends ADR-0071.

ADR-0071 gave a Bought Server's backups only an on/off switch, so a customer paid for 7 daily copies of the disk that only an Operator in the provider's own console could use. Now the Server's settings list its **Server backups**, take one on demand (**Back up now**), and **Restore** one. Back up now asks the provider for a backup, not a snapshot. It goes into the same 7 slots and pushes out the oldest, so it needs no new price, Stripe line or deletion rule, and ADR-0071 still leaves snapshots out. It has no limit: its confirmation names the backup it will push out, once all 7 slots are full. A Restore rebuilds the machine from that backup, keeping its id, addresses and extra storage. The extra storage is not in the backup, so it is not rolled back. A Restore is confirmed by typing the Server's name, as a Delete is, because it loses everything written since the backup. Before the rebuild, a Restore takes a **safety copy**, a backup of the disk as it is then, so the Restore itself can be undone by restoring that copy. When the chosen backup is the oldest and all 7 slots are full, the safety copy would push it out, so the confirmation says that no safety copy can be taken and the Restore goes ahead without one only if confirmed.

A Restore also rolls back Cloudgate's own work on the machine, so its records would say newer Deployments run there when they don't. So once the machine is back, Cloudgate runs Server setup again and redeploys every Service on it whose current Deployment is newer than the backup. The data stays as it was in the backup, and the code goes back to the current version. Rollback stays the tool for old code.

## Considered Options

- **A snapshot for Back up now.** Rejected: a new per-GB monthly price and line, kept until deleted, for a copy the backup slots already give.
- **Mark the Services changed and leave a Redeploy button for each.** Rejected: until someone clicks it, the console shows a version that is not running.
- **A limit of one Back up now an hour.** Rejected: the confirmation already names what it costs, and the limit would block a fresh copy after a quick fix.
- **No safety copy before a Restore.** Rejected: one slot buys a way back from restoring the wrong day.
- **Warn and do nothing after the Restore.** Rejected: the same false record, with no way to see it.
