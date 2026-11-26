import type { RefinementCtx } from "zod";

import type { FieldSpec } from "@/components/console/form-spec";
import type { ComposeServiceVolumes } from "@/lib/api/endpoints/compose";
import type { VolumeBackup } from "@/lib/api/endpoints/volume-backups";

import type { VolumeBackupValues } from "./volume-backups-spec";

/**
 * A Compose stack's one-volume backup, picked as a service and then one of
 * the named volumes it mounts (#163), so nobody has to know Docker's
 * `<stack>_` prefix. The list is `GET /compose/:id/volumes`, the record of
 * the stack's last successful deploy; **Other volume** takes a typed name
 * for one it does not hold — one adopted by hand, or a stack not deployed
 * yet.
 *
 * `volumeBackupsSpec` swaps these in for the Application's one text field.
 */

/** The volume choice that means "typed below". Never a Docker volume name:
 * one starts with a letter or a number. */
export const OTHER_VOLUME = "_other";

/** What the stack's record says, as the spec takes it. */
export type StackVolumesChoice = {
  services: ComposeServiceVolumes[];
  /** Set, with no services, until a deploy has recorded them. */
  unavailableReason: string | null;
  pending: boolean;
};

/**
 * Docker's rule for a volume name, as `VOLUME_NAME_REGEX` in the backend's
 * `volume-backup.dto.ts` holds it: refused here so a typo is said at the
 * field rather than by a 400 after Save.
 */
const VOLUME_NAME_RULE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export const VOLUME_NAME_RULE_MESSAGE =
  "A volume name can only hold letters, numbers, dots, underscores and hyphens, and starts with a letter or a number.";

/** A Stack backup's scope, or one volume (ADR-0092). Absent is one volume,
 * as it is to the API. */
const isWholeStack = (values: VolumeBackupValues) => values.scope === "stack";

/** The images whose volume may not restore from a tar taken while it writes. */
const DATABASE_IMAGES = new Set(["postgres", "mysql", "mariadb", "mongo"]);

/**
 * Whether **Stop the stack while it runs** starts on: when any service runs
 * a `postgres`, `mysql`, `mariadb` or `mongo` image, by the image's own name
 * — the last path segment without its tag or digest, so any registry or
 * namespace prefix matches (`registry:5000/team/postgres:16`) and an image
 * whose name only starts with one (`mongo-express`, `postgres-exporter`)
 * does not. A default only; the switch is never forced.
 */
export function stopsStackByDefault(stack: StackVolumesChoice): boolean {
  return stack.services.some((service) => {
    const last = (service.image ?? "").split("/").pop() ?? "";
    return DATABASE_IMAGES.has(last.split(/[:@]/)[0]);
  });
}

/** The choice between a Stack backup and a backup of one volume. Shown on
 * a new backup only: a backup cannot change what it backs up. */
export function stackScopeField(): FieldSpec<VolumeBackupValues> {
  return {
    kind: "select",
    name: "scope",
    label: "Back up",
    when: (values) => !values.scopeFixed,
    options: [
      { value: "stack", label: "The whole stack" },
      { value: "volume", label: "One volume" },
    ],
    hint: "The whole stack copies every named volume in one run, so its database and its files come from the same moment. One volume runs on its own schedule.",
  };
}

function volumesOf(stack: StackVolumesChoice, serviceName: string | undefined) {
  return (
    stack.services.find((service) => service.serviceName === serviceName)
      ?.volumes ?? []
  );
}

/** The service picker, the volume picker and the Other volume box. */
export function stackVolumeFields(
  stack: StackVolumesChoice,
): FieldSpec<VolumeBackupValues>[] {
  return [
    {
      kind: "select",
      name: "serviceName",
      label: "Service",
      pending: stack.pending,
      placeholder: "Choose a service",
      when: (values) => !isWholeStack(values) && stack.services.length > 0,
      options: stack.services.map((service) => ({
        value: service.serviceName,
        label: service.serviceName,
        detail: service.image ?? undefined,
      })),
      hint: "The service in the stack that mounts the volume. A run that stops the service stops this one.",
    },
    {
      kind: "select",
      name: "volumeName",
      label: "Volume",
      pending: stack.pending,
      placeholder: "Choose a volume",
      when: (values) => !isWholeStack(values),
      options: (values) => [
        ...volumesOf(stack, values.serviceName).map((volume) => ({
          value: volume,
          label: volume,
        })),
        { value: OTHER_VOLUME, label: "Other volume" },
      ],
      hint:
        stack.unavailableReason ??
        "The named volumes this service mounts, by their Docker names. Bind mounts are not listed.",
    },
    {
      kind: "text",
      name: "otherVolume",
      label: "Volume name",
      mono: true,
      when: (values) =>
        !isWholeStack(values) && values.volumeName === OTHER_VOLUME,
      hint: "The Docker volume to tar, by its full name.",
    },
  ];
}

/** The picks a stack's form has to agree on. */
export function checkStackVolume(
  stack: StackVolumesChoice,
  values: VolumeBackupValues,
  ctx: RefinementCtx,
): void {
  if (isWholeStack(values)) return;
  if (values.volumeName.trim() === "") {
    ctx.addIssue({
      code: "custom",
      path: ["volumeName"],
      message: "A backup needs the volume to tar.",
    });
    return;
  }
  if (values.volumeName === OTHER_VOLUME) {
    const typed = values.otherVolume?.trim() ?? "";
    if (typed === "") {
      ctx.addIssue({
        code: "custom",
        path: ["otherVolume"],
        message: "A backup needs the volume to tar.",
      });
    } else if (!VOLUME_NAME_RULE.test(typed)) {
      ctx.addIssue({
        code: "custom",
        path: ["otherVolume"],
        message: VOLUME_NAME_RULE_MESSAGE,
      });
    }
  }
  if (stack.services.length === 0) return;
  if (!values.serviceName) {
    ctx.addIssue({
      code: "custom",
      path: ["serviceName"],
      message: "Choose the service that mounts the volume.",
    });
    return;
  }
  if (
    values.volumeName !== OTHER_VOLUME &&
    !volumesOf(stack, values.serviceName).includes(values.volumeName)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["volumeName"],
      message:
        "Choose one of the volumes this service mounts, or Other volume.",
    });
  }
}

/** A row's picks: a volume the record does not list is an Other volume. */
export function stackVolumeDefaults(
  stack: StackVolumesChoice,
  row: VolumeBackup | null,
): Pick<
  VolumeBackupValues,
  | "scope"
  | "scopeFixed"
  | "stopStack"
  | "serviceName"
  | "volumeName"
  | "otherVolume"
> {
  if (!row) {
    return {
      scope: "stack",
      scopeFixed: false,
      stopStack: stopsStackByDefault(stack),
      serviceName: "",
      volumeName: "",
      otherVolume: "",
    };
  }
  const scope = row.scope ?? "volume";
  const volumeName = row.volumeName ?? "";
  const listed =
    scope === "stack" ||
    volumesOf(stack, row.serviceName ?? undefined).includes(volumeName);
  return {
    scope,
    scopeFixed: true,
    stopStack: row.turnOff,
    serviceName: row.serviceName ?? "",
    volumeName: listed ? volumeName : OTHER_VOLUME,
    otherVolume: listed ? "" : volumeName,
  };
}

/** The Docker volume name the picks come to. */
export function pickedVolumeName(values: VolumeBackupValues): string {
  return values.volumeName === OTHER_VOLUME
    ? (values.otherVolume ?? "").trim()
    : values.volumeName;
}
