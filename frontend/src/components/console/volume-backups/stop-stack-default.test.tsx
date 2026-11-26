import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import type { ResourceSpec } from "@/components/console/resource-spec";
import type { ComposeServiceVolumes } from "@/lib/api/endpoints/compose";

import { stopsStackByDefault } from "./stack-volume-picker";
import { volumeBackupsSpec } from "./volume-backups-spec";

afterEach(cleanup);

const noop = async () => undefined;

const POSTGRES: ComposeServiceVolumes[] = [
  { serviceName: "db", image: "postgres:17", volumes: ["wiki_db-data"] },
  { serviceName: "app", image: "outlinewiki/outline:0.80", volumes: ["files"] },
];
const NO_DATABASE: ComposeServiceVolumes[] = [
  { serviceName: "web", image: "nginx:1.27", volumes: ["site"] },
];

/** The add dialog of a stack's Volume backups tab, as the panel builds it
 * on each render: with `services` once `GET /compose/:id/volumes` has
 * answered, and none while it is pending. */
function addDialog(services: ComposeServiceVolumes[] | null) {
  const spec = volumeBackupsSpec({
    serviceId: "cmp-1",
    serviceType: "compose",
    stack: {
      services: services ?? [],
      unavailableReason: null,
      pending: services === null,
    },
    destinations: [],
    destinationsPending: false,
    create: noop,
    update: noop,
    remove: noop,
  }) as unknown as ResourceSpec<unknown, Record<string, unknown>>;
  return (
    <ResourceFormModal spec={spec} row={null} open onOpenChange={() => {}} />
  );
}

const stopSwitch = () =>
  screen.getByRole("switch", { name: "Stop the stack while it runs" });

/**
 * **Stop the stack while it runs** starts on for a stack that runs a
 * database (ADR-0092), and the services it reads arrive after the dialog
 * may already be open: the default follows them until the operator has
 * set the switch.
 */
describe("Stop the stack while it runs, on Add a backup", () => {
  it("turns on when a Postgres service arrives after the dialog opened", () => {
    const { rerender } = render(addDialog(null));
    expect(stopSwitch().getAttribute("aria-checked")).toBe("false");

    rerender(addDialog(POSTGRES));

    expect(stopSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps what the operator set before the services arrived", () => {
    const { rerender } = render(addDialog(null));
    fireEvent.click(stopSwitch());
    expect(stopSwitch().getAttribute("aria-checked")).toBe("true");

    rerender(addDialog(NO_DATABASE));

    expect(stopSwitch().getAttribute("aria-checked")).toBe("true");
  });
});

describe("stopsStackByDefault", () => {
  const runs = (image: string) =>
    stopsStackByDefault({
      services: [{ serviceName: "s", image, volumes: [] }],
      unavailableReason: null,
      pending: false,
    });

  it("matches the database images by name, with any registry prefix and tag", () => {
    for (const image of [
      "postgres",
      "postgres:17-alpine",
      "mysql:8.4",
      "mariadb:11",
      "mongo:7",
      "docker.io/library/postgres:16",
      "registry.example.com:5000/team/mongo:7@sha256:abc",
    ]) {
      expect([image, runs(image)]).toEqual([image, true]);
    }
  });

  it("does not match an image whose name only starts with one", () => {
    for (const image of [
      "mongo-express:1.0",
      "postgres-exporter:0.15",
      "mysqld-exporter",
      "nginx:1.27",
    ]) {
      expect([image, runs(image)]).toEqual([image, false]);
    }
  });
});
