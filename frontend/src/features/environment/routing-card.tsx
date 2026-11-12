import { Card } from "@/components/console/card";

/**
 * How a domain reaches a container (the reference's "How routing works" aside,
 * e-console.html:4071-4076).
 *
 * Kept as the reference has it, minus its claim about *which* server: the
 * reference names the Environment's Deploy target, which now decides
 * only where a new Service is created. Routing happens on each Service's own
 * run Server, so the sentence stops at Traefik.
 */
export function RoutingCard() {
  return (
    <Card>
      <Card.Header title="How routing works" headingLevel={2} />
      <Card.Body>
        <ul className="flex list-disc flex-col gap-2 pl-4.5 text-ui text-tx-2 marker:text-tx-4">
          <li>Traefik runs on the Server a service is deployed to.</li>
          <li>
            A domain becomes a router rule pointing at that service&rsquo;s
            container port.
          </li>
          <li>
            Certificates are issued by Let&rsquo;s Encrypt and renewed
            automatically.
          </li>
        </ul>
      </Card.Body>
    </Card>
  );
}
