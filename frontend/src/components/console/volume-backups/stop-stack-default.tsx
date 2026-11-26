import { useEffect, useRef } from "react";
import { useFormContext } from "react-hook-form";

import {
  stopsStackByDefault,
  type StackVolumesChoice,
} from "./stack-volume-picker";
import type { VolumeBackupValues } from "./volume-backups-spec";

/**
 * Keeps **Stop the stack while it runs** on its database default as the
 * stack's services arrive, until the operator sets it. Renders nothing.
 *
 * The dialog's defaults are read once, when it opens (`useApiForm`), and
 * Add a backup can open before `GET /compose/:id/volumes` answers, which
 * left the switch off on a Postgres stack. So the default is applied again
 * each time it changes — but only while the switch still holds the last
 * default applied: a value that differs from it is the operator's, and a
 * later arrival leaves it alone.
 */
export function StopStackDefault({ stack }: { stack: StackVolumesChoice }) {
  const { getValues, setValue } = useFormContext<VolumeBackupValues>();
  const applied = useRef<boolean | null>(null);
  const next = stopsStackByDefault(stack);

  useEffect(() => {
    const current = getValues("stopStack") ?? false;
    if (applied.current !== null && current !== applied.current) return;
    if (current !== next) setValue("stopStack", next);
    applied.current = next;
  }, [next, getValues, setValue]);

  return null;
}
