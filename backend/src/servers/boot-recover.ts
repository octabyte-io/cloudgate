import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * cloudgate-boot-recover on a Server (#105): after every start of Docker, it
 * starts the containers Docker could not start because the swarm had not
 * brought `cloudgate-network` up yet. Without it, a rebooted Server came back
 * with Traefik and every Compose container on that network `Exited`.
 * `deploy/boot-recover.sh` says what it starts and why only those.
 *
 * The script and its unit are the platform host's own files, which
 * `deploy/install.sh` installs there: read from `deploy/`, three folders
 * above both `src/servers/` and `dist/servers/` (the release tarball ships
 * `deploy/` beside `backend/`, ADR-0082), so a Server and the platform host
 * run the same bytes. Read when the setup script is built, never at import.
 */
export const BOOT_RECOVER_SCRIPT = '/usr/local/sbin/cloudgate-boot-recover';
export const BOOT_RECOVER_UNIT = 'cloudgate-boot-recover.service';

const DEPLOY_DIRECTORY = resolve(__dirname, '..', '..', '..', 'deploy');

/** `deploy/`'s script and unit, as text. */
export function bootRecoverFiles(): { script: string; unit: string } {
  return {
    script: readFileSync(resolve(DEPLOY_DIRECTORY, 'boot-recover.sh'), 'utf8'),
    unit: readFileSync(
      resolve(DEPLOY_DIRECTORY, 'systemd', BOOT_RECOVER_UNIT),
      'utf8',
    ),
  };
}

/** Quoted heredoc delimiters: neither file may hold a line that is one. */
export const SCRIPT_DELIMITER = 'CLOUDGATE_BOOT_RECOVER_SCRIPT';
export const UNIT_DELIMITER = 'CLOUDGATE_BOOT_RECOVER_UNIT';

/**
 * Installs both files and enables the unit, as Server setup's other steps
 * go: a file already as this Cloudgate ships it is left alone and says so,
 * and systemd is reloaded only when a file changed, so a re-run of setup
 * changes nothing. Enabled, not started: it runs with the next start of
 * Docker. A Server without systemd skips it and says so.
 */
export const bootRecoverProgram = (sudo = '$SUDO_CMD') => {
  const { script, unit } = bootRecoverFiles();
  for (const [delimiter, body] of [
    [SCRIPT_DELIMITER, script],
    [UNIT_DELIMITER, unit],
  ]) {
    if (body.split('\n').includes(delimiter)) {
      throw new Error(`a line of the boot recovery files is ${delimiter}`);
    }
  }
  return `
  if [ -d /run/systemd/system ]; then
    BOOT_RECOVER_STAGE=$(mktemp -d)
    cat > "$BOOT_RECOVER_STAGE/script" <<'${SCRIPT_DELIMITER}'
${script.replace(/\n$/, '')}
${SCRIPT_DELIMITER}
    cat > "$BOOT_RECOVER_STAGE/unit" <<'${UNIT_DELIMITER}'
${unit.replace(/\n$/, '')}
${UNIT_DELIMITER}
    BOOT_RECOVER_CHANGED=""
    if ! ${sudo} cmp -s "$BOOT_RECOVER_STAGE/script" ${BOOT_RECOVER_SCRIPT}; then
      ${sudo} install -m 0755 -o root -g root "$BOOT_RECOVER_STAGE/script" ${BOOT_RECOVER_SCRIPT}
      BOOT_RECOVER_CHANGED=1
    fi
    if ! ${sudo} cmp -s "$BOOT_RECOVER_STAGE/unit" /etc/systemd/system/${BOOT_RECOVER_UNIT}; then
      ${sudo} install -m 0644 -o root -g root "$BOOT_RECOVER_STAGE/unit" /etc/systemd/system/${BOOT_RECOVER_UNIT}
      BOOT_RECOVER_CHANGED=1
    fi
    rm -rf "$BOOT_RECOVER_STAGE"
    if [ -n "$BOOT_RECOVER_CHANGED" ]; then
      ${sudo} systemctl daemon-reload
    fi
    ${sudo} systemctl enable --quiet ${BOOT_RECOVER_UNIT}
    if [ -n "$BOOT_RECOVER_CHANGED" ]; then
      echo "Boot recovery installed: ${BOOT_RECOVER_UNIT} starts what Docker could not after each start of Docker ✅"
    else
      echo "Boot recovery already installed ✅"
    fi
  else
    echo "No systemd on this Server, so boot recovery is skipped: after a reboot, start Traefik with docker start cloudgate-traefik."
  fi
`;
};
