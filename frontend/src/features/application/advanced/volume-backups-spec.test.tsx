import { describe, expect, it } from "vitest";

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
