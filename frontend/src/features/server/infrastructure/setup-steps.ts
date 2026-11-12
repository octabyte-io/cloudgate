/**
 * `serverSetupCommand()`, step by step — and in its own numbering.
 *
 * Read in order from the script rather than summarised from it, and the numbering
 * is load-bearing: the script echoes `1. Installing required packages` …
 * `6. Setting up Traefik` as it goes, so the numbers in this list and the numbers
 * in the log are the same six numbers. Somebody watching `4.` scroll past can look
 * up and read what step four is.
 */
export const STEPS = [
  {
    title: "Install the packages it needs",
    detail:
      "unzip, curl, wget, git, jq and openssl, through apt-get — and only when one of the six is missing, so a re-run touches neither the apt index nor the packages. On anything that is not Debian, Ubuntu or Raspbian this step is skipped and says so.",
  },
  {
    title: "Install Docker 28.5.0",
    detail:
      "Only if docker is not already on the machine. It pipes get.docker.com into sh, and stops the whole run if docker is still missing afterwards.",
  },
  {
    title: "Initialise a Swarm",
    detail:
      "docker swarm init, advertising the machine's first address from hostname -I. Skipped if the host is already in a Swarm.",
  },
  {
    title: "Create the cloudgate-network overlay",
    detail:
      "An attachable overlay network. Every service Cloudgate deploys joins it, and it is how Traefik reaches them.",
  },
  {
    title: "Create /etc/cloudgate",
    detail:
      "With a traefik/dynamic directory inside it, owned by the SSH user. Build logs, cloned code and Traefik's per-service configuration live here.",
  },
  {
    title: "Write Traefik's config and start it",
    detail:
      "traefik.yml first — providers, entry points, the letsencrypt certificate resolver and request metrics on a loopback-only entry point, with no access log — then a dynamic middlewares.yml defining redirect-to-https, then a container named cloudgate-traefik, restart always, publishing 80, 443 and 443/udp, with the Docker socket mounted so it can watch for new services. No version here on purpose: it is whatever TRAEFIK_VERSION this Cloudgate pins, and the settings path that later recreates the same container reads the same constant.",
  },
];
