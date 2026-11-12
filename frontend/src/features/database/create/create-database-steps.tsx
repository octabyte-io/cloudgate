import { Modal } from "@/components/console/modal";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Stepper } from "@/components/console/stepper";
import type { DatabaseKind } from "@/lib/api/endpoints/databases";

import { DATABASE_DESCRIPTORS } from "../kinds";

export const STEPS = [
  { id: "kind", label: "Choose an engine" },
  { id: "details", label: "Name it and set its credentials" },
] as const;

/**
 * Step one — **the descriptor table, rendered.**
 *
 * Six cards from `DATABASE_DESCRIPTORS`, so this file contains no engine's name.
 * The sentence underneath is the one thing about the choice that cannot be undone:
 * the engine decides the image, the credentials and the port.
 */
export function ChooseKind({
  onChoose,
}: {
  onChoose: (kind: DatabaseKind) => void;
}) {
  return (
    <Modal.Body>
      <Stepper label="Add a database" steps={[...STEPS]} currentId="kind" />
      <div className="flex animate-fade flex-col gap-3.5">
        <PickGrid label="Database engine">
          {DATABASE_DESCRIPTORS.map((descriptor) => (
            <PickCard
              key={descriptor.kind}
              icon={descriptor.icon}
              title={descriptor.label}
              description={descriptor.blurb}
              meta={descriptor.defaultImage}
              onClick={() => onChoose(descriptor.kind)}
            />
          ))}
        </PickGrid>
        <p className="text-meta text-tx-3">
          The engine cannot be changed afterwards — it decides the image, the
          credentials and the port. Everything else on this list can.
        </p>
      </div>
    </Modal.Body>
  );
}
