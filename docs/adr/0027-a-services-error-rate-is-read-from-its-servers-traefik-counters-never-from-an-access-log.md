# A Service's Error rate is read from its Server's Traefik counters, never from an access log

Built in two parts: Enable request metrics, then the collection, the samples and the read.

A Service's **Error rate** is the share of its requests answered 5xx. Every Service reached through a Domain already goes through its Server's Traefik, so the platform can know that rate without asking anything of the app. The PRD said to derive it "from the access log", and there is already a parser for that log (`monitoring/access-log.parser.ts`). **We don't use it.** On every Server, the platform host included, the Error rate is read from **Traefik's Prometheus service counters** (`traefik_service_requests_total`, plus the `le="1.2"` duration bucket for the slow share). The backend reads them over the shell it already holds (`docker exec cloudgate-traefik wget -qO- http://127.0.0.1:8082/metrics`), keeps the deltas per Domain, and sums them per Service. It matches samples exactly on a forward index built from the Domain rows, and never parses a Traefik name (`traefik/config/names.ts`).

**Considered options.**

- **Read each Server's access log.** Rejected on cost and reach. It writes about 800 B to disk per request, and a remote Server's log is never rotated today. The reader would also have to fetch a file that grows with traffic, where the counters are a pull that grows only with the number of series (0.06 s measured). On the platform host it would also make a per-Service read a read of the one file that carries every organization's traffic.
- **Push over OTLP (`metrics.otlp`, `accesslog.otlp`).** Rejected because it opens an inbound path from Server to backend that doesn't exist today, and `accesslog.otlp` is experimental.

**Consequences.**

- **ADR-0013 is untouched.** No per-Service read touches the platform host's access log, so nothing needs "filtering by entitlement". Reading a Service's Error rate is `service: ['read']` plus its entitlement, like any other read of the Service. The instance-authority reader stays the only reader of that log, which is why the platform host keeps its access log and its rotation.
- **The metrics entryPoint binds to loopback, and this is a tenant-isolation requirement.** It is a dedicated `metrics` entryPoint on `127.0.0.1:8082` (`addServicesLabels: true`, `addRoutersLabels: false`). On `:8082`, any tenant container on the Traefik network read every Service's counters (measured). It never goes on the `traefik` entryPoint that "Publish the dashboard" exposes. The three writers (`server-setup.ts`, `install.sh`, `traefik.yml.example`) carry the same block.
- **An existing Server has to be opted in, and never is automatically.** New Servers get the entryPoint at provisioning. An existing Server, and an existing platform host, need the operator's **Enable request metrics**, which writes the block and asks for the Traefik restart behind the existing restart gate. Until then its Services read "not available", never 0 %.
- **New Servers are provisioned with the access log off**, because nothing on a remote Server reads it any more. An operator can still turn it on.
- **Counters reset when Traefik restarts.** The delta reader treats a decrease as a reset, not a negative rate, and it also reads Traefik's `process_start_time_seconds`: when that moves, every series counts from zero, even one that has already grown past its old value. The first read after the backend starts is only a baseline, because its counts cover an unknown stretch.
- **Some Services have no Error rate, and say so:** an Application without a Domain, and every Database. A `stack` Compose was on this list until its Domains were routed through the file provider; each is now one `@file` service, as an Application Domain is.

**What would falsify this.** A per-request fact the counters can't carry, such as a path, a client or a p95 latency in milliseconds. Latency alerting was ruled out of this effort for exactly that reason. Needing one is a new decision about shipping request records, not a reason to point this reader at the access log.
