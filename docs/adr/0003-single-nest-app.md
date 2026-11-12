# A single NestJS process

Cloudgate runs the web server, deployment queue worker, cron scheduler, and metrics collector as one NestJS application, with the queue, cron and metrics as modules alongside the HTTP API. One process is simpler to build, test, and deploy for the core-first scope; if a workload later needs isolation, a module can be split out behind its own bootstrap without changing module boundaries.
