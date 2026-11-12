import { useState } from "react";

import type { Destination } from "@/lib/api/endpoints/destinations";

import { useDestinationObjects } from "@/lib/api/use-destinations";
import { useInstanceMode } from "@/lib/api/use-instance-mode";

/**
 * The restore flow's own state: which tarball, which volume, and the two gates
 * between the three steps.
 *
 * A hook rather than lines in the dialog because two of these are *rules* rather
 * than fields — changing destination un-chooses the tarball, since a key is only a
 * key inside the bucket it came from, and the confirmation compares the typed name
 * against the volume rather than against anything stored.
 */
export function useVolumeRestoreFlow({
  destinations,
  suggestedVolume,
  suggestedPrefix,
  serverId = null,
  open,
}: {
  destinations: Destination[];
  suggestedVolume: string;
  suggestedPrefix: string;
  /** The Server the Service runs on — `null` for this Cloudgate host. */
  serverId?: string | null;
  open: boolean;
}) {
  // On the Hosted instance the listing runs rclone from the Service's
  // own Server — the one the restore runs on — and never from Cloudgate's own
  // host, which refuses it. Self-hosted it lists from this host as before.
  const hosted = useInstanceMode().data === "hosted";
  const [step, setStep] = useState<"choose" | "target" | "confirm">("choose");
  const [destinationId, setDestinationId] = useState("");
  const [prefix, setPrefix] = useState(suggestedPrefix);
  const [backupFileName, setBackupFileName] = useState("");
  const [volumeName, setVolumeName] = useState(suggestedVolume);
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const destination = destinations.find(
    (item) => item.destinationId === destinationId,
  );

  // Only asked for once a destination is chosen, and only while the dialog is
  // open: the listing is an rclone round trip to somebody else's S3 endpoint,
  // not a cheap read of our own database.
  const objects = useDestinationObjects({
    destinationId,
    prefix,
    serverId: hosted ? (serverId ?? undefined) : undefined,
    enabled: open,
  });

  return {
    step,
    setStep,
    destinationId,
    /**
     * A key is only a key inside the bucket it came from, so changing destination
     * un-chooses the tarball rather than carrying a plausible-looking key across
     * to a bucket that has no such object.
     */
    chooseDestination: (next: string) => {
      setDestinationId(next);
      setBackupFileName("");
    },
    prefix,
    setPrefix,
    backupFileName,
    setBackupFileName,
    volumeName,
    setVolumeName,
    typed,
    setTyped,
    refusal,
    setRefusal,
    pending,
    setPending,
    destination,
    objects,
    /** The key with its bucket, when the destination is known — all three steps read it. */
    tarball: destination
      ? `${destination.bucket}/${backupFileName}`
      : backupFileName,
    canLeaveChoose: destinationId !== "" && backupFileName !== "",
    canLeaveTarget: volumeName.trim() !== "",
    confirmed: typed.trim() === volumeName.trim(),
  };
}
