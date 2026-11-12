/**
 * The note above `accessLog:` in every traefik.yml Cloudgate writes — the one
 * source for it.
 *
 * Three writers put this comment in the same file: `deploy/install.sh`,
 * `serverSetupCommand` and the request-logging toggle
 * (`TraefikFilesService.toggleRequests`). The toggle had its own ten-line
 * version, so turning logging off and on again rewrote a fresh install's
 * traefik.yml 1247 → 880 → 1740 bytes, and an operator comparing it with
 * another host saw two notes for one block. `common/config/` rather than
 * either module, for the reason `container-logs.ts` is here: the provisioning
 * script and a Nest service both need it and neither should import the other.
 *
 * **The installer's four lines are the wording that survived.** They are what
 * every host already has on disk, which is the file an operator compares
 * against; the toggle's longer version explained *why* Traefik cannot rotate
 * its own access log, and that explanation lives on `ACCESS_LOG_MAX_BYTES` and
 * `rotateAccessLog` in `traefik-files.service.ts`, which this note names.
 *
 * `install.sh` is shell and cannot import this, so its copy (and
 * `deploy/traefik/traefik.yml.example`'s) is held to it by
 * `test/servers/server-setup.spec.ts` instead.
 */
const ACCESS_LOG_ROTATION_LINES = [
  'Cloudgate rotates this file; Traefik cannot. Traefik 3.x has no accessLog',
  'rotation settings, so the policy is ACCESS_LOG_MAX_BYTES in',
  'backend/src/settings/traefik-files.service.ts, which renames the file and',
  'sends Traefik SIGUSR1 to make it reopen filePath.',
];

/**
 * The note as `yaml`'s `commentBefore` takes it: the serialiser adds each `#`,
 * so each line carries only the space that follows one.
 */
export const ACCESS_LOG_ROTATION_NOTE = ACCESS_LOG_ROTATION_LINES.map(
  (line) => ` ${line}`,
).join('\n');

/** The same note as literal YAML, for a writer that emits the file as text. */
export const ACCESS_LOG_ROTATION_COMMENT = ACCESS_LOG_ROTATION_LINES.map(
  (line) => `# ${line}`,
).join('\n');
