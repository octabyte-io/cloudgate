import type { StackVmPins } from './stack-vm-pins';

/**
 * The network a stack's compose file is joined to, as on a Server
 * (`CLOUDGATE_NETWORK`): the compose program declares it external, so the
 * Stack VM makes it once Docker runs.
 */
const SHARED_NETWORK = 'cloudgate-network';

/** Where Docker keeps named volumes: the data disk is mounted here. */
export const DOCKER_VOLUMES_FOLDER = '/var/lib/docker/volumes';

/**
 * The script that mounts the data disk as Docker's volume folder, the
 * same on every cloud: it waits for the one disk that is neither the boot
 * disk nor already in use (the cloud attaches it once the Stack VM is up),
 * makes a filesystem on it only when it has none, so a replaced Stack VM
 * keeps its volumes, and mounts it by UUID on every boot.
 */
const DATA_DISK_SCRIPT = `#!/bin/bash
set -euo pipefail
root="$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")"
disk=""
for _ in $(seq 1 120); do
  for candidate in $(lsblk -dno NAME,TYPE | awk '$2 == "disk" {print $1}'); do
    if [ "$candidate" != "$root" ] && [ -z "$(lsblk -no MOUNTPOINT "/dev/$candidate" | tr -d '[:space:]')" ]; then
      disk="/dev/$candidate"
      break 2
    fi
  done
  sleep 5
done
if [ -z "$disk" ]; then
  echo "cloudgate: no data disk was attached" >&2
  exit 1
fi
if ! blkid "$disk" >/dev/null 2>&1; then
  mkfs.ext4 -L cloudgate-data "$disk"
fi
uuid="$(blkid -s UUID -o value "$disk")"
mkdir -p ${DOCKER_VOLUMES_FOLDER}
if ! grep -q "$uuid" /etc/fstab; then
  echo "UUID=$uuid ${DOCKER_VOLUMES_FOLDER} ext4 defaults,nofail 0 2" >> /etc/fstab
fi
mount -a
`;

/** A file of a cloud-config `write_files`, indented as YAML wants it. */
function file(path: string, permissions: string, content: string): string {
  const body = content
    .trimEnd()
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return `  - path: ${path}\n    permissions: '${permissions}'\n    content: |\n${body}\n`;
}

/**
 * A Stack VM's first boot, as cloud-config (ADR-0070 "Image and Docker",
 * "Upkeep"), the same on every cloud's Ubuntu 24.04:
 *
 * - the data disk mounted as Docker's volume folder, **before** Docker is
 *   installed, so no volume is ever written to the boot disk;
 * - Docker Engine and the compose plugin from Docker's own apt
 *   repository, at Cloudgate's pins, then held so `apt` never moves them;
 * - Ubuntu's unattended security updates on, with automatic reboot off;
 * - the stack's own SSH key authorized for `root`, which Cloudgate reaches
 *   it with inside the cloud's tunnel (ADR-0070): sshd listens, but the
 *   Stack VM has no public address and its security group lets nothing in
 *   on port 22, so only the tunnel reaches it. `null` before the stack has
 *   a key (a plan read ahead of the Apply that makes it);
 * - the shared network the compose program joins a stack to.
 *
 * Text only: no secret is ever written here, since a cloud shows a VM's
 * user data to anyone who may describe it. A public key is not one.
 */
export function stackVmCloudInit(
  pins: StackVmPins,
  sshPublicKey: string | null,
): string {
  const docker = `docker-ce=${pins.dockerEngine} docker-ce-cli=${pins.dockerEngine}`;
  return [
    '#cloud-config\n',
    ...(sshPublicKey === null
      ? []
      : [
          'disable_root: false\n',
          'users:\n  - default\n',
          `  - name: root\n    ssh_authorized_keys:\n      - ${sshPublicKey}\n`,
        ]),
    'package_update: true\n',
    'packages:\n  - ca-certificates\n  - curl\n  - unattended-upgrades\n',
    'write_files:\n',
    file('/usr/local/sbin/cloudgate-data-disk', '0755', DATA_DISK_SCRIPT),
    file(
      '/etc/apt/apt.conf.d/20auto-upgrades',
      '0644',
      'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";',
    ),
    file(
      '/etc/apt/apt.conf.d/52cloudgate-unattended-upgrades',
      '0644',
      'Unattended-Upgrade::Automatic-Reboot "false";',
    ),
    'runcmd:\n',
    '  - /usr/local/sbin/cloudgate-data-disk\n',
    '  - install -m 0755 -d /etc/apt/keyrings\n',
    '  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc\n',
    '  - chmod a+r /etc/apt/keyrings/docker.asc\n',
    `  - echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list\n`,
    '  - apt-get update\n',
    `  - DEBIAN_FRONTEND=noninteractive apt-get install -y ${docker} containerd.io docker-compose-plugin=${pins.composePlugin}\n`,
    '  - apt-mark hold docker-ce docker-ce-cli docker-compose-plugin\n',
    '  - systemctl enable --now docker\n',
    `  - docker network inspect ${SHARED_NETWORK} >/dev/null 2>&1 || docker network create ${SHARED_NETWORK}\n`,
  ].join('');
}
