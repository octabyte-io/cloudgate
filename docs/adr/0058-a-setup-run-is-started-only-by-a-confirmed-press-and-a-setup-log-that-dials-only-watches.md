# A Setup run is started only by a confirmed press, and a setup log that dials only watches

Decided while planning Docked logs. `/listen-server-setup` used to both start a Server's Setup run and stream it: any connection that found no run in flight started one. Every log socket redials on its own after a transport drop, so a drop in a run's last seconds, or a backend restart mid-run, provisioned the host again with nobody pressing anything. A Docked log lives longer and redials more, which made this worse.

- **A connection says whether it starts or watches.** Only the first dial right after the operator confirms *Run setup* on the Setup card may start a run. Every other dial only watches: backoff redials, a Docked log, a page opened later.
- **A start-dial while a run is in flight attaches**, as before. One host still provisions only once at a time.
- **A watch-dial with no run in flight starts nothing.** It closes with its own code, and the client shows the log as ended, with the outcome stored on the Server.
- **No start flag means watch.** A client that does not know about the flag fails safe.

**Considered options.**

- **A separate request starts the run, and the socket only ever watches.** Rejected for now. `POST /servers/:id/setup` waits until the run finishes, so it would have to change to return at once, and the first lines would race the socket's attach. A flag on the existing dial keeps the start and the first watcher together.
- **Fix it only in the browser (a setup log never redials).** Rejected. It leaves the server willing to provision on any connect, so any future client, or a redial path someone adds, brings the bug back.

**Consequences.** The Dock never offers to start setup. Starting stays on the Setup card, behind its confirmation.

**Amended 2026-11-10 (ADR-0071, decided in [#1383](https://github.com/octabyte-io/cloudgate/issues/1383)):** on the Hosted instance, pressing **Buy** on a **Bought Server** is the confirmed press for its first Setup run. The backend starts that run itself once the machine answers, with no dial and no Setup card. If a backend restart cuts that run off, the backend runs it once more by itself: the Buy still stands, and every setup step checks whether it is needed. This is the only Setup run started without a press on the Setup card. A run that really fails, and every later run, starts only from *Run setup* as above.
