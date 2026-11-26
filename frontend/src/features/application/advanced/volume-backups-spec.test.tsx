import { describe, expect, it } from "vitest";

import { OTHER_VOLUME, type StackVolumesChoice } from "./stack-volume-picker";
import { volumeBackupsSpec, weightsVolumeOf } from "./volume-backups-spec";

const noop = async () => undefined;

const values = (volumeName: string) => ({
  name: "Nightly",
  volumeName,
  prefix: "nightly",
  schedule: "0 3 * * *",
  destinationId: "dest-1",
  keepLatestCount: "",
  turnOff: false,
  enabled: true,
});

const specFor = (application: { appName: string; aiModel: unknown }) =>
  volumeBackupsSpec({
    serviceId: "app-1",
    destinations: [],
    destinationsPending: false,
    weightsVolume: weightsVolumeOf(application),
    create: noop,
    update: noop,
    remove: noop,
  });

/**
 * An AI model's weights volume is a cache the API refuses to back up, so the
 * form does not take it either.
 */
describe("volumeBackupsSpec", () => {
  const aiModel = { appName: "llm", aiModel: { runtime: "ollama" } };

  it("refuses an AI model's weights volume at the field", () => {
    const parsed = specFor(aiModel).schema.safeParse(values("llm-weights"));

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["volumeName"],
        message:
          "llm-weights holds this AI model's weights, which are downloaded again rather than backed up.",
      }),
    ]);
  });

  it("takes the AI model's other volumes, and any volume on a plain Application", () => {
    expect(
      specFor(aiModel).schema.safeParse(values("llm-uploads")).success,
    ).toBe(true);
    expect(
      specFor({ appName: "llm", aiModel: null }).schema.safeParse(
        values("llm-weights"),
      ).success,
    ).toBe(true);
  });
});

/**
 * A Compose stack's one-volume backup is picked as a service, then one of
 * the named volumes it mounts, by its Docker name; **Other volume** takes a
 * typed name (#163).
 */
