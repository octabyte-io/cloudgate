# A template folder may spell its YAML files .yaml or .yml, but not both

Status: accepted. Amends [ADR-0072](0072-the-template-catalogue-is-one-zip-of-template-folders-and-a-zip-holding-anything-else-is-refused-whole.md).

ADR-0072 fixes the names at a template folder's root: `template.yaml`, `cloudgate.yaml`, `docker-compose.yml`, and (ADR-0078) `test-values.yaml`. Any other spelling is refused, so a contributor who writes `docker-compose.yaml`, the name Docker's own docs use, fails the check for a reason that is about spelling, not content. Cloudgate accepts both spellings of `cloudgate.yaml` in a repository (ADR-0089), so the template folder is the odd one out.

## Decision

- **Each of the four files may end in `.yaml` or `.yml`:** `template.yaml`/`template.yml`, `cloudgate.yaml`/`cloudgate.yml`, `docker-compose.yaml`/`docker-compose.yml`, `test-values.yaml`/`test-values.yml`.
- **A folder holding both spellings of one file is refused**, naming both. A template is checked before it ships, and the catalogue already refuses whatever is unclear as a whole; a second copy nobody reads is that kind of mistake. This differs on purpose from a repository, where ADR-0089 uses `.yaml` and says so, because there the operator is fixing their own project and here a reviewer can fix the folder before release.
- **Any other spelling is still refused**, so `docker_compose.yml` or `Template.yaml` is caught as before.

## Consequences

The backend's catalogue check, `cloudgate template check`, `cloudgate template pack` and `cloudgate template try` share the names, so they take both spellings in the same release. An older Cloudgate refuses a catalogue holding a `.yml` spelling it does not know and keeps its last good copy (ADR-0072), so `cg-templates` uses a new spelling only after a Cloudgate release that accepts it.
