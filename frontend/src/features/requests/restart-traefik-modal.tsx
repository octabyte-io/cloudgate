import { Modal } from "@/components/console/modal";
import {
  RESTART_TRAEFIK_DESCRIPTION,
  RESTART_TRAEFIK_DONE,
  RestartTraefikConsequences,
} from "@/components/console/restart-traefik-consequences";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";

import { useReloadTraefik } from "../monitoring/use-monitoring";

/**
 * The confirmation in front of `POST /settings/traefik/reload`.
 *
 * Its own file because both of `LoggingCard`'s states open it: it was put on the
 * on state first, for a switch that had just been turned on, and the off
 * state needs it just as much — removing `accessLog` is a static-config edit
 * too, and Traefik keeps writing the log until it restarts. One dialog rather
 * than a second copy, so the connection-drop warning is worded once. The words
 * themselves are `restart-traefik-consequences`, shared with the Settings →
 * Traefik danger zone.
 */
export function RestartTraefikModal({
  open,
  onOpenChange,
  onRestarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Docker has been asked to restart Traefik: whatever was waiting on it is not. */
  onRestarted?: () => void;
}) {
  const reload = useReloadTraefik();

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Restart Traefik?"
        description={RESTART_TRAEFIK_DESCRIPTION}
      />
      <Modal.Body>
        <RestartTraefikConsequences change="a change to request logging" />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        <Button
          variant="dngr"
          disabled={reload.isPending}
          onClick={() => {
            void reload
              .mutateAsync()
              .then(() => {
                toast.info(RESTART_TRAEFIK_DONE);
                onRestarted?.();
                onOpenChange(false);
              })
              .catch((error: unknown) => toast.error(error));
          }}
        >
          Restart Traefik
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
