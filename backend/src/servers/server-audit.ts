import { REMOTE_CLOUDGATE_DIRECTORY } from '../common/config/cloudgate-directory';

/**
 * Docker/Swarm readiness probe: Docker, Swarm, the overlay network, the
 * platform directory, and the account's privilege mode and docker-group
 * membership. Build and backup tooling (rclone/nixpacks/buildpacks/railpack)
 * is not probed.
 * The script prints a single JSON object on stdout that serverAuditCommand's
 * caller parses into ServerAuditResult.
 */

export interface ServerAuditResult {
  docker: { version: string; enabled: boolean };
  isSwarmActive: boolean;
  isNetworkInstalled: boolean;
  isMainDirectoryInstalled: boolean;
  privilegeMode: string;
  isDockerGroupMember: boolean;
}

export const CLOUDGATE_NETWORK = 'cloudgate-network';

const validateDocker = () => `
  if command_exists docker; then
     echo "$(docker --version | awk '{print $3}' | sed 's/,//') true"
  else
    echo "0.0.0 false"
  fi
`;

const validateSwarm = () => `
  if docker info --format '{{.Swarm.LocalNodeState}}' | grep -q 'active'; then
    echo true
  else
    echo false
  fi
`;

// The same exact-name guard `setupNetwork` uses, and for the same reason:
// `docker network ls | grep -q` matches `cloudgate-network-old`, and a container
// name in another column of the listing. Here it would make the console report
// "cloudgate-network is present" about a host that does not have it — which is
// the reading an operator would use to rule the network *out* as the cause of
// every routed app 502ing.
const validateNetwork = () => `
  if docker network inspect ${CLOUDGATE_NETWORK} >/dev/null 2>&1; then
    echo true
  else
    echo false
  fi
`;

// The directory serverSetupCommand creates on the Server, not this instance's
// own CLOUDGATE_DIRECTORY: the probe runs over SSH, on that host.
const validateMainDirectory = () => `
  if [ -d "${REMOTE_CLOUDGATE_DIRECTORY}" ]; then
    echo true
  else
    echo false
  fi
`;

const validateSudoAccess = () => `
  if [ "$(id -u)" -eq 0 ]; then
    echo "root true"
  elif sudo -n true 2>/dev/null; then
    echo "sudo true"
  else
    echo "none false"
  fi
`;

const validateDockerGroup = () => `
  if groups | grep -qw docker; then
    echo true
  else
    echo false
  fi
`;

/** The full readiness script; its stdout is one JSON ServerAuditResult. */
export const serverAuditCommand = () => `
  command_exists() {
    command -v "$@" > /dev/null 2>&1
  }

  dockerVersionEnabled=$(${validateDocker()})
  dockerVersion=$(echo $dockerVersionEnabled | awk '{print $1}')
  dockerEnabled=$(echo $dockerVersionEnabled | awk '{print $2}')

  isSwarmActive=$(${validateSwarm()})
  isNetworkInstalled=$(${validateNetwork()})
  isMainDirectoryInstalled=$(${validateMainDirectory()})

  sudoAccessResult=$(${validateSudoAccess()})
  privilegeMode=$(echo $sudoAccessResult | awk '{print $1}')
  isDockerGroupMember=$(${validateDockerGroup()})

  echo "{\\"docker\\": {\\"version\\": \\"$dockerVersion\\", \\"enabled\\": $dockerEnabled}, \\"isSwarmActive\\": $isSwarmActive, \\"isNetworkInstalled\\": $isNetworkInstalled, \\"isMainDirectoryInstalled\\": $isMainDirectoryInstalled, \\"privilegeMode\\": \\"$privilegeMode\\", \\"isDockerGroupMember\\": $isDockerGroupMember}"
`;
