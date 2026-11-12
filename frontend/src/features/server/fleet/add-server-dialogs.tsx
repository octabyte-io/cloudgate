import { useState } from "react";

import type { Server } from "@/lib/api/endpoints/servers";
import { ManageKeysModal } from "@/features/ssh-keys/manage-keys-modal";

import { AddServerModal } from "./add-server-modal";

/**
 * Add a Server and the SSH keys dialog, as one flow.
 *
 * **The first-run path goes through both.** Nobody has a key on day one, so the
 * Add dialog's way out is "Manage SSH keys" — and that used to close Add, open
 * the keys, and leave the operator on the list when they pressed Done. Opening
 * Add again mounted a fresh form: the Name and Address they had typed were gone
 * and the key they had just made was not chosen.
 *
 * So a trip to the keys from inside Add is now a round trip. Add is hidden, not
 * unmounted — its form lives in `AddServerModal`, outside the dialog's content,
 * and react-hook-form keeps a field's value while its input is away — and when
 * the keys dialog closes it comes back as it was, with the key made on the way
 * chosen. A key made from the screen's own "SSH keys" button chooses nothing:
 * nobody was adding a Server.
 *
 * `opening` is the screen's count of fresh openings; it remounts the form, which
 * is what a press of "Add a Server" should do (`useApiForm` reads its defaults
 * once). The round trip does not touch it.
 */
export function AddServerDialogs({
  opening,
  adding,
  onAddingChange,
  managingKeys,
  onManagingKeysChange,
  servers,
}: {
  opening: number;
  adding: boolean;
  onAddingChange: (open: boolean) => void;
  managingKeys: boolean;
  onManagingKeysChange: (open: boolean) => void;
  /** For the keys dialog, so a delete can name the Servers it strands. */
  servers: Server[];
}) {
  /** The keys dialog was opened from inside Add, so closing it goes back there. */
  const [returning, setReturning] = useState(false);
  /** A key made on that trip, for Add to choose. */
  const [madeKeyId, setMadeKeyId] = useState<string | null>(null);

  return (
    <>
      <AddServerModal
        key={`add-${opening}`}
        open={adding}
        onOpenChange={(next) => {
          // Closed by the operator, not by the trip to the keys.
          if (!next) setMadeKeyId(null);
          onAddingChange(next);
        }}
        chosenKeyId={madeKeyId}
        onManageKeys={() => {
          setReturning(true);
          onAddingChange(false);
          onManagingKeysChange(true);
        }}
      />
      <ManageKeysModal
        open={managingKeys}
        onOpenChange={(next) => {
          onManagingKeysChange(next);
          if (!next && returning) {
            setReturning(false);
            onAddingChange(true);
          }
        }}
        onCreated={(sshKeyId) => {
          if (returning) setMadeKeyId(sshKeyId);
        }}
        servers={servers}
      />
    </>
  );
}