describe("volumeBackupsSpec on a Compose stack", () => {
  const services = [
    { serviceName: "db", image: "postgres:17", volumes: ["n8n-x1_db-data"] },
    {
      serviceName: "n8n",
      image: "n8nio/n8n:1.80",
      volumes: ["n8n-files", "shared"],
    },
  ];
  const stackSpec = (
    stack: {
      services: StackVolumesChoice["services"];
      unavailableReason: string | null;
    },
    created: Record<string, unknown>[] = [],
  ) =>
    volumeBackupsSpec({
      serviceId: "cmp-1",
      serviceType: "compose",
      stack: { ...stack, pending: false },
      destinations: [],
      destinationsPending: false,
      create: async (input) => {
        created.push(input);
      },
      update: noop,
      remove: noop,
    });
  const field = (spec: ReturnType<typeof stackSpec>, name: string) => {
    const found = spec.fields.find((item) => item.name === name);
    if (!found) throw new Error(`no ${name} field`);
    return found;
  };
  const optionsOf = (
    spec: ReturnType<typeof stackSpec>,
    name: string,
    picked: Record<string, unknown>,
  ) => {
    const found = field(spec, name);
    if (found.kind !== "select") throw new Error(`${name} is no select`);
    const options =
      typeof found.options === "function"
        ? found.options({ ...stackValues(), ...picked })
        : found.options;
    return options.map((option) => [option.value, option.label, option.detail]);
  };
  const stackValues = (picked: Record<string, string> = {}) => ({
    ...values(""),
    serviceName: "",
    otherVolume: "",
    ...picked,
  });

  it("offers each service with its image, then the volumes the chosen one mounts and Other volume", () => {
    const spec = stackSpec({ services, unavailableReason: null });

    expect(optionsOf(spec, "serviceName", {})).toEqual([
      ["db", "db", "postgres:17"],
      ["n8n", "n8n", "n8nio/n8n:1.80"],
    ]);
    expect(optionsOf(spec, "volumeName", { serviceName: "n8n" })).toEqual([
      ["n8n-files", "n8n-files", undefined],
      ["shared", "shared", undefined],
      [OTHER_VOLUME, "Other volume", undefined],
    ]);
  });

  it("writes a backup picked from the list with its Docker volume name and its service", async () => {
    const created: Record<string, unknown>[] = [];
    const spec = stackSpec({ services, unavailableReason: null }, created);
    const picked = stackValues({
      serviceName: "db",
      volumeName: "n8n-x1_db-data",
    });

    expect(spec.schema.safeParse(picked).success).toBe(true);
    await spec.create(picked);
    expect(created).toEqual([
      expect.objectContaining({
        serviceType: "compose",
        serviceId: "cmp-1",
        serviceName: "db",
        volumeName: "n8n-x1_db-data",
      }),
    ]);
  });

  it("takes a typed name under Other volume, and refuses one outside the volume name rules", async () => {
    const created: Record<string, unknown>[] = [];
    const spec = stackSpec({ services, unavailableReason: null }, created);
    const typed = (otherVolume: string) =>
      stackValues({
        serviceName: "n8n",
        volumeName: OTHER_VOLUME,
        otherVolume,
      });

    expect(spec.schema.safeParse(typed("adopted.by-hand_1")).success).toBe(
      true,
    );
    await spec.create(typed("adopted.by-hand_1"));
    expect(created[0]).toMatchObject({
      serviceName: "n8n",
      volumeName: "adopted.by-hand_1",
    });

    const refused = spec.schema.safeParse(typed("x$(id)"));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues).toEqual([
      expect.objectContaining({
        path: ["otherVolume"],
        message:
          "A volume name can only hold letters, numbers, dots, underscores and hyphens, and starts with a letter or a number.",
      }),
    ]);
  });

  it("offers the whole stack or one volume, the whole stack first and by default", () => {
    const spec = stackSpec({ services, unavailableReason: null });

    expect(optionsOf(spec, "scope", {})).toEqual([
      ["stack", "The whole stack", undefined],
      ["volume", "One volume", undefined],
    ]);
    expect(spec.toDefaults(null).scope).toBe("stack");
    // The service and volume pickers are one volume's only.
    const picked = { ...stackValues(), scope: "stack" as const };
    expect(field(spec, "serviceName").when?.(picked)).toBe(false);
    expect(field(spec, "volumeName").when?.(picked)).toBe(false);
    expect(field(spec, "stopStack").when?.(picked)).toBe(true);
    expect(field(spec, "turnOff").when?.(picked)).toBe(false);
  });

  it("writes a Stack backup with no volume and no service, stopping the stack as the switch says", async () => {
    const created: Record<string, unknown>[] = [];
    const spec = stackSpec({ services, unavailableReason: null }, created);
    const whole = {
      ...stackValues(),
      scope: "stack" as const,
      stopStack: true,
      turnOff: false,
    };

    expect(spec.schema.safeParse(whole).success).toBe(true);
    await spec.create(whole);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      scope: "stack" as const,
      serviceType: "compose",
      serviceId: "cmp-1",
      turnOff: true,
    });
    expect(created[0]).not.toHaveProperty("volumeName");
    expect(created[0]).not.toHaveProperty("serviceName");
  });

  it("starts Stop the stack while it runs on for a stack with a postgres image, and off for one without", () => {
    const withDatabase = stackSpec({ services, unavailableReason: null });
    const withoutDatabase = stackSpec({
      services: [
        { serviceName: "web", image: "nginx:1.27", volumes: ["site"] },
        { serviceName: "worker", image: null, volumes: [] },
      ],
      unavailableReason: null,
    });

    expect(withDatabase.toDefaults(null).stopStack).toBe(true);
    expect(withoutDatabase.toDefaults(null).stopStack).toBe(false);
  });

  it("says its volumes are read from its first deploy on a stack not deployed yet", () => {
    const reason =
      "This stack hasn’t deployed successfully yet. Its volumes are read from its first deploy.";
    const spec = stackSpec({ services: [], unavailableReason: reason });

    expect(field(spec, "volumeName").hint).toBe(reason);
    expect(field(spec, "serviceName").when?.(stackValues())).toBe(false);
    expect(optionsOf(spec, "volumeName", {})).toEqual([
      [OTHER_VOLUME, "Other volume", undefined],
    ]);
  });
});

/**
 * A Server bucket's files are on one volume of its own, so its form
 * starts on that volume and the backup it writes names the bucket.
 */
describe("volumeBackupsSpec on a bucket", () => {
  it("starts a new backup on the bucket's own volume and writes it for the bucket", async () => {
    const created: Record<string, unknown>[] = [];
    const spec = volumeBackupsSpec({
      serviceId: "bkt-1",
      serviceType: "bucket",
      ownVolume: "bucket-q7k2m9-data",
      destinations: [],
      destinationsPending: false,
      create: async (input) => {
        created.push(input);
      },
      update: noop,
      remove: noop,
    });

    expect(spec.toDefaults(null).volumeName).toBe("bucket-q7k2m9-data");

    await spec.create(values("bucket-q7k2m9-data"));
    expect(created).toEqual([
      expect.objectContaining({
        serviceType: "bucket",
        serviceId: "bkt-1",
        volumeName: "bucket-q7k2m9-data",
      }),
    ]);
  });
});
