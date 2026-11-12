import { Card } from "@/components/console/card";

/**
 * The reference's aside on the Projects screen (e-console.html:3374-3382).
 *
 * It is kept because the hierarchy is the one thing about this product that has
 * to be understood before anything else on the screen makes sense — the rail
 * *is* the hierarchy, and this is the only place it is written down.
 *
 * Two of the reference's four lines are edited to match what exists. Its
 * Organization line claims cloud accounts, which have no backend at all, and its
 * Environment line says runtime and deploy target are decided there — the column
 * the prototype itself marked as proposed (`00-INDEX.md`, and `nav.ts` dropped
 * the Runtime tab for the same reason).
 *
 * **Shown only while the Organization has no Project**. Once there is
 * one, the rail is the hierarchy, and this card was a permanent paragraph
 * beside the list. Its closing line about the rail went at the same time: it
 * described how the shell works, and the rail shows that.
 */
export function HierarchyCard() {
  return (
    <Card>
      <Card.Header title="The hierarchy" headingLevel={2} />
      <Card.Body>
        <ul className="flex list-disc flex-col gap-2 pl-4.5 text-ui text-tx-2 marker:text-tx-4">
          <li>
            <strong className="font-medium text-tx">Organization</strong> owns
            the Servers, the members and the Tags.
          </li>
          <li>
            <strong className="font-medium text-tx">Project</strong> groups the
            things that ship together.
          </li>
          <li>
            <strong className="font-medium text-tx">Environment</strong> is a
            copy of those things — production, staging — with its own variables.
          </li>
          <li>
            <strong className="font-medium text-tx">Services</strong> are the
            Applications, databases and Compose stacks inside an Environment.
          </li>
        </ul>
      </Card.Body>
    </Card>
  );
}
