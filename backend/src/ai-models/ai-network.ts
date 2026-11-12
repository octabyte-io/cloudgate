/**
 * The overlay every AI model on a machine sits on, and the only one.
 *
 * An AI model is never on `cloudgate-network`, where every other Service's
 * container could reach its runtime by name around the gateway. Traefik joins
 * this overlay so the gateway's hop through the machine's Traefik can reach
 * the runtime. Not `--internal`: the runtime keeps outbound access to pull
 * its model.
 *
 * A leaf of constants and string builders, like `servers/server-setup.ts`,
 * which uses it.
 */
export const CLOUDGATE_AI_NETWORK = 'cloudgate-ai';

const TRAEFIK_CONTAINER = 'cloudgate-traefik';

/**
 * Creates the overlay when it is missing and joins Traefik to it when it is
 * not joined, so it is idempotent; `docker` is the word that runs Docker
 * (`$SUDO_CMD docker` in Server setup). Traefik is connected, never
 * recreated: a running Traefik is never rolled for this.
 *
 * `docker network inspect` for the network and Traefik's own network list
 * for the join, for `setupNetwork`'s reason: an exact name, not a
 * substring of a listing.
 */
export const joinAiNetworkProgram = (docker = 'docker') => `
  if ${docker} network inspect ${CLOUDGATE_AI_NETWORK} >/dev/null 2>&1; then
    echo "Network ${CLOUDGATE_AI_NETWORK} already exists ✅"
  else
    ${docker} network create --driver overlay --attachable ${CLOUDGATE_AI_NETWORK} >/dev/null || {
      echo "Failed to create ${CLOUDGATE_AI_NETWORK} ❌" >&2
      exit 1
    }
    echo "Network ${CLOUDGATE_AI_NETWORK} created ✅"
  fi
  if ${docker} inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' ${TRAEFIK_CONTAINER} | tr ' ' '\\n' | grep -qx ${CLOUDGATE_AI_NETWORK}; then
    echo "Traefik already on ${CLOUDGATE_AI_NETWORK} ✅"
  else
    ${docker} network connect ${CLOUDGATE_AI_NETWORK} ${TRAEFIK_CONTAINER} || {
      echo "Failed to join Traefik to ${CLOUDGATE_AI_NETWORK} ❌" >&2
      exit 1
    }
    echo "Traefik joined ${CLOUDGATE_AI_NETWORK} ✅"
  fi
`;
