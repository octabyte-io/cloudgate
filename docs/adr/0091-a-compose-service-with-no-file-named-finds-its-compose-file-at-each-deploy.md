# A Compose Service with no file named finds its compose file at each deploy

Status: accepted.

A Compose Service stores the path of its compose file, `./docker-compose.yml` when nobody names one, in the console and in a `compose` entry of `cloudgate.yaml` alike. Docker looks for `compose.yaml`, `compose.yml`, `docker-compose.yaml` and `docker-compose.yml`, in that order, and `docker compose init` writes `compose.yaml`; a repository laid out the way Docker suggests fails its first Cloudgate deploy with "file not found".

## Decision

- **A Compose Service may name no file.** It stores no path, not a filled-in default, and its `cloudgate.yaml` entry has no `file`.
- **Such a Service finds its file at each deploy**, in the clone that deploy made, by Docker's own order: `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`. The deploy log names the file it used, and notes any other of the four that is also there. None of the four refuses the deploy, naming all four.
- **Found at each deploy, not once.** A compose file is code in the repository, read fresh from each deploy's clone, not the Project config, so ADR-0029's one-record rule and ADR-0089's "found once at the move" do not apply. A rename in a commit is picked up by the next deploy.
- **Existing Services keep their saved path.** Every existing row holds `./docker-compose.yml`, and nothing tells a typed one from a defaulted one, so no row is changed; a Service uses the lookup once its file is cleared. A deploy never changes which file it runs without someone changing the Service.
- **A named path always wins**, with no lookup.

Rejected: finding the file once, when the Service is made, and saving it. A rename would then break the next deploy until someone edited the Service.
