import { useState } from "react";

import { Modal } from "@/components/console/modal";
import type { DatabaseKind } from "@/lib/api/endpoints/databases";
import type { DeployTarget } from "@/lib/api/endpoints/environments";

import { Details } from "./create-database-details";
import { ChooseKind } from "./create-database-steps";

/**
 * Pick an engine, then fill in that engine's own fields.
 *
 * **This flow had no home, and finding one was the last thing standing between
 * these screens and being reachable by clicking.** F08 shipped the
 * Environment's Services tab with no "Add a service" button and said why: a
 * control that adds a row to a list which cannot show rows is a trap — the thing
 * appears to work and the screen says nothing changed. F09 hit the same wall and
 * shipped without a create flow at all.
 *
 * The answer was that **`POST /:kind` returns the new row, so this can go straight
 * to it.** Creating a database ends on that database's own Overview, and F07's rail
 * records it in Recents on the way — so the thing you just made is reachable by
 * clicking, permanently, without the list ever existing.
 *
 * The list exists now and
 * the Services tab shows it, which settles the argument in this flow's favour
 * rather than making it redundant: landing on the new database is still the right
 * ending, and there is now a list to come back to.
 */
export function CreateDatabaseModal({
  environmentId,
  environmentName,
  deployTarget,
  open,
  onOpenChange,
}: {
  environmentId: string;
  environmentName: string;
  /** Where the Environment deploys: a cloud one asks for a Server. */
  deployTarget: DeployTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<DatabaseKind | null>(null);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setKind(null);
        onOpenChange(next);
      }}
      wide
    >
      <Modal.Header
        title="Add a database"
        description={`A managed engine deployed into ${environmentName}.`}
      />

      {kind === null ? (
        <ChooseKind onChoose={setKind} />
      ) : (
        <Details
          // Every engine mounts a fresh form. `useApiForm` reads
          // `defaultValues` once, so going back and picking MySQL after typing
          // into the Postgres form would otherwise keep what was typed — and
          // keep it under fields that mean something different.
          key={kind}
          kind={kind}
          environmentId={environmentId}
          deployTarget={deployTarget}
          onBack={() => setKind(null)}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Modal>
  );
}
