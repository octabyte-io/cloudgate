# A Server's access log is rotated hourly by a job the instance cannot switch off, and old copies go after 30 days

Decided while planning Requests for every customer Server. A Server's access log (`/etc/cloudgate/traefik/dynamic/access.log`) is on the customer's disk and holds their visitors' IPs and paths. Traefik 3.6.7 never rotates it (it only reopens the file on `USR1`), so Cloudgate has to.

- **Limits stay as shipped:** a new file once the live one passes 100 MiB (`ACCESS_LOG_MAX_BYTES`), 3 older copies kept (`ACCESS_LOG_BACKUPS`). That is about 400 MiB on disk. The Requests page reads only the end of the live file (ADR-0056), so the copies are there for the customer, not for the page.
- **Servers have their own job, hourly, with no off switch.** Server rotation no longer hangs off `logCleanupCron`. That setting and its Maintenance switch belong to the Instance organization, and from now on they cover only the platform host's log. Hourly, so the worst case past 100 MiB is one hour of traffic, not one day.
- **Old copies are deleted after 30 days**, judged by each file's last-changed time (its newest line). The live file is never deleted by age. This holds visitor data to about a month on a quiet Server, which size alone never would.
- **Turning logging off keeps the files.** The hourly job keeps visiting a Server that has logging off but still has copies, until the 30-day rule has cleared them. The turn-off confirmation says so.
- **The customer cannot change any of this.** The Server's Request logging card shows the limits.

**Considered options.**

- **Keep Server rotation on the instance-wide cron.** Rejected. On the Hosted instance one Instance-organization switch, or a slow schedule, would let every customer Server's disk fill. A customer's disk is not a setting the instance owns.
- **Size limit only, no age limit.** Rejected. A quiet Server would keep visitor IPs for years.
- **Delete the files when logging is turned off.** Rejected. It destroys data a customer may want for an incident. The age limit clears them anyway.
- **Per-Server limits the customer sets.** Deferred, not rejected. Nobody has asked yet, and a customer who needs longer history can copy the files off their own Server.

**Consequences.** Every Server with logging on, or with copies left over, costs one SSH size check an hour, from the job that also does rotation and deletion. A Server that cannot be reached at the hour is skipped and checked again at the next one.
