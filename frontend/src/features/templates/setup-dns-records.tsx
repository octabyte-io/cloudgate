import type { CloudPointTarget } from "@/lib/api/endpoints/templates";

/**
 * The DNS record a compose Domain's typed host needs in a Cloud Environment
 * (#1379, ADR-0070 "Domains"): the host pointing at the Environment
 * network's load balancer, as on any cloud Domain. While that network is
 * not made, the setup's Plan makes it, and the record names it. The
 * certificate's validation record exists only once the Domain is added,
 * after the Stack VM is made, so it is named, not shown.
 */
export function SetupDnsRecords({
  host,
  pointsAt,
}: {
  host: string;
  pointsAt: CloudPointTarget | null;
}) {
  const name = host.trim();
  if (name === "") return null;
  return (
    <div className="grid gap-1 text-meta text-tx-3">
      <p>DNS records to make for {name}:</p>
      <p className="font-mono text-tx-2">
        {name} {pointingType(name, pointsAt)}{" "}
        {pointsAt?.dnsName ??
          "the Environment network's load balancer, which this setup's Plan makes"}
      </p>
      <p>
        Its certificate&apos;s validation record is listed on the stack&apos;s
        Domains once its Stack VM is made.
      </p>
    </div>
  );
}

/** A fixed IP takes an A record; a bare name an ALIAS; any other a CNAME. */
function pointingType(host: string, pointsAt: CloudPointTarget | null) {
  if (pointsAt?.kind === "fixed-ip") return "A";
  return isBareName(host) ? "ALIAS" : "CNAME";
}

/** Two-part public suffixes under which a name of three labels is bare. */
const SECOND_LEVELS = new Set(["co", "com", "net", "org", "gov", "ac", "edu"]);

/** A bare (apex) name, as the backend's `isBareName` tells one. */
function isBareName(host: string): boolean {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return true;
  return (
    labels.length === 3 &&
    labels[2].length === 2 &&
    SECOND_LEVELS.has(labels[1])
  );
}
